//! Append-only customer ledger (SPEC §3, §4.5, §6.5): one balance per currency, payouts,
//! adjustments, entry reversal, running balance, CSV export and statements.

use crate::audit;
use crate::clock::{date_str, parse_date};
use crate::customers::{self, balance_in, Customer};
use crate::error::{is_unique_violation, AppError, AppResult, ErrorCode};
use crate::money::{format_amount, format_plain, normalize_currency, parse_positive};
use crate::transactions::{Period, TxnStatus, TxnType};
use crate::Core;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LedgerType {
    Credit,
    Payout,
    Adjustment,
    Reversal,
}

impl LedgerType {
    pub fn parse(s: &str) -> Self {
        match s {
            "credit" => LedgerType::Credit,
            "payout" => LedgerType::Payout,
            "adjustment" => LedgerType::Adjustment,
            _ => LedgerType::Reversal,
        }
    }

    pub fn label_ar(self) -> &'static str {
        match self {
            LedgerType::Credit => "اعتماد دفعة",
            LedgerType::Payout => "دفعة للعميل",
            LedgerType::Adjustment => "تسوية",
            LedgerType::Reversal => "عكس",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayoutMethod {
    Cash,
    Bank,
    Usdt,
    Paypal,
    Other,
}

impl PayoutMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            PayoutMethod::Cash => "cash",
            PayoutMethod::Bank => "bank",
            PayoutMethod::Usdt => "usdt",
            PayoutMethod::Paypal => "paypal",
            PayoutMethod::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "cash" => Some(PayoutMethod::Cash),
            "bank" => Some(PayoutMethod::Bank),
            "usdt" => Some(PayoutMethod::Usdt),
            "paypal" => Some(PayoutMethod::Paypal),
            "other" => Some(PayoutMethod::Other),
            _ => None,
        }
    }

    pub fn label_ar(self) -> &'static str {
        match self {
            PayoutMethod::Cash => "نقداً",
            PayoutMethod::Bank => "تحويل بنكي",
            PayoutMethod::Usdt => "USDT",
            PayoutMethod::Paypal => "PayPal",
            PayoutMethod::Other => "أخرى",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub id: i64,
    pub customer_id: i64,
    pub currency: String,
    #[serde(rename = "type")]
    pub kind: LedgerType,
    pub amount_minor: i64,
    pub running_balance_minor: i64,
    pub transaction_id: Option<i64>,
    pub reverses_entry_id: Option<i64>,
    pub reversed_by_entry_id: Option<i64>,
    pub payout_method: Option<PayoutMethod>,
    pub reference: Option<String>,
    pub description: String,
    pub entry_date: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceCard {
    pub currency: String,
    pub credits_minor: i64,
    pub debits_minor: i64,
    pub balance_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerView {
    pub opening_balance_minor: i64,
    pub entries: Vec<LedgerEntry>,
    pub closing_balance_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    pub customer: Customer,
    pub view: LedgerView,
    pub generated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutInput {
    pub currency: String,
    pub amount_text: String,
    pub entry_date: String,
    pub method: PayoutMethod,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub confirm_overdraw: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Credit,
    Debit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentInput {
    pub currency: String,
    pub amount_text: String,
    pub direction: Direction,
    pub entry_date: String,
    pub description: String,
}

const SELECT: &str = "SELECT e.*, (SELECT r.id FROM ledger_entries r WHERE r.reverses_entry_id = e.id) AS reversed_by
     FROM ledger_entries e";

fn entry_from_row(r: &Row<'_>) -> rusqlite::Result<LedgerEntry> {
    Ok(LedgerEntry {
        id: r.get("id")?,
        customer_id: r.get("customer_id")?,
        currency: r.get("currency")?,
        kind: LedgerType::parse(&r.get::<_, String>("type")?),
        amount_minor: r.get("amount_minor")?,
        running_balance_minor: 0,
        transaction_id: r.get("paypal_transaction_id")?,
        reverses_entry_id: r.get("reverses_entry_id")?,
        reversed_by_entry_id: r.get("reversed_by")?,
        payout_method: r.get::<_, Option<String>>("payout_method")?.and_then(|m| PayoutMethod::parse(&m)),
        reference: r.get("reference")?,
        description: r.get("description")?,
        entry_date: r.get("entry_date")?,
        created_at: r.get("created_at")?,
    })
}

pub fn get_entry(conn: &Connection, id: i64) -> AppResult<LedgerEntry> {
    let mut e = conn
        .query_row(&format!("{SELECT} WHERE e.id = ?1"), params![id], entry_from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("القيد"))?;
    // Running balance up to and including this entry, in entry order.
    e.running_balance_minor = conn.query_row(
        "SELECT COALESCE(SUM(amount_minor),0) FROM ledger_entries
         WHERE customer_id = ?1 AND currency = ?2 AND (entry_date < ?3 OR (entry_date = ?3 AND id <= ?4))",
        params![e.customer_id, e.currency, e.entry_date, e.id],
        |r| r.get(0),
    )?;
    Ok(e)
}

fn validate_date(s: &str) -> AppResult<String> {
    parse_date(s).map(date_str).ok_or_else(|| AppError::validation("entryDate", "التاريخ غير صالح (YYYY-MM-DD)"))
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn ensure_customer(conn: &Connection, id: i64) -> AppResult<()> {
    customers::customer_ref(conn, id).map(|_| ())
}

pub(crate) fn view(
    conn: &Connection,
    customer_id: i64,
    currency: &str,
    period: Option<&Period>,
) -> AppResult<LedgerView> {
    let from = period.and_then(|p| p.from.as_deref()).map(str::trim).filter(|s| !s.is_empty());
    let to = period.and_then(|p| p.to.as_deref()).map(str::trim).filter(|s| !s.is_empty());
    let from = match from {
        Some(f) => {
            Some(parse_date(f).map(date_str).ok_or_else(|| AppError::validation("period.from", "التاريخ غير صالح"))?)
        }
        None => None,
    };
    let to = match to {
        Some(t) => {
            Some(parse_date(t).map(date_str).ok_or_else(|| AppError::validation("period.to", "التاريخ غير صالح"))?)
        }
        None => None,
    };
    let opening: i64 = match &from {
        Some(f) => conn.query_row(
            "SELECT COALESCE(SUM(amount_minor),0) FROM ledger_entries WHERE customer_id = ?1 AND currency = ?2 AND entry_date < ?3",
            params![customer_id, currency, f],
            |r| r.get(0),
        )?,
        None => 0,
    };
    let mut stmt = conn.prepare(&format!(
        "{SELECT} WHERE e.customer_id = ?1 AND e.currency = ?2
           AND (?3 IS NULL OR e.entry_date >= ?3) AND (?4 IS NULL OR e.entry_date <= ?4)
         ORDER BY e.entry_date, e.id"
    ))?;
    let rows = stmt.query_map(params![customer_id, currency, from, to], entry_from_row)?;
    let mut running = opening;
    let mut entries = vec![];
    for r in rows {
        let mut e = r?;
        running += e.amount_minor;
        e.running_balance_minor = running;
        entries.push(e);
    }
    Ok(LedgerView { opening_balance_minor: opening, entries, closing_balance_minor: running })
}

pub(crate) fn insert_reversal_of(
    conn: &Connection,
    now: &str,
    today: &str,
    entry_id: i64,
    reason: &str,
) -> AppResult<i64> {
    let orig = get_entry(conn, entry_id)?;
    if orig.reversed_by_entry_id.is_some() {
        return Err(AppError::new(ErrorCode::AlreadyReversed, "هذا القيد معكوس مسبقاً"));
    }
    conn.execute(
        "INSERT INTO ledger_entries (customer_id, currency, type, amount_minor, paypal_transaction_id,
         reverses_entry_id, reference, description, entry_date, created_at)
         VALUES (?1, ?2, 'reversal', ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            orig.customer_id,
            orig.currency,
            -orig.amount_minor,
            orig.transaction_id,
            entry_id,
            orig.reference,
            format!("عكس: {} — السبب: {reason}", orig.description),
            today,
            now
        ],
    )
    .map_err(|e| {
        if is_unique_violation(&e) {
            AppError::new(ErrorCode::AlreadyReversed, "هذا القيد معكوس مسبقاً")
        } else {
            e.into()
        }
    })?;
    Ok(conn.last_insert_rowid())
}

impl Core {
    pub fn ledger_balances(&self, customer_id: i64) -> AppResult<Vec<BalanceCard>> {
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        let mut stmt = conn.prepare(
            "SELECT currency,
                    COALESCE(SUM(CASE WHEN amount_minor > 0 THEN amount_minor END), 0),
                    COALESCE(SUM(CASE WHEN amount_minor < 0 THEN -amount_minor END), 0),
                    SUM(amount_minor)
             FROM ledger_entries WHERE customer_id = ?1 GROUP BY currency ORDER BY currency",
        )?;
        let rows = stmt.query_map(params![customer_id], |r| {
            Ok(BalanceCard {
                currency: r.get(0)?,
                credits_minor: r.get(1)?,
                debits_minor: r.get(2)?,
                balance_minor: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn ledger_entries(&self, customer_id: i64, currency: &str, period: Option<&Period>) -> AppResult<LedgerView> {
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        view(&conn, customer_id, &normalize_currency(currency)?, period)
    }

    pub fn ledger_add_payout(&self, customer_id: i64, input: PayoutInput) -> AppResult<LedgerEntry> {
        let currency = normalize_currency(&input.currency)?;
        let amount = parse_positive(&input.amount_text, &currency, "amountText")?;
        let entry_date = validate_date(&input.entry_date)?;
        let now = self.now_iso();
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        let balance = balance_in(&conn, customer_id, &currency)?;
        if balance - amount < 0 && !input.confirm_overdraw.unwrap_or(false) {
            return Err(AppError::validation(
                "overdraw",
                format!(
                    "الدفعة ({}) أكبر من رصيد العميل ({}). أكّد للمتابعة وسيصبح الرصيد سالباً (عليه)",
                    format_amount(amount, &currency),
                    format_amount(balance, &currency)
                ),
            ));
        }
        let description =
            clean(input.description.clone()).unwrap_or_else(|| format!("دفعة للعميل — {}", input.method.label_ar()));
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO ledger_entries (customer_id, currency, type, amount_minor, payout_method, reference,
             description, entry_date, created_at) VALUES (?1, ?2, 'payout', ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                customer_id,
                currency,
                -amount,
                input.method.as_str(),
                clean(input.reference.clone()),
                description,
                entry_date,
                now
            ],
        )?;
        let id = tx.last_insert_rowid();
        audit::log(
            &tx,
            &now,
            "ledger.payout",
            "ledger_entry",
            Some(id),
            json!({ "customerId": customer_id, "currency": currency, "amountMinor": -amount, "method": input.method.as_str(),
                    "overdraw": balance - amount < 0 }),
        )?;
        tx.commit()?;
        get_entry(&conn, id)
    }

    pub fn ledger_add_adjustment(&self, customer_id: i64, input: AdjustmentInput) -> AppResult<LedgerEntry> {
        let currency = normalize_currency(&input.currency)?;
        let amount = parse_positive(&input.amount_text, &currency, "amountText")?;
        let signed = match input.direction {
            Direction::Credit => amount,
            Direction::Debit => -amount,
        };
        let entry_date = validate_date(&input.entry_date)?;
        let description = input.description.trim().to_string();
        if description.is_empty() {
            return Err(AppError::validation("description", "وصف التسوية مطلوب"));
        }
        let now = self.now_iso();
        let conn = self.conn();
        ensure_customer(&conn, customer_id)?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO ledger_entries (customer_id, currency, type, amount_minor, description, entry_date, created_at)
             VALUES (?1, ?2, 'adjustment', ?3, ?4, ?5, ?6)",
            params![customer_id, currency, signed, description, entry_date, now],
        )?;
        let id = tx.last_insert_rowid();
        audit::log(
            &tx,
            &now,
            "ledger.adjustment",
            "ledger_entry",
            Some(id),
            json!({ "customerId": customer_id, "currency": currency, "amountMinor": signed, "description": description }),
        )?;
        tx.commit()?;
        get_entry(&conn, id)
    }

    /// Reverse any entry that is not reversed yet. Entries that belong to an approval
    /// (the credit and its unapprove reversal) are managed by approve/unapprove instead.
    pub fn ledger_reverse_entry(&self, entry_id: i64, reason: &str) -> AppResult<LedgerEntry> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Err(AppError::validation("reason", "سبب عكس القيد مطلوب"));
        }
        let now = self.now_iso();
        let today = date_str(self.clock.today());
        let conn = self.conn();
        let orig = get_entry(&conn, entry_id)?;
        if let Some(tid) = orig.transaction_id {
            let (kind, status): (String, String) =
                conn.query_row("SELECT type, status FROM paypal_transactions WHERE id = ?1", params![tid], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
            if TxnType::parse(&kind) == TxnType::Payment {
                let msg = if TxnStatus::parse(&status) == TxnStatus::Approved {
                    "هذا قيد اعتماد معاملة. استخدم «إلغاء الاعتماد» من شاشة المعاملات"
                } else {
                    "هذا القيد ناتج عن إلغاء اعتماد معاملة. أعد اعتماد المعاملة بدلاً من عكسه"
                };
                return Err(AppError::invalid_transition(msg));
            }
        }
        let tx = conn.unchecked_transaction()?;
        let id = insert_reversal_of(&tx, &now, &today, entry_id, reason)?;
        audit::log(
            &tx,
            &now,
            "ledger.reverse",
            "ledger_entry",
            Some(id),
            json!({ "reversesEntryId": entry_id, "reason": reason, "amountMinor": -orig.amount_minor }),
        )?;
        tx.commit()?;
        get_entry(&conn, id)
    }

    pub fn ledger_statement(&self, customer_id: i64, currency: &str, period: Option<&Period>) -> AppResult<Statement> {
        let conn = self.conn();
        let customer = customers::get(&conn, customer_id)?;
        let view = view(&conn, customer_id, &normalize_currency(currency)?, period)?;
        Ok(Statement { customer, view, generated_at: self.now_iso() })
    }

    /// CSV (UTF-8 with BOM so Excel shows Arabic correctly).
    pub fn ledger_export_csv(
        &self,
        customer_id: i64,
        currency: &str,
        period: Option<&Period>,
        path: &Path,
    ) -> AppResult<()> {
        let st = self.ledger_statement(customer_id, currency, period)?;
        let cur = normalize_currency(currency)?;
        let mut out = String::from("\u{feff}");
        let esc = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        out.push_str(&format!("{},{}\r\n", esc("العميل"), esc(&st.customer.name)));
        out.push_str(&format!("{},{}\r\n", esc("العملة"), esc(&cur)));
        out.push_str("التاريخ,النوع,الوصف,له,عليه,الرصيد,المرجع\r\n");
        out.push_str(&format!(",,{},,,{},\r\n", esc("رصيد سابق"), format_plain(st.view.opening_balance_minor, &cur)));
        for e in &st.view.entries {
            let (credit, debit) = if e.amount_minor >= 0 {
                (format_plain(e.amount_minor, &cur), String::new())
            } else {
                (String::new(), format_plain(-e.amount_minor, &cur))
            };
            out.push_str(&format!(
                "{},{},{},{},{},{},{}\r\n",
                e.entry_date,
                esc(e.kind.label_ar()),
                esc(&e.description),
                credit,
                debit,
                format_plain(e.running_balance_minor, &cur),
                esc(e.reference.as_deref().unwrap_or(""))
            ));
        }
        out.push_str(&format!(
            ",,{},,,{},\r\n",
            esc("الرصيد الختامي"),
            format_plain(st.view.closing_balance_minor, &cur)
        ));
        let mut f = std::fs::File::create(path)
            .map_err(|e| AppError::new(ErrorCode::Internal, format!("تعذّر إنشاء الملف: {e}")))?;
        f.write_all(out.as_bytes())?;
        Ok(())
    }
}
