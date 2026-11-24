//! SPEC §6.8.2 / §6.8.3: the Excel statement a customer receives, kept in sync with the program.
//!
//! Every line of the file has a hidden key and a tracking row (`customer_excel_items`, one per
//! key) that is `pending` until the line is in the file, then `exported`. Money operations queue
//! their line inside their own SQL transaction (so the operation and the queue commit together);
//! a background writer appends the pending lines afterwards. A failed write (file open in Excel,
//! missing, changed layout) leaves the lines pending with the error; nothing is lost, and the
//! file's key column prevents duplicates when a write is retried.

use super::model::{St, V};
use super::statement::{self as stmt, Line, Mark};
use super::{export_failed, file_locked, is_lock_error, keep_previous, save_atomic, validate_xlsx_path};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::ledger::{get_entry, LedgerEntry, LedgerType};
use crate::payouts::{get_payout, Payout, PayoutStatus};
use crate::transactions::{get_dto, Transaction, TxnRow, TxnStatus};
use crate::Core;
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

pub const PROP_CUSTOMER: &str = "PpFeezCustomerId";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Txn,
    Ledger,
    Payout,
    /// A line reversing a deleted item (its source no longer exists).
    Reversal,
}

impl ItemKind {
    fn as_str(self) -> &'static str {
        match self {
            ItemKind::Txn => "txn",
            ItemKind::Ledger => "ledger",
            ItemKind::Payout => "payout",
            ItemKind::Reversal => "reversal",
        }
    }

    fn parse(s: &str) -> ItemKind {
        match s {
            "txn" => ItemKind::Txn,
            "payout" => ItemKind::Payout,
            "reversal" => ItemKind::Reversal,
            _ => ItemKind::Ledger,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExcelStatus {
    Exported,
    Pending,
    NotExported,
}

impl ExcelStatus {
    pub(crate) fn from_db(s: Option<String>) -> ExcelStatus {
        match s.as_deref() {
            Some("exported") => ExcelStatus::Exported,
            Some("pending") => ExcelStatus::Pending,
            _ => ExcelStatus::NotExported,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerExcel {
    pub path: String,
    pub updated_at: Option<String>,
    pub exists: bool,
    pub add_to_excel_by_default: bool,
    pub auto_sync: bool,
    pub exported_count: i64,
    pub pending_count: i64,
    pub not_exported_count: i64,
    pub last_error: Option<AppError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub kind: ItemKind,
    pub id: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub kind: ItemKind,
    pub id: i64,
    pub date: String,
    pub label_ar: String,
    pub currency: String,
    pub amount_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotAllowed {
    pub kind: ItemKind,
    pub id: i64,
    pub reason_ar: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerExcelPreview {
    pub to_add: Vec<PreviewItem>,
    pub duplicates: Vec<PreviewItem>,
    pub not_allowed: Vec<NotAllowed>,
    pub older_than_last_row: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerExcelCreated {
    pub path: String,
    pub added: i64,
    pub sheets: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerExcelAdded {
    pub path: String,
    pub added: i64,
    pub skipped_duplicates: i64,
    pub sheets: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerExcelSent {
    pub path: String,
    pub added: i64,
    pub skipped_duplicates: i64,
    pub still_pending: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnexportedSummary {
    pub customer_id: i64,
    pub customer_name: String,
    pub pending: i64,
    pub not_exported: i64,
    pub last_error: Option<AppError>,
}

/// Payload of the `customer-excel://synced` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
    pub customer_id: i64,
    pub added: i64,
    pub pending: i64,
    pub error: Option<AppError>,
}

// ===== Tracking =====

struct Link {
    path: String,
    auto: bool,
}

fn link_of(conn: &Connection, customer_id: i64) -> AppResult<Option<Link>> {
    Ok(conn
        .query_row(
            "SELECT file_path, auto_sync FROM customer_excel WHERE customer_id = ?1",
            params![customer_id],
            |r| Ok(Link { path: r.get(0)?, auto: r.get::<_, i64>(1)? != 0 }),
        )
        .optional()?)
}

#[derive(Debug, Clone)]
struct Track {
    rowid: i64,
    line_key: String,
    kind: ItemKind,
    item_id: i64,
    source_id: Option<i64>,
    status: String,
    data: Option<Value>,
}

const TRACK_COLS: &str = "rowid, line_key, item_kind, item_id, source_id, status, data";

fn track_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
    Ok(Track {
        rowid: r.get(0)?,
        line_key: r.get(1)?,
        kind: ItemKind::parse(&r.get::<_, String>(2)?),
        item_id: r.get(3)?,
        source_id: r.get(4)?,
        status: r.get(5)?,
        data: r.get::<_, Option<String>>(6)?.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

/// The tracking row of an item in a file (for a transfer: of one approval, by its credit entry).
fn tracked(
    conn: &Connection,
    customer_id: i64,
    path: &str,
    kind: ItemKind,
    item_id: i64,
    source: Option<i64>,
) -> AppResult<Option<Track>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {TRACK_COLS} FROM customer_excel_items WHERE customer_id = ?1 AND file_path = ?2
                   AND item_kind = ?3 AND item_id = ?4 AND (?5 IS NULL OR source_id = ?5 OR source_id IS NULL)
                 ORDER BY (source_id = ?5) DESC, rowid DESC LIMIT 1"
            ),
            params![customer_id, path, kind.as_str(), item_id, source],
            track_from,
        )
        .optional()?)
}

fn status_of_track(t: Option<&Track>) -> ExcelStatus {
    match t.map(|t| t.status.as_str()) {
        Some("exported") => ExcelStatus::Exported,
        Some("pending") => ExcelStatus::Pending,
        _ => ExcelStatus::NotExported,
    }
}

/// The approval credit of a transfer that is not reversed (its current approval).
pub(crate) fn active_credit(conn: &Connection, txn_id: i64) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT c.id FROM ledger_entries c WHERE c.paypal_transaction_id = ?1 AND c.type = 'credit'
               AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = c.id)
             ORDER BY c.id DESC LIMIT 1",
            params![txn_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// (status, in the statement, changed after being added) of a transfer.
pub(crate) fn txn_flags(conn: &Connection, row: &TxnRow) -> AppResult<(ExcelStatus, bool, bool)> {
    // Any exported line of this transfer, in the file currently linked to its customer.
    let exported_for: Option<i64> = conn
        .query_row(
            "SELECT i.customer_id FROM customer_excel_items i JOIN customer_excel c
                 ON c.customer_id = i.customer_id AND c.file_path = i.file_path
             WHERE i.item_kind = 'txn' AND i.item_id = ?1 AND i.status = 'exported' LIMIT 1",
            params![row.id],
            |r| r.get(0),
        )
        .optional()?;
    let approved = row.status == TxnStatus::Approved;
    let status = match (approved, row.customer_id) {
        (true, Some(c)) => match link_of(conn, c)? {
            Some(link) => {
                let credit = active_credit(conn, row.id)?;
                status_of_track(tracked(conn, c, &link.path, ItemKind::Txn, row.id, credit)?.as_ref())
            }
            None => ExcelStatus::NotExported,
        },
        _ => ExcelStatus::NotExported,
    };
    let changed = exported_for.is_some_and(|c| !(approved && row.customer_id == Some(c)));
    Ok((status, status == ExcelStatus::Exported, changed))
}

/// Status of a payout or a ledger entry in its customer's linked statement.
pub(crate) fn item_status(conn: &Connection, customer_id: i64, kind: ItemKind, item_id: i64) -> AppResult<ExcelStatus> {
    Ok(match link_of(conn, customer_id)? {
        Some(link) => status_of_track(tracked(conn, customer_id, &link.path, kind, item_id, None)?.as_ref()),
        None => ExcelStatus::NotExported,
    })
}

// ===== Keys =====

/// Key of a transfer line: the one already tracked for this approval, else `T:{PayPal id}:{credit}`.
/// 0.5.0 wrote `T:{PayPal id}`; it still counts as this line when the transfer was approved once.
fn txn_key(
    conn: &Connection,
    customer_id: i64,
    path: &str,
    t: &Transaction,
    credit: i64,
) -> AppResult<(String, Vec<String>)> {
    if let Some(tr) = tracked(conn, customer_id, path, ItemKind::Txn, t.id, Some(credit))? {
        return Ok((tr.line_key, vec![]));
    }
    let credits: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ledger_entries WHERE paypal_transaction_id = ?1 AND type = 'credit'",
        params![t.id],
        |r| r.get(0),
    )?;
    let alt = if credits <= 1 { vec![format!("T:{}", t.paypal_txn_id)] } else { vec![] };
    Ok((format!("T:{}:{credit}", t.paypal_txn_id), alt))
}

/// What a reversal entry cancels: (key prefix, identifier, legacy key prefix of 0.5.0).
fn reversed_target(conn: &Connection, orig: &LedgerEntry) -> AppResult<(String, &'static str)> {
    if orig.kind == LedgerType::Credit {
        let paypal: String = orig
            .transaction_id
            .and_then(|t| {
                conn.query_row("SELECT paypal_txn_id FROM paypal_transactions WHERE id = ?1", params![t], |r| r.get(0))
                    .ok()
            })
            .unwrap_or_else(|| orig.id.to_string());
        return Ok((format!("-T:{paypal}"), "L"));
    }
    if let Some(p) = orig.payout_id {
        return Ok((format!("-P:{p}"), "X"));
    }
    let prefix = entry_prefix(conn, orig)?;
    Ok((format!("-{prefix}:{}", orig.id), if orig.kind == LedgerType::Payout { "X" } else { "L" }))
}

/// U: payout without transfers, R: refund return, L: other entries.
fn entry_prefix(conn: &Connection, e: &LedgerEntry) -> AppResult<&'static str> {
    let _ = conn;
    if e.kind == LedgerType::Payout {
        return Ok("U");
    }
    if e.kind == LedgerType::Reversal
        && e.reverses_entry_id.is_none()
        && e.amount_minor < 0
        && e.transaction_id.is_some()
    {
        return Ok("R");
    }
    Ok("L")
}

fn entry_key(conn: &Connection, customer_id: i64, path: &str, e: &LedgerEntry) -> AppResult<(String, Vec<String>)> {
    if let Some(tr) = tracked(conn, customer_id, path, ItemKind::Ledger, e.id, None)? {
        return Ok((tr.line_key, vec![]));
    }
    match e.reverses_entry_id {
        Some(orig) => {
            let o = get_entry(conn, orig)?;
            let (target, legacy) = reversed_target(conn, &o)?;
            Ok((format!("{target}:{}", e.id), vec![format!("{legacy}:{}", e.id)]))
        }
        None => Ok((format!("{}:{}", entry_prefix(conn, e)?, e.id), vec![])),
    }
}

// ===== Queue (called inside the money operations' transactions) =====

/// A line to queue: its key, what it shows and the data kept with it.
struct Queued<'a> {
    key: &'a str,
    kind: ItemKind,
    item_id: i64,
    source: Option<i64>,
    currency: &'a str,
    data: Option<&'a Value>,
}

/// Mark a line pending in the customer's linked file (new row, or an existing one again).
fn queue_row(conn: &Connection, now: &str, customer_id: i64, path: &str, q: Queued<'_>) -> AppResult<()> {
    let Queued { key, kind, item_id, source, currency, data } = q;
    conn.execute(
        "INSERT INTO customer_excel_items (customer_id, file_path, line_key, item_kind, item_id, source_id, currency,
           status, added_at, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9)
         ON CONFLICT(customer_id, file_path, line_key) DO UPDATE SET status = 'pending',
           data = COALESCE(excluded.data, customer_excel_items.data)",
        params![customer_id, path, key, kind.as_str(), item_id, source, currency, now, data.map(|d| d.to_string())],
    )?;
    conn.execute("UPDATE customer_excel SET dirty = 1 WHERE customer_id = ?1", params![customer_id])?;
    Ok(())
}

/// Queue the line of a money event when the customer's statement is synced automatically.
pub(crate) fn enqueue(
    conn: &Connection,
    now: &str,
    customer_id: i64,
    kind: ItemKind,
    item_id: i64,
    source: Option<i64>,
    data: Option<Value>,
) -> AppResult<()> {
    let Some(link) = link_of(conn, customer_id)? else { return Ok(()) };
    if !link.auto {
        return Ok(());
    }
    let (key, currency) = match kind {
        ItemKind::Txn => {
            let t = get_dto(conn, item_id)?;
            let credit = source.ok_or_else(|| AppError::internal("transfer line without its credit"))?;
            (txn_key(conn, customer_id, &link.path, &t, credit)?.0, t.currency)
        }
        ItemKind::Payout => {
            let p = get_payout(conn, item_id)?;
            (format!("P:{}", p.id), p.currency)
        }
        ItemKind::Ledger => {
            let e = get_entry(conn, item_id)?;
            (entry_key(conn, customer_id, &link.path, &e)?.0, e.currency)
        }
        ItemKind::Reversal => return Err(AppError::internal("reversal lines are queued on delete")),
    };
    let q = Queued { key: &key, kind, item_id, source, currency: &currency, data: data.as_ref() };
    queue_row(conn, now, customer_id, &link.path, q)
}

/// What a reversal cancels.
pub(crate) enum Orig {
    Txn { txn_id: i64, credit: i64 },
    Payout(i64),
    Entry(i64),
}

/// A reversal of `orig` was written (unapprove, payout cancel, ledger reverse). If `orig` is still
/// pending its line is simply dropped; if it is exported the reversal line is queued.
pub(crate) fn on_reversed(
    conn: &Connection,
    now: &str,
    customer_id: i64,
    orig: Orig,
    reversal_entry: i64,
    data: Option<Value>,
) -> AppResult<()> {
    let Some(link) = link_of(conn, customer_id)? else { return Ok(()) };
    if !link.auto {
        return Ok(());
    }
    let (kind, id, source) = match orig {
        Orig::Txn { txn_id, credit } => (ItemKind::Txn, txn_id, Some(credit)),
        Orig::Payout(p) => (ItemKind::Payout, p, None),
        Orig::Entry(e) => (ItemKind::Ledger, e, None),
    };
    let Some(t) = tracked(conn, customer_id, &link.path, kind, id, source)? else { return Ok(()) };
    if t.status == "pending" {
        conn.execute("DELETE FROM customer_excel_items WHERE rowid = ?1", params![t.rowid])?;
        return Ok(());
    }
    let mut data = data.unwrap_or_else(|| json!({}));
    data["revOf"] = json!(t.line_key);
    if let Some(seq) = t.data.as_ref().and_then(|d| d.get("seq")).cloned() {
        if data.get("seq").is_none() {
            data["seq"] = seq;
        }
    }
    enqueue(conn, now, customer_id, ItemKind::Ledger, reversal_entry, None, Some(data))
}

/// Bring an exported payout's row up to date (details edited).
pub(crate) fn requeue(conn: &Connection, now: &str, customer_id: i64, kind: ItemKind, item_id: i64) -> AppResult<()> {
    let Some(link) = link_of(conn, customer_id)? else { return Ok(()) };
    if !link.auto {
        return Ok(());
    }
    if let Some(t) = tracked(conn, customer_id, &link.path, kind, item_id, None)? {
        conn.execute("UPDATE customer_excel_items SET status = 'pending' WHERE rowid = ?1", params![t.rowid])?;
        conn.execute("UPDATE customer_excel SET dirty = 1 WHERE customer_id = ?1", params![customer_id])?;
        let _ = now;
    }
    Ok(())
}

// ===== Lines =====

fn sent_text(t: &Transaction) -> String {
    match &t.payout {
        Some(p) if p.status == "sent" => format!("نعم — دفعة {}", p.seq),
        Some(p) => format!("مسجلة — دفعة {}", p.seq),
        None => "لا".into(),
    }
}

fn opt_str(s: Option<&str>) -> Option<V> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(|s| V::Str(s.to_string()))
}

fn money(minor: Option<i64>, currency: &str) -> Option<V> {
    minor.map(|m| V::Num(super::to_number(m, currency)))
}

fn num(v: Option<&V>) -> Option<f64> {
    match v {
        Some(V::Num(n)) => Some(*n),
        _ => None,
    }
}

/// What a line said, kept so a later deletion can write the opposite line.
fn snapshot(line: &Line) -> Value {
    let cell = |c: u16| line.cells.iter().find(|x| x.0 == c).and_then(|x| x.1.as_ref());
    json!({
        "label": match cell(stmt::C_LABEL) { Some(V::Str(s)) => s.clone(), _ => String::new() },
        "credit": num(cell(stmt::C_CREDIT)),
        "debit": num(cell(stmt::C_DEBIT)),
        "net": num(cell(stmt::C_NET)),
        "commission": num(cell(stmt::C_COMMISSION)),
        "seq": match cell(stmt::C_SEQ) { Some(V::Num(n)) => json!(*n as i64), _ => Value::Null },
        "currency": line.currency,
        "key": line.key,
    })
}

fn ordered_date(conn: &Connection, entry_id: Option<i64>, fallback: NaiveDate) -> (NaiveDate, i64) {
    entry_id
        .and_then(|id| {
            conn.query_row("SELECT entry_date FROM ledger_entries WHERE id = ?1", params![id], |r| {
                r.get::<_, String>(0)
            })
            .ok()
            .and_then(|d| crate::clock::parse_date(&d))
            .map(|d| (d, id))
        })
        .unwrap_or((fallback, i64::MAX / 2))
}

impl Core {
    fn txn_line(&self, conn: &Connection, t: &Transaction, credit: i64, key: String, alt: Vec<String>) -> Line {
        let cur = t.currency.as_str();
        let date = self.local_dt(&t.occurred_at).map(|d| d.date()).unwrap_or_default();
        let mut label = format!("حوالة من {}", t.payer_name.as_deref().unwrap_or("PayPal"));
        if let Some(n) = t.payer_note.as_deref().filter(|n| !n.trim().is_empty()) {
            label.push_str(" — ");
            label.push_str(n.trim());
        }
        let pct = match t.commission_mode {
            Some(crate::commission::CommissionMode::Fixed) => Some((V::Str("مبلغ ثابت".into()), St::Text)),
            _ => t.commission_bps.map(|b| (V::Num(b as f64 / 10_000.0), St::Pct)),
        };
        let m = St::money(cur, false);
        let mut cells = vec![
            (stmt::C_SEQ, t.customer_seq.map(|s| V::Num(s as f64)), St::Int),
            (stmt::C_DATE, Some(V::Date(date)), St::Date),
            (stmt::C_LABEL, Some(V::Str(label)), St::Text),
            (stmt::C_GROSS, money(Some(t.gross_minor), cur), m),
            (stmt::C_FEE, money(t.fee_minor, cur), m),
            (stmt::C_NET, money(t.net_minor, cur), m),
            (stmt::C_COMMISSION, money(t.commission_minor, cur), m),
            (stmt::C_CREDIT, money(t.customer_amount_minor, cur), m),
            (stmt::C_SENT, Some(V::Str(sent_text(t))), St::Text),
            (stmt::C_REF, Some(V::Str(t.paypal_txn_id.clone())), St::Text),
            (stmt::C_NOTES, opt_str(t.note.as_deref()), St::Text),
            (stmt::C_KEY, Some(V::Str(key.clone())), St::Text),
        ];
        if let Some((v, st)) = pct {
            cells.push((stmt::C_PCT, Some(v), st));
        }
        Line {
            key,
            alt_keys: alt,
            currency: t.currency.clone(),
            date,
            order: ordered_date(conn, Some(credit), date),
            cells,
            fill: false,
            marks: vec![],
        }
    }

    fn payout_line(&self, conn: &Connection, p: &Payout) -> AppResult<Line> {
        let cur = p.currency.as_str();
        let date = crate::clock::parse_date(&p.date).unwrap_or_default();
        let mut label =
            format!("دفعة {} — {}", p.details.method.label_ar(), p.details.platform.as_deref().unwrap_or(""));
        label = label.trim_end_matches([' ', '—']).to_string();
        if !p.range_label.is_empty() {
            label.push(' ');
            label.push_str(&p.range_label);
        }
        let key = format!("P:{}", p.id);
        let status = if p.status == PayoutStatus::Cancelled { "ملغاة" } else { "تم الإرسال" };
        let detail_cells: Vec<(u16, Option<V>)> = vec![
            (stmt::C_SENT, Some(V::Str(status.into()))),
            (stmt::C_METHOD, Some(V::Str(p.details.method.label_ar().into()))),
            (stmt::C_PLATFORM, opt_str(p.details.platform.as_deref())),
            (stmt::C_NETWORK, opt_str(p.details.network.as_deref())),
            (stmt::C_REF, opt_str(p.details.reference.as_deref())),
            (stmt::C_NOTES, opt_str(p.details.note.as_deref())),
        ];
        let mut marks: Vec<Mark> = detail_cells
            .iter()
            .map(|(c, v)| Mark { key: key.clone(), prefix: false, col: *c, value: v.clone().unwrap_or(V::Blank) })
            .collect();
        if p.status == PayoutStatus::Sent {
            for &tid in &p.item_ids.txns {
                if let Ok(t) = get_dto(conn, tid) {
                    marks.push(Mark {
                        key: format!("T:{}", t.paypal_txn_id),
                        prefix: true,
                        col: stmt::C_SENT,
                        value: V::Str(format!("نعم — دفعة {}", p.seq)),
                    });
                }
            }
        }
        let mut cells = vec![
            (stmt::C_SEQ, Some(V::Str(format!("دفعة {}", p.seq))), St::Bold),
            (stmt::C_DATE, Some(V::Date(date)), St::Date),
            (stmt::C_LABEL, Some(V::Str(label)), St::Text),
            (stmt::C_DEBIT, money(Some(p.amount_minor), cur), St::money(cur, false)),
            (stmt::C_KEY, Some(V::Str(key.clone())), St::Text),
        ];
        cells.extend(detail_cells.into_iter().map(|(c, v)| (c, v, St::Text)));
        Ok(Line {
            key,
            alt_keys: vec![],
            currency: p.currency.clone(),
            date,
            order: ordered_date(conn, p.ledger_entry_id, date),
            cells,
            fill: true,
            marks,
        })
    }

    fn entry_line(
        &self,
        conn: &Connection,
        e: &LedgerEntry,
        key: String,
        alt: Vec<String>,
        data: Option<&Value>,
    ) -> AppResult<Line> {
        let cur = e.currency.as_str();
        let date = crate::clock::parse_date(&e.entry_date).unwrap_or_default();
        let m = St::money(cur, false);
        let mut label = e.description.clone();
        let mut cells = vec![
            (stmt::C_DATE, Some(V::Date(date)), St::Date),
            (stmt::C_REF, opt_str(e.reference.as_deref()), St::Text),
        ];
        let mut marks = vec![];
        if let Some(orig) = e.reverses_entry_id.map(|o| get_entry(conn, o)).transpose()? {
            let seq = data.and_then(|d| d.get("seq")).and_then(Value::as_i64);
            if orig.kind == LedgerType::Credit {
                // Unapproved transfer: the reversed net and commission let the header subtract it.
                label = match seq {
                    Some(n) => format!("إلغاء اعتماد الحوالة #{n}"),
                    None => "إلغاء اعتماد حوالة".into(),
                };
                let t = orig.transaction_id.and_then(|t| get_dto(conn, t).ok());
                let amount = -e.amount_minor;
                // Net and commission as they were when the transfer was approved (kept at unapprove).
                let net = data
                    .and_then(|d| d.get("netMinor"))
                    .and_then(Value::as_i64)
                    .or(t.as_ref().and_then(|t| t.net_minor));
                let commission =
                    data.and_then(|d| d.get("commissionMinor")).and_then(Value::as_i64).or(net.map(|n| n - amount));
                cells.push((stmt::C_NET, money(net, cur), m));
                cells.push((stmt::C_COMMISSION, money(commission, cur), m));
                if let Some(n) = seq {
                    cells.push((stmt::C_SEQ, Some(V::Num(n as f64)), St::Int));
                }
                if let Some(t) = t {
                    cells.push((stmt::C_REF, Some(V::Str(t.paypal_txn_id.clone())), St::Text));
                }
            } else if let Some(pid) = orig.payout_id {
                let p = get_payout(conn, pid)?;
                label = format!("إلغاء الدفعة {}", p.seq);
                marks.push(Mark {
                    key: format!("P:{pid}"),
                    prefix: false,
                    col: stmt::C_SENT,
                    value: V::Str("ملغاة".into()),
                });
                for &tid in &p.item_ids.txns {
                    if let Ok(t) = get_dto(conn, tid) {
                        marks.push(Mark {
                            key: format!("T:{}", t.paypal_txn_id),
                            prefix: true,
                            col: stmt::C_SENT,
                            value: V::Str(match &t.payout {
                                Some(np) if np.status == "sent" => format!("نعم — دفعة {}", np.seq),
                                Some(np) => format!("مسجلة — دفعة {}", np.seq),
                                None => "لا".into(),
                            }),
                        });
                    }
                }
            }
        }
        cells.push((stmt::C_LABEL, Some(V::Str(label)), St::Text));
        cells.push((stmt::C_KEY, Some(V::Str(key.clone())), St::Text));
        if e.amount_minor >= 0 {
            cells.push((stmt::C_CREDIT, money(Some(e.amount_minor), cur), m));
        } else {
            cells.push((stmt::C_DEBIT, money(Some(-e.amount_minor), cur), m));
        }
        if let Some(method) = e.payout_method {
            cells.push((stmt::C_METHOD, Some(V::Str(method.label_ar().into())), St::Text));
            cells.push((stmt::C_PLATFORM, opt_str(e.payout_platform.as_deref()), St::Text));
            cells.push((stmt::C_NETWORK, opt_str(e.payout_network.as_deref()), St::Text));
        }
        // Later cells win: keep the first value per column.
        let mut seen = HashSet::new();
        cells.reverse();
        cells.retain(|c| seen.insert(c.0));
        cells.reverse();
        Ok(Line {
            key,
            alt_keys: alt,
            currency: e.currency.clone(),
            date,
            order: (date, e.id),
            cells,
            fill: false,
            marks,
        })
    }

    /// The opposite of a line whose source was deleted (SPEC 4.7 on an exported item).
    fn deletion_line(&self, key: &str, data: &Value) -> Line {
        let cur = data["currency"].as_str().unwrap_or("USD").to_string();
        let today = self.clock.today();
        let m = St::money(&cur, false);
        let f = |k: &str| data.get(k).and_then(Value::as_f64);
        let mut cells = vec![
            (stmt::C_DATE, Some(V::Date(today)), St::Date),
            (stmt::C_LABEL, Some(V::Str(format!("حذف: {}", data["label"].as_str().unwrap_or("")))), St::Text),
            (stmt::C_KEY, Some(V::Str(key.to_string())), St::Text),
        ];
        if let Some(c) = f("credit") {
            cells.push((stmt::C_DEBIT, Some(V::Num(c)), m));
        }
        if let Some(d) = f("debit") {
            cells.push((stmt::C_CREDIT, Some(V::Num(d)), m));
        }
        if key.starts_with("-T:") {
            if let Some(n) = f("net") {
                cells.push((stmt::C_NET, Some(V::Num(n)), m));
            }
            if let Some(c) = f("commission") {
                cells.push((stmt::C_COMMISSION, Some(V::Num(c)), m));
            }
        }
        if let Some(s) = data.get("seq").and_then(Value::as_i64) {
            cells.push((stmt::C_SEQ, Some(V::Num(s as f64)), St::Int));
        }
        Line {
            key: key.to_string(),
            alt_keys: vec![],
            currency: cur,
            date: today,
            order: (today, i64::MAX),
            cells,
            fill: false,
            marks: vec![],
        }
    }

    /// The line of a tracking row, built from the program's current data (None: source gone).
    fn line_for(&self, conn: &Connection, t: &Track) -> AppResult<Option<Line>> {
        Ok(match t.kind {
            ItemKind::Txn => {
                let Ok(txn) = get_dto(conn, t.item_id) else { return Ok(None) };
                let credit = t.source_id.or(active_credit(conn, t.item_id)?);
                match credit {
                    Some(c) if txn.status == TxnStatus::Approved => {
                        Some(self.txn_line(conn, &txn, c, t.line_key.clone(), vec![]))
                    }
                    _ => None,
                }
            }
            ItemKind::Payout => match get_payout(conn, t.item_id) {
                Ok(p) if p.status != PayoutStatus::Draft => {
                    let mut l = self.payout_line(conn, &p)?;
                    l.key = t.line_key.clone();
                    Some(l)
                }
                _ => None,
            },
            ItemKind::Ledger => match get_entry(conn, t.item_id) {
                Ok(e) => Some(self.entry_line(conn, &e, t.line_key.clone(), vec![], t.data.as_ref())?),
                Err(_) => None,
            },
            ItemKind::Reversal => t.data.as_ref().map(|d| self.deletion_line(&t.line_key, d)),
        })
    }

    /// Before a transfer and/or ledger entries are deleted (SPEC 4.7), for every customer whose
    /// statement has their lines: pending lines are dropped, and each exported line not cancelled
    /// by an exported reversal that goes with it gets a "حذف" line.
    pub(crate) fn excel_before_delete(
        &self,
        conn: &Connection,
        txn_id: Option<i64>,
        entry_ids: &[i64],
    ) -> AppResult<()> {
        let customers: Vec<i64> = {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT customer_id FROM customer_excel_items
                 WHERE (item_kind = 'txn' AND item_id = ?1) OR (item_kind = 'ledger' AND item_id IN (SELECT value FROM json_each(?2)))",
            )?;
            let v = stmt
                .query_map(params![txn_id, serde_json::to_string(entry_ids).unwrap_or_default()], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            v
        };
        for c in customers {
            self.excel_before_delete_for(conn, c, txn_id, entry_ids)?;
        }
        Ok(())
    }

    fn excel_before_delete_for(
        &self,
        conn: &Connection,
        customer_id: i64,
        txn_id: Option<i64>,
        entry_ids: &[i64],
    ) -> AppResult<()> {
        let Some(link) = link_of(conn, customer_id)? else { return Ok(()) };
        if !link.auto {
            return Ok(());
        }
        let now = self.now_iso();
        let rows: Vec<Track> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT {TRACK_COLS} FROM customer_excel_items WHERE customer_id = ?1 AND file_path = ?2
                   AND item_kind IN ('txn','ledger')"
            ))?;
            let all = stmt.query_map(params![customer_id, link.path], track_from)?.collect::<Result<Vec<_>, _>>()?;
            all.into_iter()
                .filter(|t| match t.kind {
                    ItemKind::Txn => Some(t.item_id) == txn_id,
                    _ => entry_ids.contains(&t.item_id),
                })
                .collect()
        };
        for t in rows.iter().filter(|t| t.status == "pending") {
            conn.execute("DELETE FROM customer_excel_items WHERE rowid = ?1", params![t.rowid])?;
        }
        let exported: Vec<&Track> = rows.iter().filter(|t| t.status == "exported").collect();
        // (reversal line, the line it cancels), both exported and both going away.
        let mut pairs: HashSet<String> = HashSet::new();
        for t in &exported {
            if let Some(target) = rev_target(conn, customer_id, &link.path, t)? {
                if exported.iter().any(|o| o.line_key == target) {
                    pairs.insert(target);
                    pairs.insert(t.line_key.clone());
                }
            }
        }
        for t in exported {
            if pairs.contains(&t.line_key) {
                continue; // the line and its reversal are both in the file: they cancel out
            }
            let data = match &t.data {
                Some(d) if d.get("label").is_some() => d.clone(),
                _ => match self.line_for(conn, t)? {
                    Some(l) => snapshot(&l),
                    None => continue,
                },
            };
            let key = format!("-{}:del", t.line_key);
            let currency = data["currency"].as_str().unwrap_or("USD").to_string();
            let q = Queued {
                key: &key,
                kind: ItemKind::Reversal,
                item_id: t.item_id,
                source: None,
                currency: &currency,
                data: Some(&data),
            };
            queue_row(conn, &now, customer_id, &link.path, q)?;
        }
        Ok(())
    }
}

/// The key of the line a tracked reversal line cancels (from its data, or for lines of 0.5.0,
/// from the ledger: the tracked line of the entry it reverses).
fn rev_target(conn: &Connection, customer_id: i64, path: &str, t: &Track) -> AppResult<Option<String>> {
    if let Some(k) = t.data.as_ref().and_then(|d| d.get("revOf")).and_then(Value::as_str) {
        return Ok(Some(k.to_string()));
    }
    if t.kind != ItemKind::Ledger {
        return Ok(None);
    }
    let Ok(e) = get_entry(conn, t.item_id) else { return Ok(None) };
    let Some(o) = e.reverses_entry_id else { return Ok(None) };
    let Ok(orig) = get_entry(conn, o) else { return Ok(None) };
    let tr = if orig.kind == LedgerType::Credit {
        match orig.transaction_id {
            Some(txn) => tracked(conn, customer_id, path, ItemKind::Txn, txn, Some(o))?,
            None => None,
        }
    } else if let Some(p) = orig.payout_id {
        tracked(conn, customer_id, path, ItemKind::Payout, p, None)?
    } else {
        tracked(conn, customer_id, path, ItemKind::Ledger, o, None)?
    };
    Ok(tr.map(|t| t.line_key))
}

// ===== Writing =====

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Order {
    /// Automatic sync: the order the events happened.
    Events,
    /// A group (manual add, "send unexported"): the statement's order.
    Statement,
}

#[derive(Debug, Default)]
struct WriteResult {
    added: i64,
    skipped: i64,
    sheets: Vec<String>,
}

fn layout_err(e: super::xlsx::Layout) -> AppError {
    AppError::new(ErrorCode::ExcelLayout, e.0)
}

impl Core {
    fn read_file(path: &Path) -> AppResult<Vec<u8>> {
        std::fs::read(path).map_err(|e| if is_lock_error(&e) { file_locked() } else { export_failed(e) })
    }

    fn missing_file(path: &str) -> AppError {
        export_failed(format!("لم أجد ملف العميل في {path}. اربط ملفاً موجوداً أو أنشئ ملفاً جديداً"))
    }

    /// Write the pending lines of a customer (all, or only `only`) to the linked file.
    fn write_pending(&self, customer_id: i64, only: Option<&HashSet<String>>, order: Order) -> AppResult<WriteResult> {
        let _writer = self.excel_write.lock().unwrap_or_else(|e| e.into_inner());
        let now = self.now_iso();
        let (link, customer, tracks, lines) = {
            let conn = self.conn();
            let Some(link) = link_of(&conn, customer_id)? else {
                return Err(AppError::new(ErrorCode::NoExportPath, "لا يوجد ملف Excel مرتبط بهذا العميل"));
            };
            let customer = crate::customers::customer_ref(&conn, customer_id)?.name;
            let pending: Vec<Track> = {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {TRACK_COLS} FROM customer_excel_items
                     WHERE customer_id = ?1 AND file_path = ?2 AND status = 'pending' ORDER BY rowid"
                ))?;
                let v = stmt.query_map(params![customer_id, link.path], track_from)?.collect::<Result<Vec<_>, _>>()?;
                v
            };
            let mut tracks = vec![];
            let mut lines = vec![];
            for t in pending {
                if only.is_some_and(|o| !o.contains(&t.line_key)) {
                    continue;
                }
                match self.line_for(&conn, &t)? {
                    Some(l) => {
                        tracks.push(t);
                        lines.push(l);
                    }
                    None => {
                        conn.execute("DELETE FROM customer_excel_items WHERE rowid = ?1", params![t.rowid])?;
                    }
                }
            }
            (link, customer, tracks, lines)
        };
        if lines.is_empty() {
            return Ok(WriteResult::default());
        }
        let mut idx: Vec<usize> = (0..lines.len()).collect();
        if order == Order::Statement {
            idx.sort_by_key(|&i| lines[i].order);
        }
        let result = self.write_lines(&link.path, &customer, idx.iter().map(|&i| &lines[i]).collect());
        let conn = self.conn();
        match result {
            Ok((dups, sheets)) => {
                let tx = conn.unchecked_transaction()?;
                for (t, l) in tracks.iter().zip(lines.iter()) {
                    let mut data = snapshot(l);
                    if let Some(old) = &t.data {
                        for k in ["revOf", "seq", "netMinor", "commissionMinor"] {
                            if let Some(v) = old.get(k).filter(|v| !v.is_null()) {
                                data[k] = v.clone();
                            }
                        }
                    }
                    tx.execute(
                        "UPDATE customer_excel_items SET status = 'exported', exported_at = ?1, last_error = NULL, data = ?2
                         WHERE rowid = ?3",
                        params![now, data.to_string(), t.rowid],
                    )?;
                }
                tx.execute(
                    "UPDATE customer_excel SET updated_at = ?1 WHERE customer_id = ?2",
                    params![now, customer_id],
                )?;
                crate::audit::log(
                    &tx,
                    &now,
                    "customer_excel.write",
                    "customer",
                    Some(customer_id),
                    json!({ "path": link.path, "lines": lines.iter().map(|l| &l.key).collect::<Vec<_>>(), "duplicates": dups.len() }),
                )?;
                tx.commit()?;
                Ok(WriteResult { added: (lines.len() - dups.len()) as i64, skipped: dups.len() as i64, sheets })
            }
            Err(e) => {
                let text = serde_json::to_string(&e).unwrap_or_default();
                for t in &tracks {
                    conn.execute(
                        "UPDATE customer_excel_items SET last_error = ?1 WHERE rowid = ?2",
                        params![text, t.rowid],
                    )?;
                }
                Err(e)
            }
        }
    }

    /// Append lines (skipping those already in the file) and apply their marks; returns the keys
    /// found already in the file and the sheets written.
    fn write_lines(&self, path: &str, customer: &str, lines: Vec<&Line>) -> AppResult<(HashSet<String>, Vec<String>)> {
        if let Some(e) = self.excel_fault.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Err(e);
        }
        let p = PathBuf::from(path);
        if !p.exists() {
            return Err(Self::missing_file(path));
        }
        let mut currencies: Vec<String> = lines.iter().map(|l| l.currency.clone()).collect();
        currencies.sort();
        currencies.dedup();
        let bytes = Self::read_file(&p)?;
        let existing = stmt::existing(bytes.clone(), &currencies).map_err(layout_err)?;
        let mut groups: BTreeMap<String, Vec<Line>> = BTreeMap::new();
        let mut marks: BTreeMap<String, Vec<Mark>> = BTreeMap::new();
        let mut dups = HashSet::new();
        for l in lines {
            let in_file = existing
                .get(&l.currency)
                .is_some_and(|e| e.keys.contains(&l.key) || l.alt_keys.iter().any(|k| e.keys.contains(k)));
            if in_file {
                dups.insert(l.key.clone());
                marks.entry(l.currency.clone()).or_default().extend(l.marks.iter().cloned());
            } else {
                groups.entry(l.currency.clone()).or_default().push(l.clone());
            }
        }
        if groups.values().all(Vec::is_empty) && marks.values().all(Vec::is_empty) {
            return Ok((dups, vec![]));
        }
        let (out, sheets) =
            stmt::append_lines(bytes, customer, self.clock.today(), &groups, &marks).map_err(layout_err)?;
        statement_self_check(&out, &groups).map_err(export_failed)?;
        keep_previous(&p)?;
        save_atomic(&out, &p)?;
        Ok((dups, sheets))
    }

    /// Automatic sync of one customer (event order).
    pub fn customer_excel_flush(&self, customer_id: i64) -> SyncEvent {
        let r = self.write_pending(customer_id, None, Order::Events);
        let pending = {
            let conn = self.conn();
            link_of(&conn, customer_id)
                .ok()
                .flatten()
                .and_then(|l| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM customer_excel_items WHERE customer_id = ?1 AND file_path = ?2 AND status = 'pending'",
                        params![customer_id, l.path],
                        |r| r.get(0),
                    )
                    .ok()
                })
                .unwrap_or(0)
        };
        match r {
            Ok(w) => SyncEvent { customer_id, added: w.added, pending, error: None },
            Err(e) => SyncEvent { customer_id, added: 0, pending, error: Some(e) },
        }
    }

    /// Customers whose statement got new lines since the last pass; writes each (SPEC 6.8.3).
    pub fn customer_excel_sync_due(&self) -> Vec<SyncEvent> {
        let due: Vec<i64> = {
            let conn = self.conn();
            let ids: Vec<i64> = conn
                .prepare("SELECT customer_id FROM customer_excel WHERE dirty = 1")
                .and_then(|mut s| s.query_map([], |r| r.get(0)).and_then(|it| it.collect()))
                .unwrap_or_default();
            let _ = conn.execute("UPDATE customer_excel SET dirty = 0 WHERE dirty = 1", []);
            ids
        };
        due.into_iter().map(|c| self.customer_excel_flush(c)).collect()
    }

    /// Tests: make every statement write fail with `fault` (None: writes work again).
    #[doc(hidden)]
    pub fn debug_set_excel_fault(&self, fault: Option<AppError>) {
        *self.excel_fault.lock().unwrap_or_else(|e| e.into_inner()) = fault;
    }

    /// At startup: retry the lines still pending.
    pub(crate) fn excel_mark_pending_dirty(&self) -> AppResult<()> {
        self.conn().execute(
            "UPDATE customer_excel SET dirty = 1 WHERE EXISTS (SELECT 1 FROM customer_excel_items i
               WHERE i.customer_id = customer_excel.customer_id AND i.file_path = customer_excel.file_path
                 AND i.status = 'pending')",
            [],
        )?;
        Ok(())
    }
}

// ===== Link, counts and the public API =====

/// A requested item that can be added: the item, its credit (transfers), its line and preview.
type Resolved = (ItemRef, Option<i64>, Line, PreviewItem);

fn link_dto(conn: &Connection, customer_id: i64) -> AppResult<Option<CustomerExcel>> {
    let Some((path, updated_at, by_default, auto)) = conn
        .query_row(
            "SELECT file_path, updated_at, add_by_default, auto_sync FROM customer_excel WHERE customer_id = ?1",
            params![customer_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let count = |status: &str| -> AppResult<i64> {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM customer_excel_items WHERE customer_id = ?1 AND file_path = ?2 AND status = ?3",
            params![customer_id, path, status],
            |r| r.get(0),
        )?)
    };
    let last_error: Option<AppError> = conn
        .query_row(
            "SELECT last_error FROM customer_excel_items WHERE customer_id = ?1 AND file_path = ?2
               AND status = 'pending' AND last_error IS NOT NULL ORDER BY rowid DESC LIMIT 1",
            params![customer_id, path],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(Some(CustomerExcel {
        exists: Path::new(&path).exists(),
        exported_count: count("exported")?,
        pending_count: count("pending")?,
        not_exported_count: not_exported_count(conn, customer_id, &path)?,
        path,
        updated_at,
        add_to_excel_by_default: by_default != 0,
        auto_sync: auto != 0,
        last_error,
    }))
}

impl Core {
    /// Items that belong in the statement but have no line for the linked file yet.
    fn untracked(&self, conn: &Connection, customer_id: i64, path: &str) -> AppResult<Vec<ItemRef>> {
        let mut out = vec![];
        let ids = |sql: &str| -> AppResult<Vec<i64>> {
            let mut stmt = conn.prepare(sql)?;
            let v = stmt.query_map(params![customer_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(v)
        };
        for id in ids("SELECT id FROM paypal_transactions WHERE customer_id = ?1 AND status = 'approved' ORDER BY id")?
        {
            let credit = active_credit(conn, id)?;
            if credit.is_some() && tracked(conn, customer_id, path, ItemKind::Txn, id, credit)?.is_none() {
                out.push(ItemRef { kind: ItemKind::Txn, id });
            }
        }
        for id in ids("SELECT id FROM payouts WHERE customer_id = ?1 AND status = 'sent' ORDER BY id")? {
            if tracked(conn, customer_id, path, ItemKind::Payout, id, None)?.is_none() {
                out.push(ItemRef { kind: ItemKind::Payout, id });
            }
        }
        for id in ids(
            "SELECT id FROM ledger_entries WHERE customer_id = ?1 AND type <> 'credit' AND payout_id IS NULL ORDER BY id",
        )? {
            if tracked(conn, customer_id, path, ItemKind::Ledger, id, None)?.is_some() {
                continue;
            }
            let e = get_entry(conn, id)?;
            let eligible = match e.reverses_entry_id {
                None => true,
                // A reversal belongs in the statement only when what it reverses is there.
                Some(o) => {
                    let orig = get_entry(conn, o)?;
                    let st = if orig.kind == LedgerType::Credit {
                        match orig.transaction_id {
                            Some(t) => tracked(conn, customer_id, path, ItemKind::Txn, t, Some(o))?,
                            None => None,
                        }
                    } else if let Some(p) = orig.payout_id {
                        tracked(conn, customer_id, path, ItemKind::Payout, p, None)?
                    } else {
                        tracked(conn, customer_id, path, ItemKind::Ledger, o, None)?
                    };
                    st.is_some_and(|t| t.status == "exported")
                }
            };
            if eligible {
                out.push(ItemRef { kind: ItemKind::Ledger, id });
            }
        }
        Ok(out)
    }

    /// Items of the statement that are not exported to the linked file (untracked or pending).
    pub(crate) fn excel_missing(&self, conn: &Connection, customer_id: i64) -> AppResult<HashSet<(ItemKind, i64)>> {
        let path = link_of(conn, customer_id)?.map(|l| l.path).unwrap_or_default();
        let mut out: HashSet<(ItemKind, i64)> =
            self.untracked(conn, customer_id, &path)?.into_iter().map(|i| (i.kind, i.id)).collect();
        let mut stmt = conn.prepare(
            "SELECT item_kind, item_id FROM customer_excel_items WHERE customer_id = ?1 AND file_path = ?2 AND status = 'pending'",
        )?;
        for r in stmt.query_map(params![customer_id, path], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (k, id) = r?;
            out.insert((ItemKind::parse(&k), id));
        }
        Ok(out)
    }

    fn require_link(&self, customer_id: i64) -> AppResult<CustomerExcel> {
        let conn = self.conn();
        crate::customers::customer_ref(&conn, customer_id)?;
        let link = link_dto(&conn, customer_id)?
            .ok_or_else(|| AppError::new(ErrorCode::NoExportPath, "لا يوجد ملف Excel مرتبط بهذا العميل"))?;
        if !link.exists {
            return Err(Self::missing_file(&link.path));
        }
        Ok(link)
    }

    pub fn customer_excel_get(&self, customer_id: i64) -> AppResult<Option<CustomerExcel>> {
        let conn = self.conn();
        crate::customers::customer_ref(&conn, customer_id)?;
        link_dto(&conn, customer_id)
    }

    pub fn customer_excel_set_default(&self, customer_id: i64, add_by_default: bool) -> AppResult<CustomerExcel> {
        let conn = self.conn();
        crate::customers::customer_ref(&conn, customer_id)?;
        let n = conn.execute(
            "UPDATE customer_excel SET add_by_default = ?1 WHERE customer_id = ?2",
            params![add_by_default as i64, customer_id],
        )?;
        if n == 0 {
            return Err(AppError::new(ErrorCode::NoExportPath, "لا يوجد ملف Excel مرتبط بهذا العميل"));
        }
        link_dto(&conn, customer_id)?.ok_or_else(|| AppError::internal("link vanished"))
    }

    /// SPEC 6.8.3: automatic sync on / off for a customer.
    pub fn customer_excel_set_auto(&self, customer_id: i64, auto: bool) -> AppResult<CustomerExcel> {
        let now = self.now_iso();
        let conn = self.conn();
        crate::customers::customer_ref(&conn, customer_id)?;
        let n = conn.execute(
            "UPDATE customer_excel SET auto_sync = ?1 WHERE customer_id = ?2",
            params![auto as i64, customer_id],
        )?;
        if n == 0 {
            return Err(AppError::new(ErrorCode::NoExportPath, "لا يوجد ملف Excel مرتبط بهذا العميل"));
        }
        crate::audit::log(
            &conn,
            &now,
            "customer_excel.set_auto",
            "customer",
            Some(customer_id),
            json!({ "autoSync": auto }),
        )?;
        link_dto(&conn, customer_id)?.ok_or_else(|| AppError::internal("link vanished"))
    }

    pub fn customer_excel_unlink(&self, customer_id: i64) -> AppResult<()> {
        let now = self.now_iso();
        let conn = self.conn();
        crate::customers::customer_ref(&conn, customer_id)?;
        conn.execute("DELETE FROM customer_excel WHERE customer_id = ?1", params![customer_id])?;
        crate::audit::log(&conn, &now, "customer_excel.unlink", "customer", Some(customer_id), json!({}))?;
        Ok(())
    }

    fn set_link(&self, customer_id: i64, path: &str) -> AppResult<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO customer_excel (customer_id, file_path, updated_at, add_by_default, auto_sync) VALUES (?1, ?2, ?3, 0, 1)
             ON CONFLICT(customer_id) DO UPDATE SET file_path = excluded.file_path, updated_at = excluded.updated_at",
            params![customer_id, path, self.now_iso()],
        )?;
        Ok(())
    }

    /// Link an existing statement; it must be one PpFeez created for this customer.
    pub fn customer_excel_link(&self, customer_id: i64, path: &str) -> AppResult<CustomerExcel> {
        let path = validate_xlsx_path(path)?;
        {
            let conn = self.conn();
            crate::customers::customer_ref(&conn, customer_id)?;
        }
        let bytes = Self::read_file(Path::new(&path))?;
        let not_statement =
            || AppError::new(ErrorCode::ExcelLayout, "هذا الملف ليس كشف حساب أنشأه البرنامج لهذا العميل");
        let mut pkg = super::xlsx::Package::open(bytes).map_err(|_| not_statement())?;
        let id = super::xlsx::custom_property(&mut pkg, PROP_CUSTOMER).map_err(|_| not_statement())?;
        if id.as_deref().and_then(|v| v.parse::<i64>().ok()) != Some(customer_id) {
            return Err(not_statement());
        }
        self.set_link(customer_id, &path)?;
        let now = self.now_iso();
        let conn = self.conn();
        crate::audit::log(&conn, &now, "customer_excel.link", "customer", Some(customer_id), json!({ "path": path }))?;
        link_dto(&conn, customer_id)?.ok_or_else(|| AppError::internal("link vanished"))
    }

    /// Create the customer's statement file (one sheet per currency) and link it, with
    /// automatic sync on; `include_existing` sends everything that belongs in it.
    pub fn customer_excel_create(
        &self,
        customer_id: i64,
        path: &str,
        include_existing: bool,
    ) -> AppResult<CustomerExcelCreated> {
        let path_s = validate_xlsx_path(path)?;
        let path = PathBuf::from(&path_s);
        let (customer, mut currencies) = {
            let conn = self.conn();
            let c = crate::customers::get(&conn, customer_id)?;
            let mut stmt = conn.prepare(
                "SELECT currency FROM ledger_entries WHERE customer_id = ?1
                 UNION SELECT currency FROM paypal_transactions WHERE customer_id = ?1",
            )?;
            let cur: Vec<String> = stmt.query_map(params![customer_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            (c, cur)
        };
        if currencies.is_empty() {
            currencies.push("USD".into());
        }
        currencies.sort();
        currencies.dedup();
        let today = self.clock.today();
        let f = super::model::Formats::new();
        let mut wb = rust_xlsxwriter::Workbook::new();
        for cur in &currencies {
            super::model::render(&mut wb, &f, &stmt::sheet_model(&customer.name, cur, today, &[]))?;
        }
        let props = rust_xlsxwriter::DocProperties::new()
            .set_title(format!("كشف حساب — {}", customer.name))
            .set_custom_property(PROP_CUSTOMER, customer_id as i32);
        wb.set_properties(&props);
        let bytes = wb.save_to_buffer()?;
        if path.exists() {
            keep_previous(&path)?;
        }
        save_atomic(&bytes, &path)?;
        self.set_link(customer_id, &path_s)?;
        {
            let now = self.now_iso();
            let conn = self.conn();
            crate::audit::log(
                &conn,
                &now,
                "customer_excel.create",
                "customer",
                Some(customer_id),
                json!({ "path": path_s }),
            )?;
        }
        let mut sheets: Vec<String> = currencies.iter().map(|c| stmt::sheet_name(c)).collect();
        let added = if include_existing {
            let r = self.customer_excel_send_unexported(customer_id)?;
            r.added
        } else {
            0
        };
        sheets.dedup();
        Ok(CustomerExcelCreated { path: path_s, added, sheets })
    }

    /// Resolve requested items to their lines (allowed) and refusals.
    fn resolve_items(
        &self,
        conn: &Connection,
        customer_id: i64,
        path: &str,
        items: &[ItemRef],
    ) -> AppResult<(Vec<Resolved>, Vec<NotAllowed>)> {
        let mut ok = vec![];
        let mut bad = vec![];
        let mut seen = HashSet::new();
        for it in items {
            if !seen.insert((it.kind, it.id)) {
                continue;
            }
            let refuse = |reason: &str| NotAllowed { kind: it.kind, id: it.id, reason_ar: reason.to_string() };
            match it.kind {
                ItemKind::Txn => {
                    let Ok(t) = get_dto(conn, it.id) else {
                        bad.push(refuse("المعاملة غير موجودة"));
                        continue;
                    };
                    let credit = active_credit(conn, it.id)?;
                    if t.customer.as_ref().map(|c| c.id) != Some(customer_id) {
                        bad.push(refuse("المعاملة ليست لهذا العميل"));
                    } else if t.status != TxnStatus::Approved || credit.is_none() {
                        bad.push(refuse("الحوالة غير معتمدة؛ تُضاف الحوالات المعتمدة فقط"));
                    } else {
                        let c = credit.expect("checked");
                        let (key, alt) = txn_key(conn, customer_id, path, &t, c)?;
                        let line = self.txn_line(conn, &t, c, key, alt);
                        let preview = PreviewItem {
                            kind: it.kind,
                            id: it.id,
                            date: line.date.to_string(),
                            label_ar: format!(
                                "حوالة #{} من {}",
                                t.customer_seq.unwrap_or_default(),
                                t.payer_name.as_deref().unwrap_or("PayPal")
                            ),
                            currency: t.currency.clone(),
                            amount_minor: t.customer_amount_minor.unwrap_or(0),
                        };
                        ok.push((*it, Some(c), line, preview));
                    }
                }
                ItemKind::Payout => {
                    let Ok(p) = get_payout(conn, it.id) else {
                        bad.push(refuse("الدفعة غير موجودة"));
                        continue;
                    };
                    if p.customer_id != customer_id {
                        bad.push(refuse("الدفعة ليست لهذا العميل"));
                    } else if p.status != PayoutStatus::Sent {
                        bad.push(refuse(if p.status == PayoutStatus::Draft {
                            "الدفعة مسجلة ولم تُرسل بعد؛ تُضاف بعد «تأكيد الإرسال»"
                        } else {
                            "الدفعة ملغاة"
                        }));
                    } else {
                        let line = self.payout_line(conn, &p)?;
                        let preview = PreviewItem {
                            kind: it.kind,
                            id: it.id,
                            date: p.date.clone(),
                            label_ar: format!("دفعة {} {}", p.seq, p.range_label).trim().to_string(),
                            currency: p.currency.clone(),
                            amount_minor: p.amount_minor,
                        };
                        ok.push((*it, None, line, preview));
                    }
                }
                ItemKind::Ledger => {
                    let Ok(e) = get_entry(conn, it.id) else {
                        bad.push(refuse("القيد غير موجود"));
                        continue;
                    };
                    if e.customer_id != customer_id {
                        bad.push(refuse("القيد ليس لهذا العميل"));
                    } else if e.kind == LedgerType::Credit {
                        bad.push(refuse("قيد اعتماد: أضف الحوالة نفسها من تبويب العملة"));
                    } else if e.payout_id.is_some() {
                        bad.push(refuse("قيد دفعة مرتبطة بحوالات: أضف الدفعة نفسها"));
                    } else {
                        let (key, alt) = entry_key(conn, customer_id, path, &e)?;
                        let data = tracked(conn, customer_id, path, ItemKind::Ledger, e.id, None)?.and_then(|t| t.data);
                        let line = self.entry_line(conn, &e, key, alt, data.as_ref())?;
                        let preview = PreviewItem {
                            kind: it.kind,
                            id: it.id,
                            date: e.entry_date.clone(),
                            label_ar: match line.cells.iter().find(|c| c.0 == stmt::C_LABEL) {
                                Some((_, Some(V::Str(l)), _)) => l.clone(),
                                _ => e.description.clone(),
                            },
                            currency: e.currency.clone(),
                            amount_minor: e.amount_minor,
                        };
                        ok.push((*it, None, line, preview));
                    }
                }
                ItemKind::Reversal => bad.push(refuse("نوع غير مدعوم")),
            }
        }
        ok.sort_by_key(|r| r.2.order);
        Ok((ok, bad))
    }

    /// What would be added, what is already in the file, and what cannot be added.
    pub fn customer_excel_preview(&self, customer_id: i64, items: &[ItemRef]) -> AppResult<CustomerExcelPreview> {
        let link = self.require_link(customer_id)?;
        let (resolved, not_allowed) = {
            let conn = self.conn();
            self.resolve_items(&conn, customer_id, &link.path, items)?
        };
        let mut currencies: Vec<String> = resolved.iter().map(|r| r.2.currency.clone()).collect();
        currencies.sort();
        currencies.dedup();
        let bytes = Self::read_file(Path::new(&link.path))?;
        let existing = stmt::existing(bytes, &currencies).map_err(layout_err)?;
        let mut to_add = vec![];
        let mut duplicates = vec![];
        let mut older = 0;
        for (_, _, line, preview) in resolved {
            let ex = existing.get(&line.currency);
            if ex.is_some_and(|e| e.keys.contains(&line.key) || line.alt_keys.iter().any(|k| e.keys.contains(k))) {
                duplicates.push(preview);
            } else {
                let serial = super::model::value_number(&V::Date(line.date), false).unwrap_or(0.0);
                if ex.and_then(|e| e.last_date).is_some_and(|last| serial < last) {
                    older += 1;
                }
                to_add.push(preview);
            }
        }
        Ok(CustomerExcelPreview { to_add, duplicates, not_allowed, older_than_last_row: older })
    }

    /// Queue the given items (tracked or not) as pending lines of the linked file.
    fn queue_items(
        &self,
        customer_id: i64,
        path: &str,
        items: &[ItemRef],
    ) -> AppResult<(HashSet<String>, Vec<NotAllowed>)> {
        let now = self.now_iso();
        let conn = self.conn();
        let (resolved, not_allowed) = self.resolve_items(&conn, customer_id, path, items)?;
        let tx = conn.unchecked_transaction()?;
        let mut keys = HashSet::new();
        for (it, source, line, _) in &resolved {
            let q = Queued {
                key: &line.key,
                kind: it.kind,
                item_id: it.id,
                source: *source,
                currency: &line.currency,
                data: None,
            };
            queue_row(&tx, &now, customer_id, path, q)?;
            keys.insert(line.key.clone());
        }
        tx.commit()?;
        Ok((keys, not_allowed))
    }

    /// Add items to the linked statement (statement order); lines already in the file are skipped.
    pub fn customer_excel_add(&self, customer_id: i64, items: &[ItemRef]) -> AppResult<CustomerExcelAdded> {
        let link = self.require_link(customer_id)?;
        let (keys, not_allowed) = self.queue_items(customer_id, &link.path, items)?;
        if keys.is_empty() {
            let reason = not_allowed.first().map(|n| n.reason_ar.clone()).unwrap_or_else(|| "لا شيء للإضافة".into());
            return Err(AppError::validation("items", reason));
        }
        let w = self.write_pending(customer_id, Some(&keys), Order::Statement)?;
        Ok(CustomerExcelAdded { path: link.path, added: w.added, skipped_duplicates: w.skipped, sheets: w.sheets })
    }

    /// SPEC 6.8.3: send everything not yet in the file (and what is pending), statement order.
    pub fn customer_excel_send_unexported(&self, customer_id: i64) -> AppResult<CustomerExcelSent> {
        let link = self.require_link(customer_id)?;
        let items = {
            let conn = self.conn();
            self.untracked(&conn, customer_id, &link.path)?
        };
        self.queue_items(customer_id, &link.path, &items)?;
        let w = self.write_pending(customer_id, None, Order::Statement)?;
        let still: i64 = self.conn().query_row(
            "SELECT COUNT(*) FROM customer_excel_items WHERE customer_id = ?1 AND file_path = ?2 AND status = 'pending'",
            params![customer_id, link.path],
            |r| r.get(0),
        )?;
        Ok(CustomerExcelSent { path: link.path, added: w.added, skipped_duplicates: w.skipped, still_pending: still })
    }

    /// For the dashboard: customers with lines not yet in their statement.
    pub fn customer_excel_unexported_summary(&self) -> AppResult<Vec<UnexportedSummary>> {
        let conn = self.conn();
        let ids: Vec<(i64, String)> = {
            let mut stmt = conn.prepare(
                "SELECT c.id, c.name FROM customer_excel x JOIN customers c ON c.id = x.customer_id ORDER BY c.name COLLATE NOCASE",
            )?;
            let v = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
            v
        };
        let mut out = vec![];
        for (id, name) in ids {
            if let Some(l) = link_dto(&conn, id)? {
                if l.pending_count + l.not_exported_count > 0 {
                    out.push(UnexportedSummary {
                        customer_id: id,
                        customer_name: name,
                        pending: l.pending_count,
                        not_exported: l.not_exported_count,
                        last_error: l.last_error,
                    });
                }
            }
        }
        Ok(out)
    }
}

/// The link of a customer with its counts (also shown on the customer).
pub fn get_link(conn: &Connection, customer_id: i64) -> AppResult<Option<CustomerExcel>> {
    link_dto(conn, customer_id)
}

/// `untracked(..).len()` in one query (the customer list shows it for every customer).
fn not_exported_count(conn: &Connection, customer_id: i64, path: &str) -> AppResult<i64> {
    const TRACKED: &str = "SELECT 1 FROM customer_excel_items i WHERE i.customer_id = ?1 AND i.file_path = ?2";
    let sql = format!(
        "SELECT
           (SELECT COUNT(*) FROM paypal_transactions t
             JOIN ledger_entries c ON c.paypal_transaction_id = t.id AND c.type = 'credit'
               AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = c.id)
               AND c.id = (SELECT MAX(c2.id) FROM ledger_entries c2 WHERE c2.paypal_transaction_id = t.id AND c2.type = 'credit')
             WHERE t.customer_id = ?1 AND t.status = 'approved'
               AND NOT EXISTS ({TRACKED} AND i.item_kind = 'txn' AND i.item_id = t.id
                                AND (i.source_id = c.id OR i.source_id IS NULL)))
         + (SELECT COUNT(*) FROM payouts p WHERE p.customer_id = ?1 AND p.status = 'sent'
               AND NOT EXISTS ({TRACKED} AND i.item_kind = 'payout' AND i.item_id = p.id))
         + (SELECT COUNT(*) FROM ledger_entries e LEFT JOIN ledger_entries o ON o.id = e.reverses_entry_id
             WHERE e.customer_id = ?1 AND e.type <> 'credit' AND e.payout_id IS NULL
               AND NOT EXISTS ({TRACKED} AND i.item_kind = 'ledger' AND i.item_id = e.id)
               AND (o.id IS NULL OR EXISTS ({TRACKED} AND i.status = 'exported' AND (
                     (o.type = 'credit' AND i.item_kind = 'txn' AND i.item_id = o.paypal_transaction_id
                        AND (i.source_id = o.id OR i.source_id IS NULL))
                  OR (o.type <> 'credit' AND o.payout_id IS NOT NULL AND i.item_kind = 'payout' AND i.item_id = o.payout_id)
                  OR (o.type <> 'credit' AND o.payout_id IS NULL AND i.item_kind = 'ledger' AND i.item_id = o.id)))))"
    );
    Ok(conn.query_row(&sql, params![customer_id, path], |r| r.get(0))?)
}

/// The new file opens with an independent reader and holds every added key.
fn statement_self_check(bytes: &[u8], groups: &BTreeMap<String, Vec<Line>>) -> Result<(), String> {
    use calamine::{Data, Reader, Xlsx};
    let mut wb: Xlsx<_> = Xlsx::new(std::io::Cursor::new(bytes.to_vec())).map_err(|e| e.to_string())?;
    for (cur, lines) in groups {
        if lines.is_empty() {
            continue;
        }
        let range = wb.worksheet_range(&stmt::sheet_name(cur)).map_err(|e| e.to_string())?;
        let keys: HashSet<String> = range
            .rows()
            .filter_map(|r| r.get(stmt::C_KEY as usize))
            .filter_map(|c| if let Data::String(s) = c { Some(s.clone()) } else { None })
            .collect();
        if let Some(l) = lines.iter().find(|l| !keys.contains(&l.key)) {
            return Err(format!("self-check: {} missing in {}", l.key, stmt::sheet_name(cur)));
        }
    }
    Ok(())
}
