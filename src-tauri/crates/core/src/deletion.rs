//! Deleting data (SPEC §4.7): transactions, customers, ledger entries and "start fresh".
//!
//! Rules: every delete has a preview of its effect, runs in one SQL transaction (all or
//! nothing), writes a full JSON snapshot of each deleted row to `audit_log`, and takes an
//! automatic backup where the spec asks for one. Ledger rows can only be deleted while the
//! `_ledger_delete_token` row exists, which this module inserts and removes inside the same
//! SQL transaction.

use crate::audit;
use crate::backup::BackupFile;
use crate::customers::Money;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::ledger::{get_entry, not_deletable_reason, LedgerEntry};
use crate::mail::secrets::mailbox_key;
use crate::settings;
use crate::transactions::{BulkResult, TxnStatus};
use crate::Core;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const RESET_CONFIRM_TEXT: &str = "حذف";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteEffect {
    pub customer_id: i64,
    pub customer_name: String,
    pub currency: String,
    /// Negative = the customer's balance goes down.
    pub balance_delta_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnDeletePreview {
    pub count: i64,
    pub approved_count: i64,
    pub ledger_entry_count: i64,
    pub effects: Vec<DeleteEffect>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnDeleteResult {
    #[serde(flatten)]
    pub result: BulkResult,
    pub backup: Option<BackupFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDeletePreview {
    pub assigned_count: i64,
    pub approved_count: i64,
    pub ledger_entry_count: i64,
    pub balances: Vec<Money>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub backup: Option<BackupFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerDeletePreview {
    pub entries: Vec<LedgerEntry>,
    pub balance_before_minor: i64,
    pub balance_after_minor: i64,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetScope {
    pub transactions: bool,
    pub customers: bool,
    pub mailboxes: bool,
    pub settings: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPreview {
    pub transactions: i64,
    pub raw_emails: i64,
    pub pull_runs: i64,
    pub customers: i64,
    pub ledger_entries: i64,
    pub mailboxes: i64,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    pub backup: BackupFile,
}

/// Every column of a row as JSON (the audit snapshot).
fn snapshot(conn: &Connection, table: &str, where_sql: &str, args: &[&dyn rusqlite::ToSql]) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE {where_sql}"))?;
    let names: Vec<String> = stmt.column_names().map(str::to_string).collect();
    let rows = stmt.query_map(args, |r| {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            let v: rusqlite::types::Value = r.get(i)?;
            let j = match v {
                rusqlite::types::Value::Null => Value::Null,
                rusqlite::types::Value::Integer(i) => json!(i),
                rusqlite::types::Value::Real(f) => json!(f),
                rusqlite::types::Value::Text(t) => json!(t),
                rusqlite::types::Value::Blob(b) => json!(format!("<{} bytes>", b.len())),
            };
            m.insert(n.clone(), j);
        }
        Ok(Value::Object(m))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Run `f` with ledger deletes allowed (token inserted and removed inside the same transaction).
fn with_ledger_token<T>(conn: &Connection, f: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    conn.execute("INSERT INTO _ledger_delete_token (x) VALUES (1)", [])?;
    let r = f();
    conn.execute("DELETE FROM _ledger_delete_token", [])?;
    r
}

fn customer_name(conn: &Connection, id: i64) -> AppResult<String> {
    Ok(conn
        .query_row("SELECT name FROM customers WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?
        .unwrap_or_default())
}

impl Core {
    /// Backup into the backup folder when one is set (`None` otherwise; the UI warns first).
    fn optional_backup(&self) -> AppResult<Option<BackupFile>> {
        match self.backup_dir()? {
            Some(dir) => Ok(Some(self.backup_into(&dir)?)),
            None => Ok(None),
        }
    }

    // ===== Transactions =====

    pub fn txn_delete_preview(&self, ids: &[i64]) -> AppResult<TxnDeletePreview> {
        let conn = self.conn();
        let mut count = 0;
        let mut approved = 0;
        let mut entries = 0;
        let mut effects: Vec<DeleteEffect> = vec![];
        for &id in ids {
            let Some(status): Option<String> = conn
                .query_row("SELECT status FROM paypal_transactions WHERE id = ?1", params![id], |r| r.get(0))
                .optional()?
            else {
                continue;
            };
            count += 1;
            if TxnStatus::parse(&status) == TxnStatus::Approved {
                approved += 1;
            }
            let mut stmt = conn.prepare(
                "SELECT customer_id, currency, SUM(amount_minor), COUNT(*) FROM ledger_entries
                 WHERE paypal_transaction_id = ?1 GROUP BY customer_id, currency",
            )?;
            let rows = stmt.query_map(params![id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
            })?;
            for row in rows {
                let (cid, cur, sum, n) = row?;
                entries += n;
                match effects.iter_mut().find(|e| e.customer_id == cid && e.currency == cur) {
                    Some(e) => e.balance_delta_minor -= sum,
                    None => effects.push(DeleteEffect {
                        customer_id: cid,
                        customer_name: customer_name(&conn, cid)?,
                        currency: cur,
                        balance_delta_minor: -sum,
                    }),
                }
            }
        }
        effects.retain(|e| e.balance_delta_minor != 0);
        Ok(TxnDeletePreview { count, approved_count: approved, ledger_entry_count: entries, effects })
    }

    /// Delete transactions (and the ledger entries of approved ones). The source email stays,
    /// ignored as `deleted_by_user`, so the next pull does not bring it back; re-parse restores it.
    pub fn txn_delete(&self, ids: &[i64], reason: Option<&str>) -> AppResult<TxnDeleteResult> {
        let backup = if ids.len() > 1 { self.optional_backup()? } else { None };
        let now = self.now_iso();
        let reason = reason.map(str::trim).filter(|r| !r.is_empty());
        let conn = self.conn();
        let mut result = BulkResult::default();
        let existing: Vec<i64> = {
            let mut v = vec![];
            for &id in ids {
                let found: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM paypal_transactions WHERE id = ?1)",
                    params![id],
                    |r| r.get(0),
                )?;
                if found {
                    v.push(id);
                } else {
                    result.push(id, Err(AppError::not_found("المعاملة")));
                }
            }
            v
        };
        let tx = conn.unchecked_transaction()?;
        with_ledger_token(&tx, || {
            for &id in &existing {
                let txn = snapshot(&tx, "paypal_transactions", "id = ?1", &[&id])?;
                let entries = snapshot(&tx, "ledger_entries", "paypal_transaction_id = ?1", &[&id])?;
                tx.execute("DELETE FROM ledger_entries WHERE paypal_transaction_id = ?1", params![id])?;
                let raw: Option<i64> =
                    tx.query_row("SELECT raw_email_id FROM paypal_transactions WHERE id = ?1", params![id], |r| {
                        r.get(0)
                    })?;
                tx.execute("DELETE FROM paypal_transactions WHERE id = ?1", params![id])?;
                if let Some(raw) = raw {
                    tx.execute(
                        "UPDATE raw_emails SET parse_status = 'ignored', parse_reason = 'deleted_by_user' WHERE id = ?1",
                        params![raw],
                    )?;
                }
                audit::log(
                    &tx,
                    &now,
                    "txn.delete",
                    "transaction",
                    Some(id),
                    json!({ "reason": reason, "transaction": txn.first(), "ledgerEntries": entries }),
                )?;
            }
            Ok(())
        })?;
        tx.commit()?;
        for id in existing {
            result.push(id, Ok(()));
        }
        Ok(TxnDeleteResult { result, backup })
    }

    // ===== Customers =====

    pub fn customer_delete_preview(&self, id: i64) -> AppResult<CustomerDeletePreview> {
        let conn = self.conn();
        crate::customers::customer_ref(&conn, id)?;
        let (assigned, approved): (i64, i64) = conn.query_row(
            "SELECT COALESCE(SUM(status = 'pending_approval'), 0), COALESCE(SUM(status = 'approved'), 0)
             FROM paypal_transactions WHERE customer_id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let entries: i64 =
            conn.query_row("SELECT COUNT(*) FROM ledger_entries WHERE customer_id = ?1", params![id], |r| r.get(0))?;
        Ok(CustomerDeletePreview {
            assigned_count: assigned,
            approved_count: approved,
            ledger_entry_count: entries,
            balances: crate::customers::balances(&conn, id)?,
        })
    }

    /// Delete a customer and its whole ledger; its transactions go back to unassigned.
    pub fn customer_delete(&self, id: i64, confirm_name: &str) -> AppResult<DeleteResult> {
        let name = crate::customers::customer_ref(&self.conn(), id)?.name;
        if confirm_name.trim() != name {
            return Err(
                AppError::new(ErrorCode::ConfirmMismatch, "الاسم المكتوب لا يطابق اسم العميل").with_field("confirmName")
            );
        }
        let backup = self.optional_backup()?;
        let now = self.now_iso();
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        with_ledger_token(&tx, || {
            let customer = snapshot(&tx, "customers", "id = ?1", &[&id])?;
            let entries = snapshot(&tx, "ledger_entries", "customer_id = ?1", &[&id])?;
            let txns: Vec<i64> = {
                let mut stmt = tx.prepare("SELECT id FROM paypal_transactions WHERE customer_id = ?1")?;
                let v = stmt.query_map(params![id], |r| r.get(0))?.collect::<Result<_, _>>()?;
                v
            };
            tx.execute("DELETE FROM ledger_entries WHERE customer_id = ?1", params![id])?;
            tx.execute(
                "UPDATE paypal_transactions SET status = 'unassigned', customer_id = NULL, commission_mode = NULL,
                 commission_bps = NULL, commission_minor = NULL, customer_amount_minor = NULL, assigned_at = NULL,
                 approved_at = NULL, updated_at = ?1 WHERE customer_id = ?2",
                params![now, id],
            )?;
            tx.execute("DELETE FROM customers WHERE id = ?1", params![id])?;
            audit::log(
                &tx,
                &now,
                "customer.delete",
                "customer",
                Some(id),
                json!({ "customer": customer.first(), "ledgerEntries": entries, "unassignedTransactions": txns }),
            )
        })?;
        tx.commit()?;
        Ok(DeleteResult { backup })
    }

    // ===== Ledger entries =====

    /// The entry plus its pair (the entry that reverses it), when it is reversed.
    fn ledger_delete_set(&self, conn: &Connection, entry_id: i64) -> AppResult<Vec<LedgerEntry>> {
        let e = get_entry(conn, entry_id)?;
        let txn_type: Option<String> = match e.transaction_id {
            Some(t) => conn
                .query_row("SELECT type FROM paypal_transactions WHERE id = ?1", params![t], |r| r.get(0))
                .optional()?,
            None => None,
        };
        if let Some(reason) = not_deletable_reason(e.kind, txn_type.as_deref()) {
            return Err(AppError::new(ErrorCode::NotDeletable, reason));
        }
        let mut set = vec![];
        if let Some(rev) = e.reversed_by_entry_id {
            set.push(get_entry(conn, rev)?);
        }
        set.insert(0, e);
        Ok(set)
    }

    pub fn ledger_delete_preview(&self, entry_id: i64) -> AppResult<LedgerDeletePreview> {
        let conn = self.conn();
        let entries = self.ledger_delete_set(&conn, entry_id)?;
        let first = &entries[0];
        let before = crate::customers::balance_in(&conn, first.customer_id, &first.currency)?;
        let removed: i64 = entries.iter().map(|e| e.amount_minor).sum();
        Ok(LedgerDeletePreview { balance_before_minor: before, balance_after_minor: before - removed, entries })
    }

    /// Delete a payout, adjustment or manual reversal; a reversed entry goes with its reversal.
    pub fn ledger_delete_entry(&self, entry_id: i64, reason: Option<&str>) -> AppResult<DeleteResult> {
        // Validate before taking the backup.
        self.ledger_delete_set(&self.conn(), entry_id)?;
        let backup = self.optional_backup()?;
        let now = self.now_iso();
        let reason = reason.map(str::trim).filter(|r| !r.is_empty());
        let conn = self.conn();
        let set = self.ledger_delete_set(&conn, entry_id)?;
        let ids: Vec<i64> = set.iter().map(|e| e.id).collect();
        let tx = conn.unchecked_transaction()?;
        with_ledger_token(&tx, || {
            let mut snaps = vec![];
            for id in &ids {
                snaps.extend(snapshot(&tx, "ledger_entries", "id = ?1", &[id])?);
            }
            // Newest first: a reversal references the entry it reverses.
            for id in ids.iter().rev() {
                tx.execute("DELETE FROM ledger_entries WHERE id = ?1", params![id])?;
            }
            audit::log(
                &tx,
                &now,
                "ledger.delete",
                "ledger_entry",
                Some(entry_id),
                json!({ "reason": reason, "entries": snaps }),
            )
        })?;
        tx.commit()?;
        Ok(DeleteResult { backup })
    }

    // ===== Start fresh =====

    pub fn data_reset_preview(&self, scope: ResetScope) -> AppResult<ResetPreview> {
        let conn = self.conn();
        let count = |sql: &str| -> AppResult<i64> { Ok(conn.query_row(sql, [], |r| r.get(0))?) };
        let mut p = ResetPreview {
            transactions: 0,
            raw_emails: 0,
            pull_runs: 0,
            customers: 0,
            ledger_entries: 0,
            mailboxes: 0,
            notes: vec![],
        };
        if scope.transactions || scope.mailboxes {
            p.raw_emails = count("SELECT COUNT(*) FROM raw_emails")?;
            p.pull_runs = count("SELECT COUNT(*) FROM pull_runs")?;
        }
        if scope.transactions {
            p.transactions = count("SELECT COUNT(*) FROM paypal_transactions")?;
            p.notes.push("يُصفَّر موضع السحب لكل بريد، فيُعاد السحب من البداية".into());
        }
        if scope.customers {
            p.customers = count("SELECT COUNT(*) FROM customers")?;
            p.ledger_entries = count("SELECT COUNT(*) FROM ledger_entries")?;
            if !scope.transactions {
                p.notes.push("المعاملات المخصّصة والمعتمدة ترجع غير مخصّصة".into());
            }
        } else if scope.transactions {
            p.ledger_entries = count("SELECT COUNT(*) FROM ledger_entries WHERE paypal_transaction_id IS NOT NULL")?;
            if p.ledger_entries > 0 {
                p.notes.push("قيود الدفتر المرتبطة بالمعاملات تُحذف، فتتغيّر أرصدة العملاء؛ الدفعات والتسويات تبقى".into());
            }
        }
        if scope.mailboxes {
            p.mailboxes = count("SELECT COUNT(*) FROM mailboxes")?;
            p.notes.push("تُحذف كلمات مرور البريد من خزنة ويندوز".into());
            if !scope.transactions {
                p.notes.push("المعاملات تبقى لكن تُفصل عن رسائلها وبريدها".into());
            }
        }
        if scope.settings {
            p.notes.push("الإعدادات تعود للافتراضي؛ كلمة القفل تبقى".into());
        }
        p.notes.push("تُؤخذ نسخة احتياطية كاملة قبل الحذف (للتراجع: الإعدادات ← النسخ الاحتياطي ← استعادة)".into());
        Ok(p)
    }

    /// "Start fresh". A full backup is mandatory first (into the backup folder, or
    /// `<data dir>/pre-reset` when none is set).
    pub fn data_reset(&self, scope: ResetScope, confirm_text: &str) -> AppResult<ResetResult> {
        if confirm_text.trim() != RESET_CONFIRM_TEXT {
            return Err(AppError::new(ErrorCode::ConfirmMismatch, format!("اكتب «{RESET_CONFIRM_TEXT}» للتأكيد"))
                .with_field("confirmText"));
        }
        let preview = self.data_reset_preview(scope)?;
        let dir = self.backup_dir()?.unwrap_or_else(|| self.data_dir.join("pre-reset"));
        let backup = self.backup_into(&dir).map_err(|e| {
            AppError::new(ErrorCode::BackupFailed, format!("لم يُنفَّذ الحذف: تعذّرت النسخة الاحتياطية ({})", e.message_ar))
        })?;
        let now = self.now_iso();
        let mailbox_ids: Vec<i64> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT id FROM mailboxes")?;
            let v = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            v
        };
        {
            let conn = self.conn();
            let tx = conn.unchecked_transaction()?;
            with_ledger_token(&tx, || {
                if scope.customers {
                    tx.execute("DELETE FROM ledger_entries", [])?;
                    tx.execute(
                        "UPDATE paypal_transactions SET status = CASE WHEN status = 'excluded' THEN 'excluded' ELSE 'unassigned' END,
                         customer_id = NULL, commission_mode = NULL, commission_bps = NULL, commission_minor = NULL,
                         customer_amount_minor = NULL, assigned_at = NULL, approved_at = NULL, updated_at = ?1",
                        params![now],
                    )?;
                    tx.execute("DELETE FROM customers", [])?;
                }
                if scope.transactions {
                    tx.execute("DELETE FROM ledger_entries WHERE paypal_transaction_id IS NOT NULL", [])?;
                    tx.execute("DELETE FROM paypal_transactions", [])?;
                    tx.execute("DELETE FROM raw_emails", [])?;
                    tx.execute("DELETE FROM pull_runs", [])?;
                    tx.execute("UPDATE mailboxes SET last_uid = 0, uid_validity = NULL, last_pulled_at = NULL", [])?;
                }
                if scope.mailboxes {
                    tx.execute("UPDATE paypal_transactions SET raw_email_id = NULL, mailbox_id = NULL", [])?;
                    tx.execute("DELETE FROM raw_emails", [])?;
                    tx.execute("DELETE FROM pull_runs", [])?;
                    tx.execute("DELETE FROM mailboxes", [])?;
                }
                if scope.settings {
                    tx.execute(
                        "DELETE FROM settings WHERE key NOT IN (?1, ?2, 'parser_version')",
                        params![settings::K_LOCK_ENABLED, settings::K_LOCK_HASH],
                    )?;
                }
                // The full rows are in the mandatory backup; the log records what was removed.
                audit::log(
                    &tx,
                    &now,
                    "data.reset",
                    "data",
                    None,
                    json!({ "scope": scope, "removed": preview_counts(&preview), "backup": backup.path }),
                )
            })?;
            tx.commit()?;
        }
        if scope.mailboxes {
            for id in mailbox_ids {
                if let Err(e) = self.secrets.delete(&mailbox_key(id)) {
                    eprintln!("could not delete mailbox password {id}: {e}");
                }
            }
        }
        Ok(ResetResult { backup })
    }
}

fn preview_counts(p: &ResetPreview) -> Value {
    json!({
        "transactions": p.transactions, "rawEmails": p.raw_emails, "pullRuns": p.pull_runs,
        "customers": p.customers, "ledgerEntries": p.ledger_entries, "mailboxes": p.mailboxes,
    })
}
