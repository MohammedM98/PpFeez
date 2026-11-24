//! SPEC §6.8.2: the Excel statement a customer receives (tracking and flags).

use crate::error::AppResult;
use crate::transactions::{TxnRow, TxnStatus};
use rusqlite::{params, Connection};

/// Whether a tracked item is in the customer's currently linked statement.
pub(crate) fn tracked(conn: &Connection, customer_id: i64, kind: &str, item_id: i64) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM customer_excel_items i JOIN customer_excel c
             ON c.customer_id = i.customer_id AND c.file_path = i.file_path
         WHERE i.customer_id = ?1 AND i.item_kind = ?2 AND i.item_id = ?3)",
        params![customer_id, kind, item_id],
        |r| r.get(0),
    )?)
}

/// (in the customer's statement, changed after being added). A transfer keeps its tracking row
/// after unapprove (its customer is then gone), so look it up by item id.
pub(crate) fn txn_flags(conn: &Connection, row: &TxnRow) -> AppResult<(bool, bool)> {
    let customer: Option<i64> = conn
        .query_row(
            "SELECT i.customer_id FROM customer_excel_items i JOIN customer_excel c
                 ON c.customer_id = i.customer_id AND c.file_path = i.file_path
             WHERE i.item_kind = 'txn' AND i.item_id = ?1 LIMIT 1",
            params![row.id],
            |r| r.get(0),
        )
        .ok();
    match customer {
        None => Ok((false, false)),
        Some(c) => {
            let current = row.status == TxnStatus::Approved && row.customer_id == Some(c);
            Ok((current, !current))
        }
    }
}

// ===== The statement file =====

use super::model::{St, V};
use super::statement::{self as stmt, Line};
use super::{export_failed, file_locked, is_lock_error, keep_previous, save_atomic, validate_xlsx_path};
use crate::error::{AppError, ErrorCode};
use crate::ledger::{get_entry, LedgerEntry, LedgerType};
use crate::payouts::{get_payout, Payout, PayoutStatus};
use crate::transactions::{get_dto, Transaction};
use crate::Core;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PROP_CUSTOMER: &str = "PpFeezCustomerId";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerExcel {
    pub path: String,
    pub updated_at: Option<String>,
    pub exists: bool,
    pub add_to_excel_by_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Txn,
    Ledger,
    Payout,
}

impl ItemKind {
    fn as_str(self) -> &'static str {
        match self {
            ItemKind::Txn => "txn",
            ItemKind::Ledger => "ledger",
            ItemKind::Payout => "payout",
        }
    }
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

/// The linked statement of a customer, if any.
pub fn get_link(conn: &Connection, customer_id: i64) -> AppResult<Option<CustomerExcel>> {
    Ok(conn
        .query_row(
            "SELECT file_path, updated_at, add_by_default FROM customer_excel WHERE customer_id = ?1",
            params![customer_id],
            |r| {
                let path: String = r.get(0)?;
                Ok(CustomerExcel {
                    exists: Path::new(&path).exists(),
                    path,
                    updated_at: r.get(1)?,
                    add_to_excel_by_default: r.get::<_, i64>(2)? != 0,
                })
            },
        )
        .optional()?)
}

struct Resolved {
    kind: ItemKind,
    id: i64,
    line: Line,
    preview: PreviewItem,
}

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

/// Ledger entries tell their key prefix by what they are.
fn entry_prefix(conn: &Connection, e: &LedgerEntry) -> AppResult<&'static str> {
    if e.kind == LedgerType::Payout {
        return Ok("U");
    }
    if e.kind == LedgerType::Reversal {
        if let Some(orig) = e.reverses_entry_id {
            let o = get_entry(conn, orig)?;
            if o.kind == LedgerType::Payout {
                return Ok("X");
            }
        } else if e.amount_minor < 0 && e.transaction_id.is_some() {
            return Ok("R");
        }
    }
    Ok("L")
}

impl Core {
    fn txn_line(&self, t: &Transaction) -> Line {
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
            (stmt::C_KEY, Some(V::Str(format!("T:{}", t.paypal_txn_id))), St::Text),
        ];
        if let Some((v, st)) = pct {
            cells.push((stmt::C_PCT, Some(v), st));
        }
        Line {
            key: format!("T:{}", t.paypal_txn_id),
            currency: t.currency.clone(),
            date,
            order: (date, 0, t.id),
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
        let mut marks = vec![];
        for &tid in &p.item_ids.txns {
            if let Ok(t) = get_dto(conn, tid) {
                marks.push((format!("T:{}", t.paypal_txn_id), format!("نعم — دفعة {}", p.seq)));
            }
        }
        Ok(Line {
            key: format!("P:{}", p.id),
            currency: p.currency.clone(),
            date,
            order: (date, 2, p.id),
            cells: vec![
                (stmt::C_SEQ, Some(V::Str(format!("دفعة {}", p.seq))), St::Bold),
                (stmt::C_DATE, Some(V::Date(date)), St::Date),
                (stmt::C_LABEL, Some(V::Str(label)), St::Text),
                (stmt::C_DEBIT, money(Some(p.amount_minor), cur), St::money(cur, false)),
                (stmt::C_SENT, Some(V::Str("تم الإرسال".into())), St::Text),
                (stmt::C_METHOD, Some(V::Str(p.details.method.label_ar().into())), St::Text),
                (stmt::C_PLATFORM, opt_str(p.details.platform.as_deref()), St::Text),
                (stmt::C_NETWORK, opt_str(p.details.network.as_deref()), St::Text),
                (stmt::C_REF, opt_str(p.details.reference.as_deref()), St::Text),
                (stmt::C_NOTES, opt_str(p.details.note.as_deref()), St::Text),
                (stmt::C_KEY, Some(V::Str(format!("P:{}", p.id))), St::Text),
            ],
            fill: true,
            marks,
        })
    }

    fn entry_line(&self, conn: &Connection, e: &LedgerEntry) -> AppResult<Line> {
        let cur = e.currency.as_str();
        let date = crate::clock::parse_date(&e.entry_date).unwrap_or_default();
        let key = format!("{}:{}", entry_prefix(conn, e)?, e.id);
        let m = St::money(cur, false);
        let mut cells = vec![
            (stmt::C_DATE, Some(V::Date(date)), St::Date),
            (stmt::C_LABEL, Some(V::Str(e.description.clone())), St::Text),
            (stmt::C_REF, opt_str(e.reference.as_deref()), St::Text),
            (stmt::C_KEY, Some(V::Str(key.clone())), St::Text),
        ];
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
        Ok(Line { key, currency: e.currency.clone(), date, order: (date, 1, e.id), cells, fill: false, marks: vec![] })
    }

    /// Lines for the requested items, and the items that cannot go into the statement.
    fn resolve_items(&self, customer_id: i64, items: &[ItemRef]) -> AppResult<(Vec<Resolved>, Vec<NotAllowed>)> {
        let conn = self.conn();
        let mut ok = vec![];
        let mut bad = vec![];
        let mut seen = std::collections::HashSet::new();
        for it in items {
            if !seen.insert((it.kind, it.id)) {
                continue;
            }
            let refuse = |reason: &str| NotAllowed { kind: it.kind, id: it.id, reason_ar: reason.to_string() };
            match it.kind {
                ItemKind::Txn => {
                    let Ok(t) = get_dto(&conn, it.id) else {
                        bad.push(refuse("المعاملة غير موجودة"));
                        continue;
                    };
                    if t.customer.as_ref().map(|c| c.id) != Some(customer_id) {
                        bad.push(refuse("المعاملة ليست لهذا العميل"));
                    } else if t.status != TxnStatus::Approved {
                        bad.push(refuse("الحوالة غير معتمدة؛ تُضاف الحوالات المعتمدة فقط"));
                    } else {
                        let line = self.txn_line(&t);
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
                        ok.push(Resolved { kind: it.kind, id: it.id, line, preview });
                    }
                }
                ItemKind::Payout => {
                    let Ok(p) = get_payout(&conn, it.id) else {
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
                        let line = self.payout_line(&conn, &p)?;
                        let preview = PreviewItem {
                            kind: it.kind,
                            id: it.id,
                            date: p.date.clone(),
                            label_ar: format!("دفعة {} {}", p.seq, p.range_label).trim().to_string(),
                            currency: p.currency.clone(),
                            amount_minor: p.amount_minor,
                        };
                        ok.push(Resolved { kind: it.kind, id: it.id, line, preview });
                    }
                }
                ItemKind::Ledger => {
                    let Ok(e) = get_entry(&conn, it.id) else {
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
                        let line = self.entry_line(&conn, &e)?;
                        let preview = PreviewItem {
                            kind: it.kind,
                            id: it.id,
                            date: e.entry_date.clone(),
                            label_ar: e.description.clone(),
                            currency: e.currency.clone(),
                            amount_minor: e.amount_minor,
                        };
                        ok.push(Resolved { kind: it.kind, id: it.id, line, preview });
                    }
                }
            }
        }
        ok.sort_by_key(|r| r.line.order);
        Ok((ok, bad))
    }

    fn require_link(&self, customer_id: i64) -> AppResult<CustomerExcel> {
        let conn = self.conn();
        crate::customers::customer_ref(&conn, customer_id)?;
        let link = get_link(&conn, customer_id)?
            .ok_or_else(|| AppError::new(ErrorCode::NoExportPath, "لا يوجد ملف Excel مرتبط بهذا العميل"))?;
        if !link.exists {
            return Err(export_failed(format!(
                "لم أجد ملف العميل في {}. اربط ملفاً موجوداً أو أنشئ ملفاً جديداً",
                link.path
            )));
        }
        Ok(link)
    }

    fn read_file(path: &Path) -> AppResult<Vec<u8>> {
        std::fs::read(path).map_err(|e| if is_lock_error(&e) { file_locked() } else { export_failed(e) })
    }

    pub fn customer_excel_get(&self, customer_id: i64) -> AppResult<Option<CustomerExcel>> {
        let conn = self.conn();
        crate::customers::customer_ref(&conn, customer_id)?;
        get_link(&conn, customer_id)
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
        get_link(&conn, customer_id)?.ok_or_else(|| AppError::internal("link vanished"))
    }

    pub fn customer_excel_unlink(&self, customer_id: i64) -> AppResult<()> {
        let now = self.now_iso();
        let conn = self.conn();
        crate::customers::customer_ref(&conn, customer_id)?;
        conn.execute("DELETE FROM customer_excel WHERE customer_id = ?1", params![customer_id])?;
        crate::audit::log(&conn, &now, "customer_excel.unlink", "customer", Some(customer_id), serde_json::json!({}))?;
        Ok(())
    }

    fn set_link(&self, customer_id: i64, path: &str) -> AppResult<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO customer_excel (customer_id, file_path, updated_at, add_by_default) VALUES (?1, ?2, ?3, 0)
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
        crate::audit::log(
            &conn,
            &now,
            "customer_excel.link",
            "customer",
            Some(customer_id),
            serde_json::json!({ "path": path }),
        )?;
        get_link(&conn, customer_id)?.ok_or_else(|| AppError::internal("link vanished"))
    }

    /// Every item that may go into the statement (for "add everything" on creation): approved
    /// transfers, sent payouts, and entries other than approvals, linked payouts and unapprove
    /// pairs.
    fn all_items(&self, customer_id: i64) -> AppResult<Vec<ItemRef>> {
        let conn = self.conn();
        let mut v = vec![];
        let q = |sql: &str| -> AppResult<Vec<i64>> {
            let mut stmt = conn.prepare(sql)?;
            let ids = stmt.query_map(params![customer_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(ids)
        };
        for id in q("SELECT id FROM paypal_transactions WHERE customer_id = ?1 AND status = 'approved'")? {
            v.push(ItemRef { kind: ItemKind::Txn, id });
        }
        for id in q("SELECT id FROM payouts WHERE customer_id = ?1 AND status = 'sent'")? {
            v.push(ItemRef { kind: ItemKind::Payout, id });
        }
        for id in q("SELECT e.id FROM ledger_entries e WHERE e.customer_id = ?1 AND e.type <> 'credit'
                       AND e.payout_id IS NULL
                       AND NOT (e.type = 'reversal' AND e.reverses_entry_id IN
                                (SELECT id FROM ledger_entries WHERE type = 'credit' OR payout_id IS NOT NULL))")?
        {
            v.push(ItemRef { kind: ItemKind::Ledger, id });
        }
        Ok(v)
    }

    /// Create the customer's statement file (one sheet per currency) and link it.
    pub fn customer_excel_create(
        &self,
        customer_id: i64,
        path: &str,
        include_existing: bool,
    ) -> AppResult<CustomerExcelCreated> {
        let path_s = validate_xlsx_path(path)?;
        let path = PathBuf::from(&path_s);
        let customer = { crate::customers::get(&self.conn(), customer_id)? };
        let items = if include_existing { self.all_items(customer_id)? } else { vec![] };
        let (resolved, _) = self.resolve_items(customer_id, &items)?;
        let mut currencies: Vec<String> = resolved.iter().map(|r| r.line.currency.clone()).collect();
        if currencies.is_empty() {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT currency FROM ledger_entries WHERE customer_id = ?1
                 UNION SELECT currency FROM paypal_transactions WHERE customer_id = ?1",
            )?;
            currencies = stmt.query_map(params![customer_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        }
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
                serde_json::json!({ "path": path_s }),
            )?;
        }
        let mut sheets: Vec<String> = currencies.iter().map(|c| stmt::sheet_name(c)).collect();
        let added = if items.is_empty() {
            0
        } else {
            let r = self.customer_excel_add(customer_id, &items)?;
            for s in r.sheets {
                if !sheets.contains(&s) {
                    sheets.push(s);
                }
            }
            r.added
        };
        Ok(CustomerExcelCreated { path: path_s, added, sheets })
    }

    /// What would be added, what is already in the file, and what cannot be added.
    pub fn customer_excel_preview(&self, customer_id: i64, items: &[ItemRef]) -> AppResult<CustomerExcelPreview> {
        let link = self.require_link(customer_id)?;
        let (resolved, not_allowed) = self.resolve_items(customer_id, items)?;
        let currencies: Vec<String> = {
            let mut c: Vec<String> = resolved.iter().map(|r| r.line.currency.clone()).collect();
            c.sort();
            c.dedup();
            c
        };
        let bytes = Self::read_file(Path::new(&link.path))?;
        let existing = stmt::existing(bytes, &currencies).map_err(|e| AppError::new(ErrorCode::ExcelLayout, e.0))?;
        let mut to_add = vec![];
        let mut duplicates = vec![];
        let mut older = 0;
        for r in resolved {
            let ex = existing.get(&r.line.currency);
            if ex.is_some_and(|e| e.keys.contains(&r.line.key)) {
                duplicates.push(r.preview);
            } else {
                let serial = super::model::value_number(&V::Date(r.line.date), false).unwrap_or(0.0);
                if ex.and_then(|e| e.last_date).is_some_and(|last| serial < last) {
                    older += 1;
                }
                to_add.push(r.preview);
            }
        }
        Ok(CustomerExcelPreview { to_add, duplicates, not_allowed, older_than_last_row: older })
    }

    /// Add items to the linked statement; duplicates (already in the file) are skipped.
    pub fn customer_excel_add(&self, customer_id: i64, items: &[ItemRef]) -> AppResult<CustomerExcelAdded> {
        let link = self.require_link(customer_id)?;
        let path = PathBuf::from(&link.path);
        let customer = { crate::customers::get(&self.conn(), customer_id)? };
        let (resolved, not_allowed) = self.resolve_items(customer_id, items)?;
        if resolved.is_empty() {
            let reason = not_allowed.first().map(|n| n.reason_ar.clone()).unwrap_or_else(|| "لا شيء للإضافة".into());
            return Err(AppError::validation("items", reason));
        }
        let currencies: Vec<String> = {
            let mut c: Vec<String> = resolved.iter().map(|r| r.line.currency.clone()).collect();
            c.sort();
            c.dedup();
            c
        };
        let bytes = Self::read_file(&path)?;
        let layout_err = |e: super::xlsx::Layout| AppError::new(ErrorCode::ExcelLayout, e.0);
        let existing = stmt::existing(bytes.clone(), &currencies).map_err(layout_err)?;
        let mut groups: BTreeMap<String, Vec<Line>> = BTreeMap::new();
        let mut added: Vec<&Resolved> = vec![];
        let mut dup: Vec<&Resolved> = vec![];
        for r in &resolved {
            if existing.get(&r.line.currency).is_some_and(|e| e.keys.contains(&r.line.key)) {
                dup.push(r);
            } else {
                groups.entry(r.line.currency.clone()).or_default().push(r.line.clone());
                added.push(r);
            }
        }
        let mut sheets = vec![];
        if !added.is_empty() {
            let (out, s) =
                stmt::append_lines(bytes, &customer.name, self.clock.today(), &groups).map_err(layout_err)?;
            statement_self_check(&out, &groups).map_err(export_failed)?;
            keep_previous(&path)?;
            save_atomic(&out, &path)?;
            sheets = s;
        }
        // Track what is now in the file (added, and duplicates found there).
        let now = self.now_iso();
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        for r in added.iter().chain(dup.iter()) {
            tx.execute(
                "INSERT OR REPLACE INTO customer_excel_items (customer_id, file_path, item_kind, item_id, currency, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![customer_id, link.path, r.kind.as_str(), r.id, r.line.currency, now],
            )?;
        }
        if !added.is_empty() {
            tx.execute("UPDATE customer_excel SET updated_at = ?1 WHERE customer_id = ?2", params![now, customer_id])?;
        }
        crate::audit::log(
            &tx,
            &now,
            "customer_excel.add",
            "customer",
            Some(customer_id),
            serde_json::json!({ "path": link.path, "added": added.iter().map(|r| (r.kind.as_str(), r.id)).collect::<Vec<_>>(),
                                "duplicates": dup.len() }),
        )?;
        tx.commit()?;
        Ok(CustomerExcelAdded {
            path: link.path,
            added: added.len() as i64,
            skipped_duplicates: dup.len() as i64,
            sheets,
        })
    }
}

/// The new file opens with an independent reader and holds every added key.
fn statement_self_check(bytes: &[u8], groups: &BTreeMap<String, Vec<Line>>) -> Result<(), String> {
    use calamine::{Data, Reader, Xlsx};
    let mut wb: Xlsx<_> = Xlsx::new(std::io::Cursor::new(bytes.to_vec())).map_err(|e| e.to_string())?;
    for (cur, lines) in groups {
        let range = wb.worksheet_range(&stmt::sheet_name(cur)).map_err(|e| e.to_string())?;
        let keys: std::collections::HashSet<String> = range
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
