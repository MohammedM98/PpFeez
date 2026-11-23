//! Stored emails screen (SPEC §5.4, §6.6): list, view, re-parse without contacting the
//! mailbox, and manual ignore.

use crate::clock::parse_iso;
use crate::error::{AppError, AppResult};
use crate::mail::ingest::{evaluate, insert_transaction, StoredEmail};
use crate::paypal::reason_ar;
use crate::transactions::{escape_like, BulkResult};
use crate::Core;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    Parsed,
    Failed,
    Ignored,
}

impl ParseStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ParseStatus::Parsed => "parsed",
            ParseStatus::Failed => "failed",
            ParseStatus::Ignored => "ignored",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "parsed" => ParseStatus::Parsed,
            "failed" => ParseStatus::Failed,
            _ => ParseStatus::Ignored,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEmailSummary {
    pub id: i64,
    pub mailbox_label: String,
    pub from_addr: String,
    pub subject: String,
    pub received_at: String,
    pub parse_status: ParseStatus,
    pub parse_reason: Option<String>,
    pub parse_reason_ar: Option<String>,
    pub transaction_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEmail {
    #[serde(flatten)]
    pub summary: RawEmailSummary,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub parser_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

const SELECT: &str = "SELECT e.*, m.label AS mailbox_label,
     (SELECT t.id FROM paypal_transactions t WHERE t.raw_email_id = e.id ORDER BY t.id LIMIT 1) AS transaction_id
     FROM raw_emails e JOIN mailboxes m ON m.id = e.mailbox_id";

fn summary_from_row(r: &Row<'_>) -> rusqlite::Result<RawEmailSummary> {
    let reason: Option<String> = r.get("parse_reason")?;
    Ok(RawEmailSummary {
        id: r.get("id")?,
        mailbox_label: r.get("mailbox_label")?,
        from_addr: r.get("from_addr")?,
        subject: r.get("subject")?,
        received_at: r.get("received_at")?,
        parse_status: ParseStatus::parse(&r.get::<_, String>("parse_status")?),
        parse_reason_ar: reason.as_deref().map(reason_ar),
        parse_reason: reason,
        transaction_id: r.get("transaction_id")?,
    })
}

fn load(conn: &Connection, id: i64) -> AppResult<(RawEmail, i64, StoredEmail)> {
    conn.query_row(&format!("{SELECT} WHERE e.id = ?1"), params![id], |r| {
        let summary = summary_from_row(r)?;
        let email = RawEmail {
            body_html: r.get("body_html")?,
            body_text: r.get("body_text")?,
            parser_name: r.get("parser_name")?,
            summary,
        };
        let stored = StoredEmail {
            message_id: r.get("message_id")?,
            from_addr: email.summary.from_addr.clone(),
            subject: email.summary.subject.clone(),
            received_at: parse_iso(&email.summary.received_at).unwrap_or_default(),
            auth_results: r.get("auth_results")?,
            body_html: email.body_html.clone(),
            body_text: email.body_text.clone(),
        };
        Ok((email, r.get("mailbox_id")?, stored))
    })
    .optional()?
    .ok_or_else(|| AppError::not_found("الرسالة"))
}

impl Core {
    pub fn emails_list(&self, status: ParseStatus, search: Option<&str>, page: i64, page_size: i64) -> AppResult<Page<RawEmailSummary>> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 500);
        let conn = self.conn();
        let mut where_sql = "e.parse_status = ?1".to_string();
        let mut args: Vec<rusqlite::types::Value> = vec![status.as_str().to_string().into()];
        if let Some(s) = search.map(str::trim).filter(|s| !s.is_empty()) {
            where_sql.push_str(" AND (e.subject LIKE ?2 ESCAPE '\\' OR e.from_addr LIKE ?2 ESCAPE '\\')");
            args.push(format!("%{}%", escape_like(s)).into());
        }
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM raw_emails e WHERE {where_sql}"),
            rusqlite::params_from_iter(args.iter()),
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(&format!(
            "{SELECT} WHERE {where_sql} ORDER BY e.received_at DESC, e.id DESC LIMIT {page_size} OFFSET {}",
            (page - 1) * page_size
        ))?;
        let items = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), summary_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Page { items, total, page, page_size })
    }

    pub fn email_get(&self, id: i64) -> AppResult<RawEmail> {
        Ok(load(&self.conn(), id)?.0)
    }

    /// Run the current parsers again on stored emails that are not parsed yet.
    pub fn email_reparse(&self, ids: &[i64]) -> AppResult<BulkResult> {
        let mut result = BulkResult::default();
        for &id in ids {
            let r = (|| -> AppResult<()> {
                let now = self.now_iso();
                let conn = self.conn();
                let (email, mailbox_id, stored) = load(&conn, id)?;
                if email.summary.parse_status == ParseStatus::Parsed {
                    return Err(AppError::invalid_transition("الرسالة محلَّلة مسبقاً"));
                }
                let (status, reason, parser, txn) = evaluate(&stored);
                let tx = conn.unchecked_transaction()?;
                let mut reason = reason;
                if let Some(t) = &txn {
                    if !insert_transaction(&tx, &now, mailbox_id, id, t)? {
                        reason = Some("duplicate_txn".into());
                    }
                }
                tx.execute(
                    "UPDATE raw_emails SET parse_status = ?1, parse_reason = ?2, parser_name = ?3 WHERE id = ?4",
                    params![status, reason, parser, id],
                )?;
                tx.commit()?;
                if status == "parsed" {
                    Ok(())
                } else {
                    let why = reason.as_deref().map(reason_ar).unwrap_or_default();
                    Err(AppError::validation("parse", format!("لم تُحلَّل الرسالة: {why}")))
                }
            })();
            result.push(id, r);
        }
        Ok(result)
    }

    pub fn email_set_ignored(&self, id: i64) -> AppResult<()> {
        let conn = self.conn();
        let (email, _, _) = load(&conn, id)?;
        if email.summary.parse_status == ParseStatus::Parsed && email.summary.transaction_id.is_some() {
            return Err(AppError::invalid_transition("الرسالة مرتبطة بمعاملة؛ استبعد المعاملة بدلاً من ذلك"));
        }
        conn.execute(
            "UPDATE raw_emails SET parse_status = 'ignored', parse_reason = 'manual' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }
}
