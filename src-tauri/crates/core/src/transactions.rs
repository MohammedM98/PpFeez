//! PayPal transactions: lifecycle state machine (SPEC §4.2), fees (§4.3), listing and bulk actions.

use crate::audit;
use crate::clock::{iso, parse_date};
use crate::commission::{self, validate_bps, Commission, CommissionMode};
use crate::customers::CustomerRef;
use crate::error::{is_unique_violation, AppError, AppResult, ErrorCode};
use crate::money::{format_amount, format_bps, normalize_currency, parse_non_negative, parse_positive};
use crate::settings;
use crate::Core;
use chrono::{Duration, NaiveDateTime};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

// ===== DTOs =====

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxnStatus {
    Unassigned,
    PendingApproval,
    Approved,
    Excluded,
}

impl TxnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TxnStatus::Unassigned => "unassigned",
            TxnStatus::PendingApproval => "pending_approval",
            TxnStatus::Approved => "approved",
            TxnStatus::Excluded => "excluded",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "pending_approval" => TxnStatus::PendingApproval,
            "approved" => TxnStatus::Approved,
            "excluded" => TxnStatus::Excluded,
            _ => TxnStatus::Unassigned,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxnType {
    Payment,
    Refund,
    Reversal,
}

impl TxnType {
    pub fn as_str(self) -> &'static str {
        match self {
            TxnType::Payment => "payment",
            TxnType::Refund => "refund",
            TxnType::Reversal => "reversal",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "refund" => TxnType::Refund,
            "reversal" => TxnType::Reversal,
            _ => TxnType::Payment,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TxnAction {
    Assign,
    Unassign,
    SetFee,
    SetCommission,
    Approve,
    Unapprove,
    Exclude,
    Include,
    EditNote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxRef {
    pub id: i64,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundRef {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: TxnType,
    pub gross_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: i64,
    pub source: String,
    pub paypal_txn_id: String,
    pub related_txn_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: TxnType,
    pub payer_name: Option<String>,
    pub payer_email: Option<String>,
    pub payer_note: Option<String>,
    pub currency: String,
    pub gross_minor: i64,
    pub fee_minor: Option<i64>,
    pub net_minor: Option<i64>,
    pub fee_is_estimated: bool,
    pub occurred_at: String,
    pub status: TxnStatus,
    pub customer: Option<CustomerRef>,
    pub commission_mode: Option<CommissionMode>,
    pub commission_bps: Option<i64>,
    pub commission_minor: Option<i64>,
    pub customer_amount_minor: Option<i64>,
    pub assigned_at: Option<String>,
    pub approved_at: Option<String>,
    pub note: Option<String>,
    pub mailbox: Option<MailboxRef>,
    pub raw_email_id: Option<i64>,
    pub refunded_by: Vec<RefundRef>,
    pub allowed_actions: Vec<TxnAction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum StatusFilter {
    Status(TxnStatus),
    All(AllMarker),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllMarker {
    All,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnFilter {
    pub status: Option<StatusFilter>,
    pub search: Option<String>,
    pub currency: Option<String>,
    pub mailbox_id: Option<i64>,
    pub customer_id: Option<i64>,
    pub period: Option<Period>,
    pub needs_fee_only: Option<bool>,
    #[serde(rename = "type")]
    pub kind: Option<TxnType>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TxnSortKey {
    OccurredAt,
    PayerName,
    GrossMinor,
    FeeMinor,
    NetMinor,
    CustomerAmountMinor,
    Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnSort {
    pub key: TxnSortKey,
    pub dir: SortDir,
}

impl Default for TxnSort {
    fn default() -> Self {
        TxnSort { key: TxnSortKey::OccurredAt, dir: SortDir::Desc }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyTotals {
    pub currency: String,
    pub gross_minor: i64,
    pub fee_minor: i64,
    pub net_minor: i64,
    pub customer_amount_minor: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnListResult {
    pub items: Vec<Transaction>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub totals: Vec<CurrencyTotals>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnCounts {
    pub all: i64,
    pub unassigned: i64,
    // Keys are TxnStatus values (`Record<TxnStatus | 'all' | 'needsFee', number>`).
    #[serde(rename = "pending_approval")]
    pub pending_approval: i64,
    pub approved: i64,
    pub excluded: i64,
    pub needs_fee: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualTxnInput {
    pub occurred_at: String,
    #[serde(default)]
    pub payer_name: Option<String>,
    #[serde(default)]
    pub payer_email: Option<String>,
    #[serde(default)]
    pub payer_note: Option<String>,
    pub currency: String,
    pub gross_text: String,
    #[serde(default)]
    pub fee_text: Option<String>,
    #[serde(default)]
    pub paypal_txn_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub raw_email_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FeeInput {
    Fee {
        #[serde(rename = "feeText")]
        fee_text: String,
    },
    Net {
        #[serde(rename = "netText")]
        net_text: String,
    },
    Zero,
    AcceptEstimate,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum CommissionInput {
    Percent {
        bps: i64,
    },
    Fixed {
        #[serde(rename = "amountText")]
        amount_text: String,
    },
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnPreview {
    pub net_minor: Option<i64>,
    pub commission_minor: Option<i64>,
    pub customer_amount_minor: Option<i64>,
    pub fee_estimate_minor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkFailure {
    pub id: i64,
    pub code: ErrorCode,
    pub message_ar: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkResult {
    pub ok: Vec<i64>,
    pub failed: Vec<BulkFailure>,
}

impl BulkResult {
    pub fn push(&mut self, id: i64, r: AppResult<()>) {
        match r {
            Ok(()) => self.ok.push(id),
            Err(e) => self.failed.push(BulkFailure { id, code: e.code, message_ar: e.message_ar }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BulkAction {
    Assign,
    Approve,
    Unassign,
    Exclude,
}

// ===== Row access =====

/// Raw row of `paypal_transactions`.
#[derive(Debug, Clone)]
pub struct TxnRow {
    pub id: i64,
    pub mailbox_id: Option<i64>,
    pub raw_email_id: Option<i64>,
    pub source: String,
    pub paypal_txn_id: String,
    pub related_txn_id: Option<String>,
    pub kind: TxnType,
    pub payer_name: Option<String>,
    pub payer_email: Option<String>,
    pub payer_note: Option<String>,
    pub currency: String,
    pub gross_minor: i64,
    pub fee_minor: Option<i64>,
    pub net_minor: Option<i64>,
    pub fee_is_estimated: bool,
    pub occurred_at: String,
    pub status: TxnStatus,
    pub customer_id: Option<i64>,
    pub commission_mode: Option<CommissionMode>,
    pub commission_bps: Option<i64>,
    pub commission_minor: Option<i64>,
    pub customer_amount_minor: Option<i64>,
    pub assigned_at: Option<String>,
    pub approved_at: Option<String>,
    pub note: Option<String>,
}

impl TxnRow {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<TxnRow> {
        Ok(TxnRow {
            id: r.get("id")?,
            mailbox_id: r.get("mailbox_id")?,
            raw_email_id: r.get("raw_email_id")?,
            source: r.get("source")?,
            paypal_txn_id: r.get("paypal_txn_id")?,
            related_txn_id: r.get("related_txn_id")?,
            kind: TxnType::parse(&r.get::<_, String>("type")?),
            payer_name: r.get("payer_name")?,
            payer_email: r.get("payer_email")?,
            payer_note: r.get("payer_note")?,
            currency: r.get("currency")?,
            gross_minor: r.get("gross_minor")?,
            fee_minor: r.get("fee_minor")?,
            net_minor: r.get("net_minor")?,
            fee_is_estimated: r.get::<_, i64>("fee_is_estimated")? != 0,
            occurred_at: r.get("occurred_at")?,
            status: TxnStatus::parse(&r.get::<_, String>("status")?),
            customer_id: r.get("customer_id")?,
            commission_mode: r.get::<_, Option<String>>("commission_mode")?.and_then(|m| CommissionMode::parse(&m)),
            commission_bps: r.get("commission_bps")?,
            commission_minor: r.get("commission_minor")?,
            customer_amount_minor: r.get("customer_amount_minor")?,
            assigned_at: r.get("assigned_at")?,
            approved_at: r.get("approved_at")?,
            note: r.get("note")?,
        })
    }

    /// The commission rule currently stored on the row.
    pub fn rule(&self) -> Option<Commission> {
        match self.commission_mode? {
            CommissionMode::Percent => Some(Commission::Percent(self.commission_bps?)),
            CommissionMode::Fixed => Some(Commission::Fixed(self.commission_minor?)),
        }
    }
}

pub fn load_row(conn: &Connection, id: i64) -> AppResult<TxnRow> {
    conn.query_row("SELECT * FROM paypal_transactions WHERE id = ?1", params![id], TxnRow::from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("المعاملة"))
}

pub fn find_by_paypal_id(conn: &Connection, paypal_txn_id: &str) -> AppResult<Option<TxnRow>> {
    Ok(conn
        .query_row(
            "SELECT * FROM paypal_transactions WHERE paypal_txn_id = ?1",
            params![paypal_txn_id],
            TxnRow::from_row,
        )
        .optional()?)
}

pub fn allowed_actions(row: &TxnRow) -> Vec<TxnAction> {
    use TxnAction::*;
    let is_payment = row.kind == TxnType::Payment;
    let mut a = vec![];
    match row.status {
        TxnStatus::Unassigned => {
            if is_payment {
                a.extend([Assign, SetFee]);
            }
            a.push(Exclude);
        }
        TxnStatus::PendingApproval => {
            a.extend([SetFee, SetCommission]);
            if row.fee_minor.is_some() && row.customer_amount_minor.unwrap_or(0) > 0 {
                a.push(Approve);
            }
            a.push(Unassign);
        }
        TxnStatus::Approved => a.push(Unapprove),
        TxnStatus::Excluded => a.push(Include),
    }
    a.push(EditNote);
    a
}

fn to_dto(conn: &Connection, row: TxnRow) -> AppResult<Transaction> {
    let customer = match row.customer_id {
        Some(id) => Some(crate::customers::customer_ref(conn, id)?),
        None => None,
    };
    let mailbox = match row.mailbox_id {
        Some(id) => conn
            .query_row("SELECT id, label FROM mailboxes WHERE id = ?1", params![id], |r| {
                Ok(MailboxRef { id: r.get(0)?, label: r.get(1)? })
            })
            .optional()?,
        None => None,
    };
    let refunded_by = if row.kind == TxnType::Payment {
        let mut stmt = conn.prepare(
            "SELECT id, type, gross_minor FROM paypal_transactions
             WHERE related_txn_id = ?1 AND type IN ('refund','reversal') ORDER BY occurred_at, id",
        )?;
        let rows = stmt.query_map(params![row.paypal_txn_id], |r| {
            Ok(RefundRef { id: r.get(0)?, kind: TxnType::parse(&r.get::<_, String>(1)?), gross_minor: r.get(2)? })
        })?;
        rows.collect::<Result<_, _>>()?
    } else {
        vec![]
    };
    let allowed = allowed_actions(&row);
    Ok(Transaction {
        id: row.id,
        source: row.source,
        paypal_txn_id: row.paypal_txn_id,
        related_txn_id: row.related_txn_id,
        kind: row.kind,
        payer_name: row.payer_name,
        payer_email: row.payer_email,
        payer_note: row.payer_note,
        currency: row.currency,
        gross_minor: row.gross_minor,
        fee_minor: row.fee_minor,
        net_minor: row.net_minor,
        fee_is_estimated: row.fee_is_estimated,
        occurred_at: row.occurred_at,
        status: row.status,
        customer,
        commission_mode: row.commission_mode,
        commission_bps: row.commission_bps,
        commission_minor: row.commission_minor,
        customer_amount_minor: row.customer_amount_minor,
        assigned_at: row.assigned_at,
        approved_at: row.approved_at,
        note: row.note,
        mailbox,
        raw_email_id: row.raw_email_id,
        refunded_by,
        allowed_actions: allowed,
    })
}

pub fn get_dto(conn: &Connection, id: i64) -> AppResult<Transaction> {
    let row = load_row(conn, id)?;
    to_dto(conn, row)
}

// ===== Calculations =====

/// Amounts derived from gross, fee and the commission rule. Fields stay `None` while the fee
/// is unknown (a fixed commission keeps its entered amount).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Derived {
    pub net_minor: Option<i64>,
    pub commission_minor: Option<i64>,
    pub customer_amount_minor: Option<i64>,
}

pub fn derive(gross: i64, fee: Option<i64>, rule: Option<Commission>) -> AppResult<Derived> {
    let net = match fee {
        Some(f) => {
            if f < 0 || f > gross {
                return Err(AppError::validation("fee", "الرسوم يجب ألا تتجاوز المبلغ الأصلي"));
            }
            Some(gross - f)
        }
        None => None,
    };
    match (fee, rule) {
        (Some(f), Some(rule)) => {
            let b = commission::compute(gross, f, rule)?;
            Ok(Derived {
                net_minor: Some(b.net_minor),
                commission_minor: Some(b.commission_minor),
                customer_amount_minor: Some(b.customer_amount_minor),
            })
        }
        (None, Some(Commission::Fixed(amount))) => {
            if amount < 0 {
                return Err(AppError::invalid_amount("amountText"));
            }
            if amount > gross {
                return Err(
                    AppError::new(ErrorCode::CommissionExceedsNet, "العمولة أكبر من المبلغ").with_field("amountText")
                );
            }
            Ok(Derived { net_minor: None, commission_minor: Some(amount), customer_amount_minor: None })
        }
        _ => Ok(Derived { net_minor: net, commission_minor: None, customer_amount_minor: None }),
    }
}

fn resolve_commission(input: &CommissionInput, currency: &str) -> AppResult<Commission> {
    match input {
        CommissionInput::Percent { bps } => Ok(Commission::Percent(validate_bps(*bps)?)),
        CommissionInput::Fixed { amount_text } => {
            Ok(Commission::Fixed(parse_non_negative(amount_text, currency, "amountText")?))
        }
    }
}

/// Fee estimate for a gross amount when the estimate is enabled in settings.
pub fn fee_estimate(conn: &Connection, gross: i64) -> AppResult<Option<i64>> {
    let s = settings::load(conn)?;
    Ok(if s.fee_estimate_enabled {
        Some(commission::estimate_fee(gross, s.fee_estimate_bps, s.fee_estimate_fixed_minor))
    } else {
        None
    })
}

/// Resolve a fee input to `(fee_minor, is_estimated)`.
fn resolve_fee(conn: &Connection, row: &TxnRow, fee: &FeeInput) -> AppResult<(i64, bool)> {
    let gross = row.gross_minor;
    let (value, estimated) = match fee {
        FeeInput::Fee { fee_text } => (parse_non_negative(fee_text, &row.currency, "feeText")?, false),
        FeeInput::Net { net_text } => {
            let net = parse_non_negative(net_text, &row.currency, "netText")?;
            if net > gross {
                return Err(AppError::validation("netText", "الصافي لا يمكن أن يتجاوز المبلغ الأصلي"));
            }
            (gross - net, false)
        }
        FeeInput::Zero => (0, false),
        FeeInput::AcceptEstimate => match fee_estimate(conn, gross)? {
            Some(e) => (e, true),
            None => return Err(AppError::validation("fee", "تقدير الرسوم غير مفعّل في الإعدادات")),
        },
    };
    if value > gross {
        return Err(AppError::validation("feeText", "الرسوم لا يمكن أن تتجاوز المبلغ الأصلي"));
    }
    Ok((value, estimated))
}

// ===== Helpers =====

pub fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn not_status(expected_ar: &str) -> AppError {
    AppError::invalid_transition(format!("لا يمكن تنفيذ هذا الإجراء: {expected_ar}"))
}

fn write_amounts(conn: &Connection, id: i64, d: &Derived, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE paypal_transactions SET net_minor = ?1, commission_minor = ?2, customer_amount_minor = ?3,
         updated_at = ?4 WHERE id = ?5",
        params![d.net_minor, d.commission_minor, d.customer_amount_minor, now, id],
    )?;
    Ok(())
}

/// Description of the ledger credit written on approval (SPEC §6.5).
pub fn credit_description(row: &TxnRow) -> String {
    let payer = row.payer_name.clone().or_else(|| row.payer_email.clone()).unwrap_or_else(|| row.paypal_txn_id.clone());
    let commission = match row.commission_mode {
        Some(CommissionMode::Percent) => format_bps(row.commission_bps.unwrap_or(0)),
        _ => format_amount(row.commission_minor.unwrap_or(0), &row.currency),
    };
    format!(
        "دفعة من {payer} — أصلي {}، رسوم {}، عمولة {commission}",
        format_amount(row.gross_minor, &row.currency),
        format_amount(row.fee_minor.unwrap_or(0), &row.currency),
    )
}

// ===== Transitions (each runs inside the caller's SQL transaction) =====

pub(crate) fn assign_in(
    conn: &Connection,
    now: &str,
    id: i64,
    customer_id: i64,
    commission: Option<&CommissionInput>,
) -> AppResult<()> {
    let row = load_row(conn, id)?;
    if row.status != TxnStatus::Unassigned {
        return Err(not_status("المعاملة ليست غير مخصّصة"));
    }
    if row.kind != TxnType::Payment {
        return Err(AppError::invalid_transition("صفوف الاسترداد والعكس لا تُخصَّص لعميل"));
    }
    let (active, default_bps): (bool, i64) = conn
        .query_row("SELECT is_active, default_commission_bps FROM customers WHERE id = ?1", params![customer_id], |r| {
            Ok((r.get::<_, i64>(0)? != 0, r.get(1)?))
        })
        .optional()?
        .ok_or_else(|| AppError::not_found("العميل"))?;
    if !active {
        return Err(AppError::new(ErrorCode::CustomerInactive, "العميل معطّل ولا يمكن التخصيص له"));
    }
    let rule = match commission {
        Some(c) => resolve_commission(c, &row.currency)?,
        None => Commission::Percent(default_bps),
    };
    let d = derive(row.gross_minor, row.fee_minor, Some(rule))?;
    conn.execute(
        "UPDATE paypal_transactions SET status = 'pending_approval', customer_id = ?1, commission_mode = ?2,
         commission_bps = ?3, commission_minor = ?4, customer_amount_minor = ?5, net_minor = ?6,
         assigned_at = ?7, updated_at = ?7 WHERE id = ?8",
        params![
            customer_id,
            rule.mode().as_str(),
            rule.bps(),
            d.commission_minor,
            d.customer_amount_minor,
            d.net_minor,
            now,
            id
        ],
    )?;
    audit::log(
        conn,
        now,
        "txn.assign",
        "transaction",
        Some(id),
        json!({ "customerId": customer_id, "commissionMode": rule.mode().as_str(), "commissionBps": rule.bps(),
                "commissionMinor": d.commission_minor, "customerAmountMinor": d.customer_amount_minor }),
    )?;
    Ok(())
}

pub(crate) fn unassign_in(conn: &Connection, now: &str, id: i64) -> AppResult<()> {
    let row = load_row(conn, id)?;
    if row.status != TxnStatus::PendingApproval {
        return Err(not_status("المعاملة ليست بانتظار الموافقة"));
    }
    conn.execute(
        "UPDATE paypal_transactions SET status = 'unassigned', customer_id = NULL, commission_mode = NULL,
         commission_bps = NULL, commission_minor = NULL, customer_amount_minor = NULL, assigned_at = NULL,
         updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    audit::log(conn, now, "txn.unassign", "transaction", Some(id), json!({ "customerId": row.customer_id }))?;
    Ok(())
}

pub(crate) fn approve_in(conn: &Connection, now: &str, today: &str, id: i64) -> AppResult<i64> {
    let row = load_row(conn, id)?;
    if row.status != TxnStatus::PendingApproval {
        return Err(not_status("المعاملة ليست بانتظار الموافقة"));
    }
    if row.fee_minor.is_none() {
        return Err(AppError::new(ErrorCode::FeeRequired, "أدخل رسوم PayPal (أو اختر «بلا رسوم») قبل الاعتماد"));
    }
    let customer_id = row.customer_id.ok_or_else(|| not_status("المعاملة غير مخصّصة لعميل"))?;
    let amount = row.customer_amount_minor.unwrap_or(0);
    if amount <= 0 {
        return Err(AppError::validation("commission", "حصة العميل يجب أن تكون أكبر من صفر"));
    }
    conn.execute(
        "INSERT INTO ledger_entries (customer_id, currency, type, amount_minor, paypal_transaction_id,
         description, entry_date, created_at) VALUES (?1, ?2, 'credit', ?3, ?4, ?5, ?6, ?7)",
        params![customer_id, row.currency, amount, id, credit_description(&row), today, now],
    )?;
    let entry_id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE paypal_transactions SET status = 'approved', approved_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    audit::log(
        conn,
        now,
        "txn.approve",
        "transaction",
        Some(id),
        json!({ "customerId": customer_id, "amountMinor": amount, "currency": row.currency, "ledgerEntryId": entry_id }),
    )?;
    Ok(entry_id)
}

pub(crate) fn unapprove_in(conn: &Connection, now: &str, today: &str, id: i64, reason: &str) -> AppResult<i64> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(AppError::validation("reason", "سبب إلغاء الاعتماد مطلوب"));
    }
    let row = load_row(conn, id)?;
    if row.status != TxnStatus::Approved {
        return Err(not_status("المعاملة ليست معتمدة"));
    }
    // The active (not yet reversed) credit of this approval.
    let (entry_id, customer_id, currency, amount, description): (i64, i64, String, i64, String) = conn
        .query_row(
            "SELECT e.id, e.customer_id, e.currency, e.amount_minor, e.description FROM ledger_entries e
             WHERE e.paypal_transaction_id = ?1 AND e.type = 'credit'
               AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = e.id)
             ORDER BY e.id DESC LIMIT 1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::internal("لم يُعثر على قيد الاعتماد"))?;
    conn.execute(
        "INSERT INTO ledger_entries (customer_id, currency, type, amount_minor, paypal_transaction_id,
         reverses_entry_id, description, entry_date, created_at)
         VALUES (?1, ?2, 'reversal', ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            customer_id,
            currency,
            -amount,
            id,
            entry_id,
            format!("عكس: {description} — إلغاء الاعتماد: {reason}"),
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
    let reversal_id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE paypal_transactions SET status = 'unassigned', customer_id = NULL, commission_mode = NULL,
         commission_bps = NULL, commission_minor = NULL, customer_amount_minor = NULL, assigned_at = NULL,
         approved_at = NULL, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    audit::log(
        conn,
        now,
        "txn.unapprove",
        "transaction",
        Some(id),
        json!({ "reason": reason, "customerId": customer_id, "amountMinor": amount, "reversalEntryId": reversal_id }),
    )?;
    Ok(reversal_id)
}

pub(crate) fn set_excluded_in(conn: &Connection, now: &str, id: i64, excluded: bool) -> AppResult<()> {
    let row = load_row(conn, id)?;
    let (from, to, action) = if excluded {
        (TxnStatus::Unassigned, TxnStatus::Excluded, "txn.exclude")
    } else {
        (TxnStatus::Excluded, TxnStatus::Unassigned, "txn.include")
    };
    if row.status != from {
        return Err(not_status(if excluded {
            "الاستبعاد متاح للمعاملات غير المخصّصة فقط"
        } else {
            "المعاملة ليست مستبعدة"
        }));
    }
    conn.execute(
        "UPDATE paypal_transactions SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![to.as_str(), now, id],
    )?;
    audit::log(conn, now, action, "transaction", Some(id), json!({}))?;
    Ok(())
}

// ===== Public API =====

impl Core {
    fn today_str(&self) -> String {
        crate::clock::date_str(self.clock.today())
    }

    /// Run `f` inside one SQL transaction and return the refreshed DTO.
    fn txn_op(&self, id: i64, f: impl FnOnce(&Connection, &str, &str) -> AppResult<()>) -> AppResult<Transaction> {
        let now = self.now_iso();
        let today = self.today_str();
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        f(&tx, &now, &today)?;
        tx.commit()?;
        get_dto(&conn, id)
    }

    pub fn txn_get(&self, id: i64) -> AppResult<Transaction> {
        get_dto(&self.conn(), id)
    }

    pub fn txn_history(&self, id: i64) -> AppResult<Vec<audit::HistoryItem>> {
        let conn = self.conn();
        load_row(&conn, id)?;
        audit::history(&conn, "transaction", id)
    }

    pub fn txn_create_manual(&self, input: ManualTxnInput) -> AppResult<Transaction> {
        let currency = normalize_currency(&input.currency)?;
        let gross = parse_positive(&input.gross_text, &currency, "grossText")?;
        let fee = match clean(input.fee_text.clone()) {
            Some(t) => {
                let f = parse_non_negative(&t, &currency, "feeText")?;
                if f > gross {
                    return Err(AppError::validation("feeText", "الرسوم لا يمكن أن تتجاوز المبلغ الأصلي"));
                }
                Some(f)
            }
            None => None,
        };
        let local = parse_local_datetime(&input.occurred_at)
            .ok_or_else(|| AppError::validation("occurredAt", "التاريخ غير صالح (YYYY-MM-DD HH:mm)"))?;
        let occurred_at = iso(self.clock.local_to_utc(local));
        let paypal_txn_id =
            clean(input.paypal_txn_id.clone()).unwrap_or_else(|| format!("MANUAL-{}", uuid::Uuid::new_v4()));
        let now = self.now_iso();
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        let mailbox_id: Option<i64> = match input.raw_email_id {
            Some(rid) => Some(
                tx.query_row("SELECT mailbox_id FROM raw_emails WHERE id = ?1", params![rid], |r| r.get(0))
                    .optional()?
                    .ok_or_else(|| AppError::not_found("الرسالة"))?,
            ),
            None => None,
        };
        tx.execute(
            "INSERT INTO paypal_transactions (mailbox_id, raw_email_id, source, paypal_txn_id, type, payer_name,
             payer_email, payer_note, currency, gross_minor, fee_minor, net_minor, fee_is_estimated, occurred_at,
             status, note, created_at, updated_at)
             VALUES (?1, ?2, 'manual', ?3, 'payment', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, 'unassigned', ?12, ?13, ?13)",
            params![
                mailbox_id,
                input.raw_email_id,
                paypal_txn_id,
                clean(input.payer_name.clone()),
                clean(input.payer_email.clone()),
                clean(input.payer_note.clone()),
                currency,
                gross,
                fee,
                fee.map(|f| gross - f),
                occurred_at,
                clean(input.note.clone()),
                now
            ],
        )
        .map_err(|e| {
            if is_unique_violation(&e) {
                AppError::new(ErrorCode::Duplicate, "رقم معاملة PayPal موجود مسبقاً").with_field("paypalTxnId")
            } else {
                e.into()
            }
        })?;
        let id = tx.last_insert_rowid();
        if let Some(rid) = input.raw_email_id {
            tx.execute(
                "UPDATE raw_emails SET parse_status = 'parsed', parse_reason = 'manual', parser_name = 'manual' WHERE id = ?1",
                params![rid],
            )?;
        }
        audit::log(
            &tx,
            &now,
            "txn.create",
            "transaction",
            Some(id),
            json!({ "source": "manual", "grossMinor": gross, "feeMinor": fee, "currency": currency, "rawEmailId": input.raw_email_id }),
        )?;
        tx.commit()?;
        get_dto(&conn, id)
    }

    pub fn txn_assign(
        &self,
        id: i64,
        customer_id: i64,
        commission: Option<CommissionInput>,
        approve: bool,
    ) -> AppResult<Transaction> {
        self.txn_op(id, |c, now, today| {
            assign_in(c, now, id, customer_id, commission.as_ref())?;
            if approve {
                approve_in(c, now, today, id)?;
            }
            Ok(())
        })
    }

    pub fn txn_unassign(&self, id: i64) -> AppResult<Transaction> {
        self.txn_op(id, |c, now, _| unassign_in(c, now, id))
    }

    pub fn txn_set_fee(&self, id: i64, fee: FeeInput) -> AppResult<Transaction> {
        self.txn_op(id, |c, now, _| {
            let row = load_row(c, id)?;
            if row.status == TxnStatus::Approved {
                return Err(AppError::invalid_transition("المعاملة معتمدة ومقفلة. ألغِ الاعتماد أولاً"));
            }
            if row.kind != TxnType::Payment {
                return Err(AppError::invalid_transition("الرسوم تخص معاملات الدفع فقط"));
            }
            let (fee_minor, estimated) = resolve_fee(c, &row, &fee)?;
            let rule = if row.status == TxnStatus::PendingApproval { row.rule() } else { None };
            let d = derive(row.gross_minor, Some(fee_minor), rule)?;
            // One statement so the CHECK (net = gross − fee) holds at every step.
            c.execute(
                "UPDATE paypal_transactions SET fee_minor = ?1, fee_is_estimated = ?2, net_minor = ?3,
                 commission_minor = ?4, customer_amount_minor = ?5, updated_at = ?6 WHERE id = ?7",
                params![fee_minor, estimated as i64, d.net_minor, d.commission_minor, d.customer_amount_minor, now, id],
            )?;
            audit::log(
                c,
                now,
                "txn.fee_set",
                "transaction",
                Some(id),
                json!({ "before": row.fee_minor, "after": fee_minor, "estimated": estimated, "netMinor": d.net_minor }),
            )
        })
    }

    pub fn txn_set_commission(&self, id: i64, commission: CommissionInput) -> AppResult<Transaction> {
        self.txn_op(id, |c, now, _| {
            let row = load_row(c, id)?;
            if row.status != TxnStatus::PendingApproval {
                return Err(not_status("تعديل العمولة متاح للمعاملات بانتظار الموافقة فقط"));
            }
            let rule = resolve_commission(&commission, &row.currency)?;
            let d = derive(row.gross_minor, row.fee_minor, Some(rule))?;
            c.execute(
                "UPDATE paypal_transactions SET commission_mode = ?1, commission_bps = ?2, updated_at = ?3 WHERE id = ?4",
                params![rule.mode().as_str(), rule.bps(), now, id],
            )?;
            write_amounts(c, id, &d, now)?;
            audit::log(
                c,
                now,
                "txn.commission_set",
                "transaction",
                Some(id),
                json!({ "before": { "mode": row.commission_mode.map(|m| m.as_str()), "bps": row.commission_bps, "minor": row.commission_minor },
                        "after": { "mode": rule.mode().as_str(), "bps": rule.bps(), "minor": d.commission_minor } }),
            )
        })
    }

    pub fn txn_approve(&self, id: i64) -> AppResult<Transaction> {
        self.txn_op(id, |c, now, today| approve_in(c, now, today, id).map(|_| ()))
    }

    pub fn txn_unapprove(&self, id: i64, reason: &str) -> AppResult<Transaction> {
        self.txn_op(id, |c, now, today| unapprove_in(c, now, today, id, reason).map(|_| ()))
    }

    pub fn txn_set_excluded(&self, id: i64, excluded: bool) -> AppResult<Transaction> {
        self.txn_op(id, |c, now, _| set_excluded_in(c, now, id, excluded))
    }

    pub fn txn_set_note(&self, id: i64, note: Option<String>) -> AppResult<Transaction> {
        self.txn_op(id, |c, now, _| {
            let row = load_row(c, id)?;
            let note = clean(note);
            c.execute(
                "UPDATE paypal_transactions SET note = ?1, updated_at = ?2 WHERE id = ?3",
                params![note, now, id],
            )?;
            audit::log(c, now, "txn.note_set", "transaction", Some(id), json!({ "before": row.note, "after": note }))
        })
    }

    /// Each id runs in its own SQL transaction; the result lists successes and failures.
    pub fn txn_bulk(
        &self,
        action: BulkAction,
        ids: &[i64],
        customer_id: Option<i64>,
        commission: Option<CommissionInput>,
    ) -> AppResult<BulkResult> {
        if action == BulkAction::Assign && customer_id.is_none() {
            return Err(AppError::validation("customerId", "اختر العميل"));
        }
        let mut result = BulkResult::default();
        for &id in ids {
            let r = self.txn_op(id, |c, now, today| match action {
                BulkAction::Assign => assign_in(c, now, id, customer_id.unwrap_or_default(), commission.as_ref()),
                BulkAction::Approve => approve_in(c, now, today, id).map(|_| ()),
                BulkAction::Unassign => unassign_in(c, now, id),
                BulkAction::Exclude => set_excluded_in(c, now, id, true),
            });
            result.push(id, r.map(|_| ()));
        }
        Ok(result)
    }

    /// Preview amounts without saving. Business errors are returned inside the preview.
    pub fn txn_preview(
        &self,
        id: i64,
        fee: Option<FeeInput>,
        commission: Option<CommissionInput>,
        customer_id: Option<i64>,
    ) -> AppResult<TxnPreview> {
        let conn = self.conn();
        let row = load_row(&conn, id)?;
        let estimate = if row.fee_minor.is_none() { fee_estimate(&conn, row.gross_minor)? } else { None };
        let compute = || -> AppResult<Derived> {
            let fee_minor = match &fee {
                Some(f) => Some(resolve_fee(&conn, &row, f)?.0),
                None => row.fee_minor,
            };
            let rule = match (&commission, customer_id) {
                (Some(c), _) => Some(resolve_commission(c, &row.currency)?),
                (None, Some(cid)) => {
                    let bps: i64 = conn
                        .query_row("SELECT default_commission_bps FROM customers WHERE id = ?1", params![cid], |r| {
                            r.get(0)
                        })
                        .optional()?
                        .ok_or_else(|| AppError::not_found("العميل"))?;
                    Some(Commission::Percent(bps))
                }
                (None, None) => row.rule(),
            };
            derive(row.gross_minor, fee_minor, rule)
        };
        Ok(match compute() {
            Ok(d) => TxnPreview {
                net_minor: d.net_minor,
                commission_minor: d.commission_minor,
                customer_amount_minor: d.customer_amount_minor,
                fee_estimate_minor: estimate,
                error: None,
            },
            Err(e) => TxnPreview { fee_estimate_minor: estimate, error: Some(e), ..Default::default() },
        })
    }

    pub fn txn_list(&self, filter: &TxnFilter, sort: TxnSort, page: i64, page_size: i64) -> AppResult<TxnListResult> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 500);
        let conn = self.conn();
        let (where_sql, args) = self.where_clause(filter, true)?;
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM paypal_transactions t WHERE {where_sql}"),
            rusqlite::params_from_iter(args.iter()),
            |r| r.get(0),
        )?;
        let dir = match sort.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        let order = match sort.key {
            TxnSortKey::OccurredAt => format!("t.occurred_at {dir}"),
            TxnSortKey::PayerName => format!("COALESCE(t.payer_name, t.payer_email, '') COLLATE NOCASE {dir}"),
            TxnSortKey::GrossMinor => format!("t.gross_minor {dir}"),
            TxnSortKey::FeeMinor => format!("t.fee_minor IS NULL, t.fee_minor {dir}"),
            TxnSortKey::NetMinor => format!("t.net_minor IS NULL, t.net_minor {dir}"),
            TxnSortKey::CustomerAmountMinor => {
                format!("t.customer_amount_minor IS NULL, t.customer_amount_minor {dir}")
            }
            TxnSortKey::Status => format!(
                "CASE t.status WHEN 'unassigned' THEN 0 WHEN 'pending_approval' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END {dir}"
            ),
        };
        let sql = format!(
            "SELECT t.* FROM paypal_transactions t WHERE {where_sql} ORDER BY {order}, t.id {dir} LIMIT {} OFFSET {}",
            page_size,
            (page - 1) * page_size
        );
        let rows: Vec<TxnRow> = {
            let mut stmt = conn.prepare(&sql)?;
            let it = stmt.query_map(rusqlite::params_from_iter(args.iter()), TxnRow::from_row)?;
            it.collect::<Result<_, _>>()?
        };
        let items = rows.into_iter().map(|r| to_dto(&conn, r)).collect::<AppResult<Vec<_>>>()?;
        let totals = {
            let mut stmt = conn.prepare(&format!(
                "SELECT t.currency, SUM(t.gross_minor), COALESCE(SUM(t.fee_minor),0), COALESCE(SUM(t.net_minor),0),
                 COALESCE(SUM(t.customer_amount_minor),0), COUNT(*)
                 FROM paypal_transactions t WHERE {where_sql} GROUP BY t.currency ORDER BY t.currency"
            ))?;
            let it = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
                Ok(CurrencyTotals {
                    currency: r.get(0)?,
                    gross_minor: r.get(1)?,
                    fee_minor: r.get(2)?,
                    net_minor: r.get(3)?,
                    customer_amount_minor: r.get(4)?,
                    count: r.get(5)?,
                })
            })?;
            it.collect::<Result<Vec<_>, _>>()?
        };
        Ok(TxnListResult { items, total, page, page_size, totals })
    }

    pub fn txn_counts(&self, filter: &TxnFilter) -> AppResult<TxnCounts> {
        let conn = self.conn();
        let (where_sql, args) = self.where_clause(filter, false)?;
        let mut counts = TxnCounts::default();
        let mut stmt = conn.prepare(&format!(
            "SELECT t.status, COUNT(*), SUM(CASE WHEN t.fee_minor IS NULL AND t.type = 'payment' AND t.status <> 'excluded' THEN 1 ELSE 0 END)
             FROM paypal_transactions t WHERE {where_sql} GROUP BY t.status"
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?;
        for row in rows {
            let (status, n, needs_fee) = row?;
            counts.all += n;
            counts.needs_fee += needs_fee;
            match TxnStatus::parse(&status) {
                TxnStatus::Unassigned => counts.unassigned += n,
                TxnStatus::PendingApproval => counts.pending_approval += n,
                TxnStatus::Approved => counts.approved += n,
                TxnStatus::Excluded => counts.excluded += n,
            }
        }
        Ok(counts)
    }

    /// Build the WHERE clause of a transaction filter.
    fn where_clause(&self, f: &TxnFilter, with_status: bool) -> AppResult<(String, Vec<rusqlite::types::Value>)> {
        let mut w = vec!["1=1".to_string()];
        let mut a: Vec<rusqlite::types::Value> = vec![];
        if with_status {
            if let Some(StatusFilter::Status(s)) = f.status {
                w.push("t.status = ?".into());
                a.push(s.as_str().to_string().into());
            }
        }
        if let Some(s) = f.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            w.push(
                "(t.payer_name LIKE ? ESCAPE '\\' OR t.payer_email LIKE ? ESCAPE '\\' OR t.paypal_txn_id LIKE ? ESCAPE '\\' OR t.payer_note LIKE ? ESCAPE '\\')"
                    .into(),
            );
            let like = format!("%{}%", escape_like(s));
            for _ in 0..4 {
                a.push(like.clone().into());
            }
        }
        if let Some(c) = f.currency.as_deref().filter(|c| !c.is_empty()) {
            w.push("t.currency = ?".into());
            a.push(c.to_ascii_uppercase().into());
        }
        if let Some(m) = f.mailbox_id {
            w.push("t.mailbox_id = ?".into());
            a.push(m.into());
        }
        if let Some(c) = f.customer_id {
            w.push("t.customer_id = ?".into());
            a.push(c.into());
        }
        if let Some(k) = f.kind {
            w.push("t.type = ?".into());
            a.push(k.as_str().to_string().into());
        }
        if f.needs_fee_only.unwrap_or(false) {
            w.push("t.fee_minor IS NULL AND t.type = 'payment' AND t.status <> 'excluded'".into());
        }
        if let Some(p) = &f.period {
            let (from, to) = self.period_bounds(p)?;
            if let Some(from) = from {
                w.push("t.occurred_at >= ?".into());
                a.push(from.into());
            }
            if let Some(to) = to {
                w.push("t.occurred_at < ?".into());
                a.push(to.into());
            }
        }
        Ok((w.join(" AND "), a))
    }

    /// Local inclusive dates `YYYY-MM-DD` → UTC ISO bounds `[from, to+1day)`.
    pub(crate) fn period_bounds(&self, p: &Period) -> AppResult<(Option<String>, Option<String>)> {
        let conv = |s: &Option<String>, field: &str, add_day: bool| -> AppResult<Option<String>> {
            match s.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                None => Ok(None),
                Some(v) => {
                    let d =
                        parse_date(v).ok_or_else(|| AppError::validation(field, "التاريخ غير صالح (YYYY-MM-DD)"))?;
                    let d = if add_day { d + Duration::days(1) } else { d };
                    Ok(Some(iso(self.clock.local_to_utc(d.and_hms_opt(0, 0, 0).unwrap()))))
                }
            }
        };
        Ok((conv(&p.from, "period.from", false)?, conv(&p.to, "period.to", true)?))
    }
}

/// Accept `YYYY-MM-DD HH:mm`, `YYYY-MM-DDTHH:mm` (optionally with seconds) or a bare date.
pub fn parse_local_datetime(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    for fmt in ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(d);
        }
    }
    parse_date(s).and_then(|d| d.and_hms_opt(12, 0, 0))
}
