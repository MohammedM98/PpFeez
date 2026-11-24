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
