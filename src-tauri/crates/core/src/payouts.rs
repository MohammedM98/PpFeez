//! SPEC §4.8 / §6.5: transfers numbered per customer and currency, payouts that cover a set of
//! transfers (and unsettled returns), the eight-figure summary and the debit/credit statement.
//!
//! Money rules: a payout is a `payout` ledger entry (negative) written only when the payout is
//! sent; a draft holds its transfers without touching the balance; cancelling a sent payout
//! appends a reversal entry. Ledger entries are never updated.

use crate::audit;
use crate::clock::{date_str, parse_date};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::excel::customer::ItemKind;
use crate::ledger::{self, get_entry, LedgerEntry, LedgerType, PayoutMethod};
use crate::money::{format_amount, ltr, normalize_currency, parse_positive};
use crate::transactions::{self, get_dto, load_row, BulkResult, HoldStatus, Period, Transaction, TxnStatus};
use crate::Core;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayoutStatus {
    Draft,
    Sent,
    Cancelled,
}

impl PayoutStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PayoutStatus::Draft => "draft",
            PayoutStatus::Sent => "sent",
            PayoutStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "sent" => PayoutStatus::Sent,
            "cancelled" => PayoutStatus::Cancelled,
            _ => PayoutStatus::Draft,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutDetails {
    pub method: PayoutMethod,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub network: Option<String>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

impl PayoutDetails {
    fn cleaned(&self) -> PayoutDetails {
        let c = |s: &Option<String>| s.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
        PayoutDetails {
            method: self.method,
            platform: c(&self.platform),
            network: c(&self.network),
            destination: c(&self.destination),
            reference: c(&self.reference),
            note: c(&self.note),
        }
    }

    /// "USDT — Binance TRC20"
    pub fn label_ar(&self) -> String {
        let mut s = self.method.label_ar().to_string();
        if let Some(p) = &self.platform {
            s.push_str(" — ");
            s.push_str(p);
        }
        if let Some(n) = &self.network {
            s.push(' ');
            s.push_str(n);
        }
        s
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutItemIds {
    pub txns: Vec<i64>,
    pub ledger: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payout {
    pub id: i64,
    pub customer_id: i64,
    pub currency: String,
    pub seq: i64,
    pub status: PayoutStatus,
    pub amount_minor: i64,
    pub due_minor: i64,
    pub date: String,
    pub range_label: String,
    pub details: PayoutDetails,
    pub txn_count: i64,
    /// Sent payouts up to and including this one (this one counts only when sent).
    pub cumulative_paid_minor: i64,
    pub ledger_entry_id: Option<i64>,
    pub item_ids: PayoutItemIds,
    pub in_customer_excel: bool,
    /// SPEC §6.8.3: exported / pending / not_exported in the linked statement.
    pub excel_status: crate::excel::customer::ExcelStatus,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PayoutSelection {
    Unpaid,
    Range {
        from: i64,
        to: i64,
    },
    Ids {
        #[serde(rename = "txnIds")]
        txn_ids: Vec<i64>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlreadyPaid {
    pub txn: Transaction,
    pub payout_seq: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutPreparation {
    pub included: Vec<Transaction>,
    pub returned: Vec<LedgerEntry>,
    pub already_paid: Vec<AlreadyPaid>,
    pub excluded_held: Vec<Transaction>,
    pub missing_seqs: Vec<i64>,
    pub found_count: i64,
    pub counted_count: i64,
    pub returned_count: i64,
    pub gross_minor: i64,
    pub net_paypal_minor: i64,
    pub commission_minor: i64,
    pub due_minor: i64,
    pub range_label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreateStatus {
    Draft,
    Sent,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutCreateInput {
    pub currency: String,
    #[serde(default)]
    pub txn_ids: Vec<i64>,
    #[serde(default)]
    pub returned_entry_ids: Vec<i64>,
    #[serde(default)]
    pub amount_text: Option<String>,
    #[serde(default)]
    pub difference_reason: Option<String>,
    pub date: String,
    pub details: PayoutDetails,
    pub status: CreateStatus,
    #[serde(default)]
    pub matched_confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerSummary {
    pub currency: String,
    pub net_completed_minor: i64,
    pub sent_minor: i64,
    pub remaining_minor: i64,
    pub not_paid_count: i64,
    pub gross_before_commission_minor: i64,
    pub commission_minor: i64,
    pub txn_count: i64,
    pub paid_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StatementRow {
    Txn { txn: Box<Transaction>, running_balance_minor: i64 },
    Payout { payout: Box<Payout>, running_balance_minor: i64 },
    Entry { entry: Box<LedgerEntry>, running_balance_minor: i64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StatementShow {
    #[default]
    All,
    Unpaid,
    Paid,
    Payouts,
    /// SPEC 6.8.3: lines not (yet) in the customer's linked Excel statement.
    NotExported,
    /// SPEC 4.9: approved transfers only.
    Transfers,
}

/// SPEC §4.9: one row of the payout register (standalone and linked payouts, one numbering).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutRegisterRow {
    pub seq: i64,
    pub kind: PayoutKind,
    pub ledger_entry_id: Option<i64>,
    pub payout_id: Option<i64>,
    pub date: String,
    pub amount_minor: i64,
    pub method: PayoutMethod,
    pub platform: Option<String>,
    pub network: Option<String>,
    pub destination: Option<String>,
    pub reference: Option<String>,
    pub note: Option<String>,
    pub status: PayoutStatus,
    pub cumulative_paid_minor: i64,
    pub range_label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PayoutKind {
    Standalone,
    Linked,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementFilter {
    #[serde(default)]
    pub show: Option<StatementShow>,
    #[serde(default)]
    pub period: Option<Period>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerStatement {
    pub opening_balance_minor: i64,
    pub rows: Vec<StatementRow>,
    pub closing_balance_minor: i64,
}

// ===== Helpers =====

/// "(13-40)", "(99-119) بدون 113، 115", "(7)"; empty without transfers.
pub fn range_label(seqs: &[i64]) -> String {
    let set: BTreeSet<i64> = seqs.iter().copied().collect();
    let (Some(&min), Some(&max)) = (set.first(), set.last()) else { return String::new() };
    if min == max {
        return format!("({min})");
    }
    let missing: Vec<String> = (min..=max).filter(|n| !set.contains(n)).map(|n| n.to_string()).collect();
    if missing.is_empty() {
        format!("({min}-{max})")
    } else {
        format!("({min}-{max}) بدون {}", missing.join("، "))
    }
}

fn validate_date(s: &str) -> AppResult<String> {
    parse_date(s).map(date_str).ok_or_else(|| AppError::validation("date", "التاريخ غير صالح (YYYY-MM-DD)"))
}

fn payout_from_row(r: &Row<'_>) -> rusqlite::Result<Payout> {
    Ok(Payout {
        id: r.get("id")?,
        customer_id: r.get("customer_id")?,
        currency: r.get("currency")?,
        seq: r.get("payout_seq")?,
        status: PayoutStatus::parse(&r.get::<_, String>("status")?),
        amount_minor: r.get("amount_minor")?,
        due_minor: r.get("due_minor")?,
        date: r.get("payout_date")?,
        range_label: r.get("range_label")?,
        details: PayoutDetails {
            method: PayoutMethod::parse(&r.get::<_, String>("method")?).unwrap_or(PayoutMethod::Other),
            platform: r.get("platform")?,
            network: r.get("network")?,
            destination: r.get("destination")?,
            reference: r.get("reference")?,
            note: r.get("note")?,
        },
        txn_count: 0,
        cumulative_paid_minor: 0,
        ledger_entry_id: r.get("ledger_entry_id")?,
        item_ids: PayoutItemIds { txns: vec![], ledger: vec![] },
        in_customer_excel: false,
        excel_status: crate::excel::customer::ExcelStatus::NotExported,
        created_at: r.get("created_at")?,
    })
}

pub(crate) fn get_payout(conn: &Connection, id: i64) -> AppResult<Payout> {
    let mut p = conn
        .query_row("SELECT * FROM payouts WHERE id = ?1", params![id], payout_from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("الدفعة"))?;
    let mut stmt = conn.prepare("SELECT item_kind, item_id FROM payout_items WHERE payout_id = ?1 ORDER BY item_id")?;
    let rows = stmt.query_map(params![id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (kind, item) = row?;
        if kind == "txn" {
            p.item_ids.txns.push(item);
        } else {
            p.item_ids.ledger.push(item);
        }
    }
    p.txn_count = p.item_ids.txns.len() as i64;
    p.cumulative_paid_minor = conn.query_row(
        "SELECT COALESCE(SUM(amount_minor),0) FROM payouts
         WHERE customer_id = ?1 AND currency = ?2 AND status = 'sent' AND payout_seq <= ?3",
        params![p.customer_id, p.currency, p.seq],
        |r| r.get(0),
    )?;
    p.excel_status =
        crate::excel::customer::item_status(conn, p.customer_id, crate::excel::customer::ItemKind::Payout, p.id)?;
    p.in_customer_excel = p.excel_status == crate::excel::customer::ExcelStatus::Exported;
    Ok(p)
}

/// Seq of the draft/sent payout that holds a ledger entry (a return).
fn entry_payout_seq(conn: &Connection, entry_id: i64) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT p.payout_seq FROM payout_items i JOIN payouts p ON p.id = i.payout_id
             WHERE i.item_kind = 'ledger' AND i.item_id = ?1 AND p.status <> 'cancelled' LIMIT 1",
            params![entry_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Returns (refunds / chargebacks confirmed on the customer: negative reversal entries that do
/// not reverse another entry), not reversed and not in a draft/sent payout.
fn unsettled_returns(conn: &Connection, customer_id: i64, currency: &str) -> AppResult<Vec<LedgerEntry>> {
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT e.id FROM ledger_entries e
             WHERE e.customer_id = ?1 AND e.currency = ?2 AND e.type = 'reversal' AND e.reverses_entry_id IS NULL
               AND e.amount_minor < 0 AND e.payout_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = e.id)
               AND NOT EXISTS (SELECT 1 FROM payout_items i JOIN payouts p ON p.id = i.payout_id
                               WHERE i.item_kind = 'ledger' AND i.item_id = e.id AND p.status <> 'cancelled')
             ORDER BY e.entry_date, e.id",
        )?;
        let v = stmt.query_map(params![customer_id, currency], |r| r.get(0))?.collect::<Result<_, _>>()?;
        v
    };
    ids.into_iter().map(|id| get_entry(conn, id)).collect()
}

/// Approved transfers of a customer in a currency, by number.
fn approved_ids(conn: &Connection, customer_id: i64, currency: &str) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM paypal_transactions WHERE customer_id = ?1 AND currency = ?2 AND status = 'approved'
         ORDER BY customer_seq, id",
    )?;
    let v = stmt.query_map(params![customer_id, currency], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(v)
}

fn is_held(t: &Transaction) -> bool {
    t.hold_status == Some(HoldStatus::OnHold)
}

fn ensure_customer(conn: &Connection, id: i64) -> AppResult<()> {
    crate::customers::customer_ref(conn, id).map(|_| ())
}

/// SPEC §4.9: the next payout number of a customer in a currency, shared by linked payouts and
/// standalone ones (ledger payouts recorded with `ledger_add_payout`).
pub(crate) fn next_payout_seq(conn: &Connection, customer_id: i64, currency: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(s), 0) + 1 FROM (
           SELECT payout_seq AS s FROM payouts WHERE customer_id = ?1 AND currency = ?2
           UNION ALL SELECT payout_seq FROM standalone_payouts WHERE customer_id = ?1 AND currency = ?2)",
        params![customer_id, currency],
        |r| r.get(0),
    )?)
}

pub(crate) fn save_defaults(conn: &Connection, customer_id: i64, d: &PayoutDetails) -> AppResult<()> {
    conn.execute(
        "INSERT INTO customer_payout_defaults (customer_id, method, platform, network, destination)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(customer_id) DO UPDATE SET method = excluded.method, platform = excluded.platform,
           network = excluded.network, destination = excluded.destination",
        params![customer_id, d.method.as_str(), d.platform, d.network, d.destination],
    )?;
    Ok(())
}

/// Write the payout's ledger entry and mark it sent.
fn send_in(conn: &Connection, now: &str, payout: &Payout, date: &str) -> AppResult<i64> {
    let d = &payout.details;
    let mut description = format!("دفعة {} — {}", payout.seq, d.label_ar());
    if !payout.range_label.is_empty() {
        description.push(' ');
        description.push_str(&payout.range_label);
    }
    conn.execute(
        "INSERT INTO ledger_entries (customer_id, currency, type, amount_minor, payout_method, reference, description,
         entry_date, created_at, payout_platform, payout_network, payout_destination, payout_id)
         VALUES (?1, ?2, 'payout', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            payout.customer_id,
            payout.currency,
            -payout.amount_minor,
            d.method.as_str(),
            d.reference,
            description,
            date,
            now,
            d.platform,
            d.network,
            d.destination,
            payout.id
        ],
    )?;
    let entry_id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE payouts SET status = 'sent', ledger_entry_id = ?1, payout_date = ?2, updated_at = ?3 WHERE id = ?4",
        params![entry_id, date, now, payout.id],
    )?;
    crate::excel::customer::enqueue(
        conn,
        now,
        payout.customer_id,
        crate::excel::customer::ItemKind::Payout,
        payout.id,
        None,
        None,
    )?;
    Ok(entry_id)
}

impl Core {
    pub fn payout_prepare(
        &self,
        customer_id: i64,
        currency: &str,
        selection: &PayoutSelection,
    ) -> AppResult<PayoutPreparation> {
        let currency = normalize_currency(currency)?;
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        let mut missing_seqs = vec![];
        let candidates: Vec<Transaction> = match selection {
            PayoutSelection::Unpaid => approved_ids(&conn, customer_id, &currency)?
                .into_iter()
                .map(|id| get_dto(&conn, id))
                .collect::<AppResult<Vec<_>>>()?
                .into_iter()
                .filter(|t| t.payout.is_none())
                .collect(),
            PayoutSelection::Range { from, to } => {
                if from > to || *from < 1 {
                    return Err(AppError::validation("range", "النطاق غير صالح"));
                }
                let all: Vec<Transaction> = approved_ids(&conn, customer_id, &currency)?
                    .into_iter()
                    .map(|id| get_dto(&conn, id))
                    .collect::<AppResult<Vec<_>>>()?;
                let in_range: Vec<Transaction> =
                    all.into_iter().filter(|t| t.customer_seq.is_some_and(|s| s >= *from && s <= *to)).collect();
                let found: BTreeSet<i64> = in_range.iter().filter_map(|t| t.customer_seq).collect();
                missing_seqs = (*from..=*to).filter(|n| !found.contains(n)).collect();
                in_range
            }
            PayoutSelection::Ids { txn_ids } => {
                let mut v = vec![];
                for &id in txn_ids {
                    let t = get_dto(&conn, id)?;
                    if t.status == TxnStatus::Approved
                        && t.currency == currency
                        && t.customer.as_ref().map(|c| c.id) == Some(customer_id)
                    {
                        v.push(t);
                    }
                }
                v.sort_by_key(|t| t.customer_seq);
                v
            }
        };
        let found_count = candidates.len() as i64;
        let mut included = vec![];
        let mut already_paid = vec![];
        let mut excluded_held = vec![];
        for t in candidates {
            if let Some(p) = &t.payout {
                let seq = p.seq;
                already_paid.push(AlreadyPaid { txn: t, payout_seq: seq });
            } else if is_held(&t) {
                excluded_held.push(t);
            } else {
                included.push(t);
            }
        }
        let returned = unsettled_returns(&conn, customer_id, &currency)?;
        let sum = |f: fn(&Transaction) -> Option<i64>| included.iter().filter_map(f).sum::<i64>();
        let gross: i64 = included.iter().map(|t| t.gross_minor).sum();
        let net = sum(|t| t.net_minor);
        let commission = sum(|t| t.commission_minor);
        let due = sum(|t| t.customer_amount_minor) + returned.iter().map(|e| e.amount_minor).sum::<i64>();
        let seqs: Vec<i64> = included.iter().filter_map(|t| t.customer_seq).collect();
        Ok(PayoutPreparation {
            counted_count: included.len() as i64,
            returned_count: returned.len() as i64,
            range_label: range_label(&seqs),
            included,
            returned,
            already_paid,
            excluded_held,
            missing_seqs,
            found_count,
            gross_minor: gross,
            net_paypal_minor: net,
            commission_minor: commission,
            due_minor: due,
        })
    }

    pub fn payout_create(&self, customer_id: i64, input: PayoutCreateInput) -> AppResult<Payout> {
        let currency = normalize_currency(&input.currency)?;
        let date = validate_date(&input.date)?;
        let details = input.details.cleaned();
        if !input.matched_confirmed {
            return Err(AppError::validation("matched", "أكّد أنك راجعت الحوالات وأنها مطابقة قبل الحفظ"));
        }
        let now = self.now_iso();
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        let mut txns: Vec<Transaction> = vec![];
        let mut overlap: Vec<(i64, i64)> = vec![];
        let mut seen = BTreeSet::new();
        for &id in &input.txn_ids {
            if !seen.insert(id) {
                continue;
            }
            let t = get_dto(&conn, id)?;
            if t.customer.as_ref().map(|c| c.id) != Some(customer_id) || t.currency != currency {
                return Err(AppError::validation("txnIds", "الحوالة ليست لهذا العميل بهذه العملة"));
            }
            if t.status != TxnStatus::Approved {
                return Err(AppError::invalid_transition("تُدفع الحوالات المعتمدة فقط"));
            }
            if is_held(&t) {
                return Err(AppError::invalid_transition(format!(
                    "الحوالة #{} محجوزة لدى PayPal؛ تُدفع بعد فك الحجز",
                    t.customer_seq.unwrap_or_default()
                )));
            }
            if let Some(p) = &t.payout {
                overlap.push((t.customer_seq.unwrap_or_default(), p.seq));
            }
            txns.push(t);
        }
        if !overlap.is_empty() {
            let list: Vec<String> = overlap.iter().map(|(s, p)| format!("#{s} (الدفعة {p})")).collect();
            return Err(AppError::validation(
                "overlap",
                format!("حوالات مدفوعة سابقاً ولا تُدفع مرتين: {}", list.join("، ")),
            ));
        }
        let mut returns: Vec<LedgerEntry> = vec![];
        for &id in &input.returned_entry_ids {
            let e = get_entry(&conn, id)?;
            let is_return = e.kind == LedgerType::Reversal && e.reverses_entry_id.is_none() && e.amount_minor < 0;
            if e.customer_id != customer_id || e.currency != currency || !is_return || e.reversed_by_entry_id.is_some()
            {
                return Err(AppError::validation("returnedEntryIds", "القيد ليس مرتجعاً قائماً لهذا العميل بهذه العملة"));
            }
            if let Some(seq) = entry_payout_seq(&conn, id)? {
                return Err(AppError::validation("overlap", format!("المرتجع محسوب سابقاً في الدفعة {seq}")));
            }
            returns.push(e);
        }
        if txns.is_empty() && returns.is_empty() {
            return Err(AppError::validation("txnIds", "اختر حوالة واحدة على الأقل"));
        }
        let due: i64 = txns.iter().filter_map(|t| t.customer_amount_minor).sum::<i64>()
            + returns.iter().map(|e| e.amount_minor).sum::<i64>();
        let amount = match input.amount_text.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(t) => parse_positive(t, &currency, "amountText")?,
            None => due,
        };
        if amount <= 0 {
            return Err(AppError::validation("amountText", "المستحق صفر أو أقل؛ أدخل المبلغ المدفوع"));
        }
        let reason = input.difference_reason.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        if amount != due && reason.is_none() {
            return Err(AppError::validation(
                "difference_reason",
                format!(
                    "المبلغ يختلف عن المستحق ({})؛ اكتب السبب. الفرق يبقى في رصيد العميل",
                    ltr(&format_amount(due, &currency))
                ),
            ));
        }
        let seqs: Vec<i64> = txns.iter().filter_map(|t| t.customer_seq).collect();
        let label = range_label(&seqs);
        let tx = conn.unchecked_transaction()?;
        let seq = next_payout_seq(&tx, customer_id, &currency)?;
        tx.execute(
            "INSERT INTO payouts (customer_id, currency, payout_seq, status, amount_minor, due_minor, method, platform,
             network, destination, reference, note, difference_reason, range_label, payout_date, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
            params![
                customer_id,
                currency,
                seq,
                amount,
                due,
                details.method.as_str(),
                details.platform,
                details.network,
                details.destination,
                details.reference,
                details.note,
                reason,
                label,
                date,
                now
            ],
        )?;
        let payout_id = tx.last_insert_rowid();
        for t in &txns {
            tx.execute(
                "INSERT INTO payout_items (payout_id, item_kind, item_id) VALUES (?1, 'txn', ?2)",
                params![payout_id, t.id],
            )?;
        }
        for e in &returns {
            tx.execute(
                "INSERT INTO payout_items (payout_id, item_kind, item_id) VALUES (?1, 'ledger', ?2)",
                params![payout_id, e.id],
            )?;
        }
        let entry_id = if input.status == CreateStatus::Sent {
            Some(send_in(&tx, &now, &get_payout(&tx, payout_id)?, &date)?)
        } else {
            None
        };
        save_defaults(&tx, customer_id, &details)?;
        audit::log(
            &tx,
            &now,
            "payout.create",
            "payout",
            Some(payout_id),
            json!({ "customerId": customer_id, "currency": currency, "seq": seq, "amountMinor": amount, "dueMinor": due,
                    "txnIds": txns.iter().map(|t| t.id).collect::<Vec<_>>(),
                    "returnedEntryIds": returns.iter().map(|e| e.id).collect::<Vec<_>>(),
                    "status": if entry_id.is_some() { "sent" } else { "draft" }, "ledgerEntryId": entry_id,
                    "differenceReason": reason }),
        )?;
        tx.commit()?;
        get_payout(&conn, payout_id)
    }

    pub fn payout_mark_sent(&self, payout_id: i64, date: Option<&str>) -> AppResult<Payout> {
        let now = self.now_iso();
        let conn = self.conn();
        let p = get_payout(&conn, payout_id)?;
        if p.status != PayoutStatus::Draft {
            return Err(AppError::invalid_transition("الدفعة ليست «مسجلة»"));
        }
        let date = match date.map(str::trim).filter(|s| !s.is_empty()) {
            Some(d) => validate_date(d)?,
            None => p.date.clone(),
        };
        let tx = conn.unchecked_transaction()?;
        let entry_id = send_in(&tx, &now, &p, &date)?;
        audit::log(
            &tx,
            &now,
            "payout.send",
            "payout",
            Some(payout_id),
            json!({ "ledgerEntryId": entry_id, "date": date }),
        )?;
        tx.commit()?;
        get_payout(&conn, payout_id)
    }

    /// Method, platform, network, destination, reference and note only; the ledger entry of a
    /// sent payout keeps what was recorded when it was sent (entries are immutable).
    pub fn payout_update_details(&self, payout_id: i64, details: PayoutDetails) -> AppResult<Payout> {
        let now = self.now_iso();
        let d = details.cleaned();
        let conn = self.conn();
        let before = get_payout(&conn, payout_id)?;
        if before.status == PayoutStatus::Cancelled {
            return Err(AppError::invalid_transition("الدفعة ملغاة"));
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE payouts SET method = ?1, platform = ?2, network = ?3, destination = ?4, reference = ?5, note = ?6,
             updated_at = ?7 WHERE id = ?8",
            params![d.method.as_str(), d.platform, d.network, d.destination, d.reference, d.note, now, payout_id],
        )?;
        save_defaults(&tx, before.customer_id, &d)?;
        if before.status == PayoutStatus::Sent {
            crate::excel::customer::requeue(
                &tx,
                &now,
                before.customer_id,
                crate::excel::customer::ItemKind::Payout,
                payout_id,
            )?;
        }
        audit::log(
            &tx,
            &now,
            "payout.update_details",
            "payout",
            Some(payout_id),
            json!({ "before": before.details, "after": d }),
        )?;
        tx.commit()?;
        get_payout(&conn, payout_id)
    }

    /// Cancel: the transfers become unpaid again; a sent payout's entry is reversed.
    pub fn payout_cancel(&self, payout_id: i64, reason: &str) -> AppResult<Payout> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Err(AppError::validation("reason", "سبب إلغاء الدفعة مطلوب"));
        }
        let now = self.now_iso();
        let today = date_str(self.clock.today());
        let conn = self.conn();
        let p = get_payout(&conn, payout_id)?;
        if p.status == PayoutStatus::Cancelled {
            return Err(AppError::invalid_transition("الدفعة ملغاة مسبقاً"));
        }
        let tx = conn.unchecked_transaction()?;
        let reversal = match (p.status, p.ledger_entry_id) {
            (PayoutStatus::Sent, Some(entry)) => Some(ledger::insert_reversal_of(
                &tx,
                &now,
                &today,
                entry,
                &format!("إلغاء الدفعة {}: {reason}", p.seq),
            )?),
            _ => None,
        };
        tx.execute(
            "UPDATE payouts SET status = 'cancelled', cancel_reason = ?1, updated_at = ?2 WHERE id = ?3",
            params![reason, now, payout_id],
        )?;
        if let Some(rev) = reversal {
            crate::excel::customer::on_reversed(
                &tx,
                &now,
                p.customer_id,
                crate::excel::customer::Orig::Payout(payout_id),
                rev,
                None,
            )?;
        }
        audit::log(
            &tx,
            &now,
            "payout.cancel",
            "payout",
            Some(payout_id),
            json!({ "reason": reason, "reversalEntryId": reversal }),
        )?;
        tx.commit()?;
        get_payout(&conn, payout_id)
    }

    /// SPEC §4.9: the payout register: standalone payouts and earlier linked ones, by number, with
    /// the cumulative amount paid (sent, not cancelled) up to each row.
    pub fn payout_register(&self, customer_id: i64, currency: &str) -> AppResult<Vec<PayoutRegisterRow>> {
        let currency = normalize_currency(currency)?;
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        let mut rows = vec![];
        let linked: Vec<i64> = {
            let mut stmt = conn.prepare("SELECT id FROM payouts WHERE customer_id = ?1 AND currency = ?2")?;
            let v = stmt.query_map(params![customer_id, currency], |r| r.get(0))?.collect::<Result<_, _>>()?;
            v
        };
        for id in linked {
            let p = get_payout(&conn, id)?;
            rows.push(PayoutRegisterRow {
                seq: p.seq,
                kind: PayoutKind::Linked,
                ledger_entry_id: p.ledger_entry_id,
                payout_id: Some(p.id),
                date: p.date.clone(),
                amount_minor: p.amount_minor,
                method: p.details.method,
                platform: p.details.platform.clone(),
                network: p.details.network.clone(),
                destination: p.details.destination.clone(),
                reference: p.details.reference.clone(),
                note: p.details.note.clone(),
                status: p.status,
                cumulative_paid_minor: 0,
                range_label: Some(p.range_label.clone()).filter(|l| !l.is_empty()),
            });
        }
        let standalone: Vec<(i64, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT payout_seq, entry_id FROM standalone_payouts WHERE customer_id = ?1 AND currency = ?2",
            )?;
            let v = stmt
                .query_map(params![customer_id, currency], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            v
        };
        for (seq, entry_id) in standalone {
            let e = get_entry(&conn, entry_id)?;
            let method = e.payout_method.unwrap_or(PayoutMethod::Other);
            let note = Some(e.description.clone()).filter(|d| *d != ledger::default_payout_description(method));
            rows.push(PayoutRegisterRow {
                seq,
                kind: PayoutKind::Standalone,
                ledger_entry_id: Some(e.id),
                payout_id: None,
                date: e.entry_date.clone(),
                amount_minor: -e.amount_minor,
                method,
                platform: e.payout_platform.clone(),
                network: e.payout_network.clone(),
                destination: e.payout_destination.clone(),
                reference: e.reference.clone(),
                note,
                status: if e.reversed_by_entry_id.is_some() { PayoutStatus::Cancelled } else { PayoutStatus::Sent },
                cumulative_paid_minor: 0,
                range_label: None,
            });
        }
        rows.sort_by_key(|r| r.seq);
        let mut paid = 0;
        for r in &mut rows {
            if r.status == PayoutStatus::Sent {
                paid += r.amount_minor;
            }
            r.cumulative_paid_minor = paid;
        }
        Ok(rows)
    }

    pub fn payouts_list(&self, customer_id: i64, currency: &str) -> AppResult<Vec<Payout>> {
        let currency = normalize_currency(currency)?;
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        let ids: Vec<i64> = {
            let mut stmt =
                conn.prepare("SELECT id FROM payouts WHERE customer_id = ?1 AND currency = ?2 ORDER BY payout_seq")?;
            let v = stmt.query_map(params![customer_id, currency], |r| r.get(0))?.collect::<Result<_, _>>()?;
            v
        };
        ids.into_iter().map(|id| get_payout(&conn, id)).collect()
    }

    pub fn payout_defaults(&self, customer_id: i64) -> AppResult<Option<PayoutDetails>> {
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        Ok(conn
            .query_row(
                "SELECT method, platform, network, destination FROM customer_payout_defaults WHERE customer_id = ?1",
                params![customer_id],
                |r| {
                    Ok(PayoutDetails {
                        method: PayoutMethod::parse(&r.get::<_, String>(0)?).unwrap_or(PayoutMethod::Other),
                        platform: r.get(1)?,
                        network: r.get(2)?,
                        destination: r.get(3)?,
                        reference: None,
                        note: None,
                    })
                },
            )
            .optional()?)
    }

    /// Platforms / banks used before, most recent first.
    pub fn payout_platform_suggestions(&self) -> AppResult<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT platform, MAX(at) FROM (
               SELECT platform, updated_at AS at FROM payouts WHERE platform IS NOT NULL
               UNION ALL SELECT payout_platform, created_at FROM ledger_entries WHERE payout_platform IS NOT NULL)
             GROUP BY platform ORDER BY MAX(at) DESC LIMIT 50",
        )?;
        let v = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    /// The owner's "matched" mark (SPEC §4.8), approved transfers only; display and filter only.
    pub fn txn_set_matched(&self, ids: &[i64], matched: bool) -> AppResult<BulkResult> {
        let now = self.now_iso();
        let conn = self.conn();
        let mut result = BulkResult::default();
        for &id in ids {
            let r = (|| -> AppResult<()> {
                let row = load_row(&conn, id)?;
                if row.status != TxnStatus::Approved {
                    return Err(AppError::invalid_transition("المطابقة للحوالات المعتمدة فقط"));
                }
                conn.execute(
                    "UPDATE paypal_transactions SET matched = ?1, updated_at = ?2 WHERE id = ?3",
                    params![matched as i64, now, id],
                )?;
                audit::log(&conn, &now, "txn.set_matched", "transaction", Some(id), json!({ "matched": matched }))?;
                Ok(())
            })();
            result.push(id, r);
        }
        Ok(result)
    }

    /// The eight figures of SPEC §4.8 for a customer and currency (held transfers excluded).
    pub fn customer_summary(&self, customer_id: i64, currency: &str) -> AppResult<CustomerSummary> {
        let currency = normalize_currency(currency)?;
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        let base = "FROM paypal_transactions t WHERE t.customer_id = ?1 AND t.currency = ?2 AND t.status = 'approved'
                    AND COALESCE(t.hold_status, '') <> 'on_hold'";
        let (count, cust, net, commission): (i64, i64, i64, i64) = conn.query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM(customer_amount_minor),0), COALESCE(SUM(net_minor),0),
                        COALESCE(SUM(commission_minor),0) {base}"
            ),
            params![customer_id, currency],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let in_payout = |status_clause: &str| -> AppResult<i64> {
            Ok(conn.query_row(
                &format!(
                    "SELECT COUNT(*) {base} AND EXISTS (SELECT 1 FROM payout_items i JOIN payouts p ON p.id = i.payout_id
                     WHERE i.item_kind = 'txn' AND i.item_id = t.id AND {status_clause})"
                ),
                params![customer_id, currency],
                |r| r.get(0),
            )?)
        };
        // A draft payout only reserves its transfers: they stay "not paid" until it is sent, so
        // paid + not paid = transfers (as in the owner's "تم الإرسال؟ نعم/لا" column).
        let paid = in_payout("p.status = 'sent'")?;
        let returns: i64 = conn.query_row(
            "SELECT COALESCE(SUM(e.amount_minor),0) FROM ledger_entries e
             WHERE e.customer_id = ?1 AND e.currency = ?2 AND e.type = 'reversal' AND e.reverses_entry_id IS NULL
               AND e.amount_minor < 0 AND e.payout_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = e.id)",
            params![customer_id, currency],
            |r| r.get(0),
        )?;
        // Payout entries and their reversals (cancelled payouts net to zero).
        let payouts_net: i64 = conn.query_row(
            "SELECT COALESCE(SUM(e.amount_minor),0) FROM ledger_entries e
             WHERE e.customer_id = ?1 AND e.currency = ?2
               AND (e.type = 'payout' OR (e.type = 'reversal' AND e.reverses_entry_id IN
                    (SELECT id FROM ledger_entries WHERE type = 'payout')))",
            params![customer_id, currency],
            |r| r.get(0),
        )?;
        let balance = crate::customers::balance_in(&conn, customer_id, &currency)?;
        Ok(CustomerSummary {
            currency,
            net_completed_minor: cust + returns,
            sent_minor: -payouts_net,
            remaining_minor: balance,
            not_paid_count: count - paid,
            gross_before_commission_minor: net,
            commission_minor: commission,
            txn_count: count,
            paid_count: paid,
        })
    }

    /// Transfers (له), payouts (عليه) and other entries in one table with a running balance.
    pub fn customer_statement(
        &self,
        customer_id: i64,
        currency: &str,
        filter: &StatementFilter,
    ) -> AppResult<CustomerStatement> {
        let currency = normalize_currency(currency)?;
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        let view = ledger::view(&conn, customer_id, &currency, filter.period.as_ref())?;
        let (from, to) = (
            filter.period.as_ref().and_then(|p| p.from.clone()).filter(|s| !s.is_empty()),
            filter.period.as_ref().and_then(|p| p.to.clone()).filter(|s| !s.is_empty()),
        );
        // Payouts without a ledger entry (drafts, or cancelled before being sent), by date.
        let mut pending: Vec<Payout> = {
            let mut stmt = conn.prepare(
                "SELECT id FROM payouts WHERE customer_id = ?1 AND currency = ?2 AND ledger_entry_id IS NULL
                   AND (?3 IS NULL OR payout_date >= ?3) AND (?4 IS NULL OR payout_date <= ?4)
                 ORDER BY payout_date DESC, id DESC",
            )?;
            let ids: Vec<i64> =
                stmt.query_map(params![customer_id, currency, from, to], |r| r.get(0))?.collect::<Result<_, _>>()?;
            ids.into_iter().map(|id| get_payout(&conn, id)).collect::<AppResult<_>>()?
        };
        let show = filter.show.unwrap_or_default();
        let missing = if show == StatementShow::NotExported {
            self.excel_missing(&conn, customer_id)?
        } else {
            Default::default()
        };
        let mut rows: Vec<StatementRow> = vec![];
        let mut running = view.opening_balance_minor;
        let mut push_pending_until = |date: Option<&str>, running: i64, rows: &mut Vec<StatementRow>| {
            while let Some(p) = pending.last() {
                if date.is_some_and(|d| p.date.as_str() > d) {
                    break;
                }
                let p = pending.pop().expect("checked");
                if matches!(show, StatementShow::All | StatementShow::Payouts) {
                    rows.push(StatementRow::Payout { payout: Box::new(p), running_balance_minor: running });
                }
            }
        };
        for e in view.entries {
            push_pending_until(Some(&e.entry_date), running, &mut rows);
            running = e.running_balance_minor;
            let row = if let Some(pid) = e.payout_id {
                StatementRow::Payout { payout: Box::new(get_payout(&conn, pid)?), running_balance_minor: running }
            } else if e.kind == LedgerType::Credit && e.reversed_by_entry_id.is_none() {
                match e.transaction_id {
                    Some(t) => {
                        let txn = get_dto(&conn, t)?;
                        if txn.status == TxnStatus::Approved {
                            StatementRow::Txn { txn: Box::new(txn), running_balance_minor: running }
                        } else {
                            StatementRow::Entry { entry: Box::new(e), running_balance_minor: running }
                        }
                    }
                    None => StatementRow::Entry { entry: Box::new(e), running_balance_minor: running },
                }
            } else {
                StatementRow::Entry { entry: Box::new(e), running_balance_minor: running }
            };
            let keep = match (&row, show) {
                (_, StatementShow::All) => true,
                (StatementRow::Txn { txn, .. }, StatementShow::Unpaid) => txn.payout.is_none(),
                (StatementRow::Txn { txn, .. }, StatementShow::Paid) => {
                    txn.payout.as_ref().is_some_and(|p| p.status == PayoutStatus::Sent.as_str())
                }
                (StatementRow::Payout { .. }, StatementShow::Payouts) => true,
                (StatementRow::Txn { .. }, StatementShow::Transfers) => true,
                (StatementRow::Entry { entry, .. }, StatementShow::Payouts) => entry.kind == LedgerType::Payout,
                (StatementRow::Txn { txn, .. }, StatementShow::NotExported) => {
                    missing.contains(&(ItemKind::Txn, txn.id))
                }
                (StatementRow::Payout { payout, .. }, StatementShow::NotExported) => {
                    missing.contains(&(ItemKind::Payout, payout.id))
                }
                (StatementRow::Entry { entry, .. }, StatementShow::NotExported) => {
                    missing.contains(&(ItemKind::Ledger, entry.id))
                }
                _ => false,
            };
            if keep {
                rows.push(row);
            }
        }
        push_pending_until(None, running, &mut rows);
        let _ = ErrorCode::Internal;
        Ok(CustomerStatement {
            opening_balance_minor: view.opening_balance_minor,
            rows,
            closing_balance_minor: running,
        })
    }
}

/// Is a transfer covered by a draft or sent payout (re-exported for other modules).
pub fn txn_in_payout(conn: &Connection, txn_id: i64) -> AppResult<bool> {
    Ok(transactions::payout_of(conn, txn_id)?.is_some())
}
