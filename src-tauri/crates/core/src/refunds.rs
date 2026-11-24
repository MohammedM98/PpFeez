//! Refunds and reversals of customer payments (SPEC §4.4).
//!
//! A refund/reversal row points at the original payment through `related_txn_id`. When the
//! original is approved, the row shows up as an alert with a suggested `reversal` ledger
//! entry; the entry is only written when the owner confirms it.

use crate::audit;
use crate::clock::date_str;
use crate::customers::{self, CustomerRef};
use crate::error::{AppError, AppResult};
use crate::ledger::{get_entry, LedgerEntry};
use crate::money::{format_amount, ltr, mul_div_half_up, parse_positive};
use crate::transactions::{find_by_paypal_id, get_dto, load_row, Transaction, TxnRow, TxnStatus, TxnType};
use crate::Core;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::json;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundAlert {
    pub refund_txn: Transaction,
    pub original_txn: Transaction,
    pub suggested_reversal_minor: i64,
    pub customer: CustomerRef,
}

/// Suggested (negative) reversal: the full customer share for a full refund, otherwise
/// `−(refund × customer_amount / gross)` rounded half-up.
pub fn suggested_reversal(refund_gross: i64, original_gross: i64, customer_amount: i64) -> i64 {
    if refund_gross >= original_gross {
        -customer_amount
    } else {
        -mul_div_half_up(refund_gross, customer_amount, original_gross)
    }
}

/// Pending refund rows whose original payment is approved.
fn alert_pairs(conn: &Connection) -> AppResult<Vec<(TxnRow, TxnRow)>> {
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT r.id FROM paypal_transactions r
             JOIN paypal_transactions o ON o.paypal_txn_id = r.related_txn_id
             WHERE r.type IN ('refund','reversal') AND r.status = 'unassigned'
               AND o.type = 'payment' AND o.status = 'approved'
             ORDER BY r.occurred_at, r.id",
        )?;
        let it = stmt.query_map([], |r| r.get(0))?;
        it.collect::<Result<_, _>>()?
    };
    let mut out = vec![];
    for id in ids {
        let refund = load_row(conn, id)?;
        let original = find_by_paypal_id(conn, refund.related_txn_id.as_deref().unwrap_or_default())?
            .ok_or_else(|| AppError::not_found("المعاملة الأصلية"))?;
        out.push((refund, original));
    }
    Ok(out)
}

pub fn alert_count(conn: &Connection) -> AppResult<i64> {
    Ok(alert_pairs(conn)?.len() as i64)
}

fn alert_for(conn: &Connection, refund_id: i64) -> AppResult<(TxnRow, TxnRow)> {
    let refund = load_row(conn, refund_id)?;
    if !matches!(refund.kind, TxnType::Refund | TxnType::Reversal) {
        return Err(AppError::invalid_transition("هذه المعاملة ليست استرداداً أو عكساً"));
    }
    if refund.status != TxnStatus::Unassigned {
        return Err(AppError::invalid_transition("تمت معالجة هذا الاسترداد مسبقاً"));
    }
    let original = refund
        .related_txn_id
        .as_deref()
        .map(|rid| find_by_paypal_id(conn, rid))
        .transpose()?
        .flatten()
        .ok_or_else(|| AppError::not_found("المعاملة الأصلية"))?;
    Ok((refund, original))
}

impl Core {
    pub fn refund_alerts(&self) -> AppResult<Vec<RefundAlert>> {
        let conn = self.conn();
        let mut out = vec![];
        for (refund, original) in alert_pairs(&conn)? {
            let customer_id = original.customer_id.ok_or_else(|| AppError::internal("approved without customer"))?;
            out.push(RefundAlert {
                suggested_reversal_minor: suggested_reversal(
                    refund.gross_minor,
                    original.gross_minor,
                    original.customer_amount_minor.unwrap_or(0),
                ),
                customer: customers::customer_ref(&conn, customer_id)?,
                refund_txn: get_dto(&conn, refund.id)?,
                original_txn: get_dto(&conn, original.id)?,
            });
        }
        Ok(out)
    }

    /// Write the reversal entry (suggested amount, or `amount_text` as a positive magnitude)
    /// and mark the refund row as processed (`excluded`).
    pub fn refund_confirm_reversal(&self, refund_txn_id: i64, amount_text: Option<&str>) -> AppResult<LedgerEntry> {
        let now = self.now_iso();
        let today = date_str(self.clock.today());
        let conn = self.conn();
        let (refund, original) = alert_for(&conn, refund_txn_id)?;
        if original.status != TxnStatus::Approved {
            return Err(AppError::invalid_transition(
                "المعاملة الأصلية غير معتمدة؛ لا حاجة لقيد عكسي. استبعد الاسترداد أو عدّل الأصلية",
            ));
        }
        let customer_id = original.customer_id.ok_or_else(|| AppError::internal("approved without customer"))?;
        let amount = match amount_text.map(str::trim).filter(|s| !s.is_empty()) {
            Some(t) => -parse_positive(t.trim_start_matches(['-', '−']), &original.currency, "amountText")?,
            None => suggested_reversal(
                refund.gross_minor,
                original.gross_minor,
                original.customer_amount_minor.unwrap_or(0),
            ),
        };
        if amount >= 0 {
            return Err(AppError::invalid_amount("amountText"));
        }
        let kind_ar = if refund.kind == TxnType::Refund { "استرداد" } else { "عكس/نزاع" };
        let description = format!(
            "{kind_ar} {} للمعاملة {} (المسترد {})",
            ltr(&refund.paypal_txn_id),
            ltr(&original.paypal_txn_id),
            ltr(&format_amount(refund.gross_minor, &refund.currency))
        );
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO ledger_entries (customer_id, currency, type, amount_minor, paypal_transaction_id,
             description, entry_date, created_at) VALUES (?1, ?2, 'reversal', ?3, ?4, ?5, ?6, ?7)",
            params![customer_id, original.currency, amount, refund.id, description, today, now],
        )?;
        let entry_id = tx.last_insert_rowid();
        crate::excel::customer::enqueue(
            &tx,
            &now,
            customer_id,
            crate::excel::customer::ItemKind::Ledger,
            entry_id,
            None,
            None,
        )?;
        tx.execute(
            "UPDATE paypal_transactions SET status = 'excluded', updated_at = ?1 WHERE id = ?2",
            params![now, refund.id],
        )?;
        audit::log(
            &tx,
            &now,
            "refund.confirm",
            "transaction",
            Some(refund.id),
            json!({ "originalTxnId": original.id, "customerId": customer_id, "amountMinor": amount, "ledgerEntryId": entry_id }),
        )?;
        tx.commit()?;
        get_entry(&conn, entry_id)
    }

    /// Mark a refund row as handled without any ledger entry.
    pub fn refund_dismiss(&self, refund_txn_id: i64) -> AppResult<()> {
        let now = self.now_iso();
        let conn = self.conn();
        let refund = load_row(&conn, refund_txn_id)?;
        if !matches!(refund.kind, TxnType::Refund | TxnType::Reversal) || refund.status != TxnStatus::Unassigned {
            return Err(AppError::invalid_transition("لا يوجد تنبيه استرداد مفتوح لهذه المعاملة"));
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE paypal_transactions SET status = 'excluded', updated_at = ?1 WHERE id = ?2",
            params![now, refund.id],
        )?;
        audit::log(&tx, &now, "refund.dismiss", "transaction", Some(refund.id), json!({}))?;
        tx.commit()?;
        Ok(())
    }
}
