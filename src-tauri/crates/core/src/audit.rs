//! Audit log: every money-related action is written to `audit_log` (SPEC §3, §4.2).

use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

pub fn log(conn: &Connection, now: &str, action: &str, entity: &str, entity_id: Option<i64>, details: Value) -> AppResult<()> {
    conn.execute(
        "INSERT INTO audit_log (action, entity, entity_id, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![action, entity, entity_id, details.to_string(), now],
    )?;
    Ok(())
}

/// Arabic label for an audit action (shown in the transaction history panel).
pub fn label_ar(action: &str) -> &'static str {
    match action {
        "txn.create" => "إنشاء المعاملة",
        "txn.import" => "استيراد من البريد",
        "txn.assign" => "تخصيص لعميل",
        "txn.unassign" => "إلغاء التخصيص",
        "txn.fee_set" => "تعديل الرسوم",
        "txn.commission_set" => "تعديل العمولة",
        "txn.approve" => "اعتماد",
        "txn.unapprove" => "إلغاء الاعتماد",
        "txn.exclude" => "استبعاد",
        "txn.include" => "إرجاع من الاستبعاد",
        "txn.note_set" => "تعديل الملاحظة",
        "refund.confirm" => "تأكيد قيد الاسترداد",
        "refund.dismiss" => "تجاهل تنبيه الاسترداد",
        "ledger.payout" => "تسجيل دفعة",
        "ledger.adjustment" => "قيد تسوية",
        "ledger.reverse" => "عكس قيد",
        "customer.create" => "إضافة عميل",
        "customer.update" => "تعديل عميل",
        "customer.set_active" => "تفعيل/تعطيل عميل",
        _ => "إجراء",
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: i64,
    pub action: String,
    pub label_ar: String,
    pub details: Value,
    pub created_at: String,
}

pub fn history(conn: &Connection, entity: &str, entity_id: i64) -> AppResult<Vec<HistoryItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, action, details, created_at FROM audit_log WHERE entity = ?1 AND entity_id = ?2 ORDER BY id",
    )?;
    let rows = stmt.query_map(params![entity, entity_id], |r| {
        let action: String = r.get(1)?;
        let details: String = r.get(2)?;
        Ok(HistoryItem {
            id: r.get(0)?,
            label_ar: label_ar(&action).to_string(),
            action,
            details: serde_json::from_str(&details).unwrap_or(Value::Null),
            created_at: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
