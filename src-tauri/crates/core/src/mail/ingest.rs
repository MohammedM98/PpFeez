//! Turning a fetched message into a `raw_emails` row and, when it is a verified PayPal
//! payment/refund/reversal, a `paypal_transactions` row (SPEC §5.1 step 5).

use super::verify::{self, Verdict};
use crate::audit;
use crate::clock::iso;
use crate::error::{is_unique_violation, AppResult};
use crate::paypal::domains::DomainSet;
use crate::paypal::{parse_email, Event, Outcome, ParsedEmail, ParsedTransaction};
use chrono::{DateTime, Utc};
use mail_parser::MessageParser;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

/// The fields of a message that are stored and later re-parsed.
#[derive(Debug, Clone)]
pub struct StoredEmail {
    pub message_id: String,
    pub from_addr: String,
    pub subject: String,
    pub received_at: DateTime<Utc>,
    /// Value of the top-most `Authentication-Results` header only.
    pub auth_results: Option<String>,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
}

/// Parse raw RFC 5322 bytes. `fallback_id` is used when the message has no Message-ID.
pub fn extract(raw: &[u8], fallback_id: &str, now: DateTime<Utc>) -> Option<StoredEmail> {
    let msg = MessageParser::default().parse(raw)?;
    let from_addr =
        msg.from().and_then(|f| f.first().and_then(|a| a.address().map(str::to_string))).unwrap_or_default();
    let auth_results = msg
        .headers()
        .iter()
        .find(|h| h.raw_name().eq_ignore_ascii_case("Authentication-Results"))
        .map(|h| String::from_utf8_lossy(h.raw_value()).trim().to_string());
    let received_at = msg.date().and_then(|d| DateTime::<Utc>::from_timestamp(d.to_timestamp(), 0)).unwrap_or(now);
    // Only keep HTML that the message really has (mail-parser converts text to HTML otherwise).
    let has_html = msg.html_body().any(|p| matches!(p.kind(), mail_parser::PartKind::Html));
    let body_html = if has_html { msg.body_html(0).map(|c| c.into_owned()) } else { None };
    let body_text = msg.body_text(0).map(|c| c.into_owned());
    Some(StoredEmail {
        message_id: msg
            .message_id()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback_id.to_string()),
        from_addr,
        subject: msg.subject().unwrap_or_default().to_string(),
        received_at,
        auth_results,
        body_html,
        body_text,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ingested {
    New,
    Duplicate,
    Ignored,
    Failed,
    /// Message-ID already stored: skipped (counted as duplicate).
    AlreadySeen,
}

/// The parse result for a stored email: `(status, reason, parser, transaction)`.
pub fn evaluate(
    e: &StoredEmail,
    domains: &DomainSet,
) -> (&'static str, Option<String>, Option<String>, Option<ParsedTransaction>) {
    let verdict = verify::verify(&e.from_addr, e.auth_results.as_deref(), domains);
    if verdict != Verdict::Ok {
        return ("ignored", verdict.reason().map(str::to_string), None, None);
    }
    let parsed =
        ParsedEmail::new(&e.subject, &e.from_addr, e.received_at, e.body_html.as_deref(), e.body_text.as_deref());
    match parse_email(&parsed) {
        Outcome::Parsed { parser, txn } => ("parsed", None, Some(parser), Some(txn)),
        Outcome::Ignored { reason } => ("ignored", Some(reason), None, None),
        Outcome::Failed { reason, parser } => ("failed", Some(reason), parser, None),
    }
}

/// What applying a parsed email did to the transactions table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    Inserted,
    /// The PayPal transaction already exists (nothing changed).
    Duplicate,
    /// An eCheck clearance or on-hold notice updated the existing transaction (reason code).
    Updated(&'static str),
    /// An on-hold notice for a transaction that does not exist yet: nothing created.
    HoldWithoutTxn,
}

/// Apply a parsed transaction (SPEC §5.3): insert it, or for eCheck clearance / on-hold notices
/// update the transaction with the same PayPal id. Runs inside the caller's SQL transaction.
pub fn apply_transaction(
    conn: &Connection,
    now: &str,
    mailbox_id: i64,
    raw_email_id: i64,
    t: &ParsedTransaction,
) -> AppResult<Applied> {
    let existing: Option<(i64, Option<String>)> = conn
        .query_row(
            "SELECT id, hold_status FROM paypal_transactions WHERE paypal_txn_id = ?1",
            params![t.paypal_txn_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match (t.event, existing) {
        (Event::EcheckCleared, Some((id, hold))) => {
            if hold.as_deref() == Some("pending_echeck") {
                conn.execute(
                    "UPDATE paypal_transactions SET hold_status = NULL, updated_at = ?1 WHERE id = ?2",
                    params![now, id],
                )?;
                audit::log(
                    conn,
                    now,
                    "txn.echeck_cleared",
                    "transaction",
                    Some(id),
                    json!({ "rawEmailId": raw_email_id }),
                )?;
                return Ok(Applied::Updated("echeck_cleared"));
            }
            Ok(Applied::Duplicate)
        }
        (Event::OnHold, Some((id, hold))) => {
            if hold.is_none() {
                conn.execute(
                    "UPDATE paypal_transactions SET hold_status = 'on_hold', updated_at = ?1 WHERE id = ?2",
                    params![now, id],
                )?;
                audit::log(conn, now, "txn.on_hold", "transaction", Some(id), json!({ "rawEmailId": raw_email_id }))?;
                return Ok(Applied::Updated("hold_applied"));
            }
            Ok(Applied::Duplicate)
        }
        (Event::OnHold, None) => Ok(Applied::HoldWithoutTxn),
        (_, Some(_)) => Ok(Applied::Duplicate),
        (_, None) => {
            insert_transaction(conn, now, mailbox_id, raw_email_id, t)?;
            Ok(Applied::Inserted)
        }
    }
}

/// Insert a parsed transaction; `Ok(false)` when its PayPal id already exists.
pub fn insert_transaction(
    conn: &Connection,
    now: &str,
    mailbox_id: i64,
    raw_email_id: i64,
    t: &ParsedTransaction,
) -> AppResult<bool> {
    let hold = if t.event == Event::EcheckPending { Some("pending_echeck") } else { None };
    let review_reason = if t.needs_review { Some("generic_parser") } else { None };
    let r = conn.execute(
        "INSERT INTO paypal_transactions (mailbox_id, raw_email_id, source, paypal_txn_id, related_txn_id, type,
         payer_name, payer_email, payer_note, currency, gross_minor, fee_minor, net_minor, fee_is_estimated,
         occurred_at, status, needs_review, review_reason, hold_status, created_at, updated_at)
         VALUES (?1, ?2, 'email', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, 'unassigned', ?14, ?15, ?16, ?17, ?17)",
        params![
            mailbox_id,
            raw_email_id,
            t.paypal_txn_id,
            t.related_txn_id,
            t.kind.as_str(),
            t.payer_name,
            t.payer_email,
            t.payer_note,
            t.currency,
            t.gross_minor,
            t.fee_minor,
            t.fee_minor.map(|f| t.gross_minor - f),
            iso(t.occurred_at),
            t.needs_review as i64,
            review_reason,
            hold,
            now
        ],
    );
    match r {
        Ok(_) => {
            let id = conn.last_insert_rowid();
            audit::log(
                conn,
                now,
                "txn.import",
                "transaction",
                Some(id),
                json!({ "rawEmailId": raw_email_id, "type": t.kind.as_str(), "grossMinor": t.gross_minor,
                        "currency": t.currency, "needsReview": t.needs_review, "holdStatus": hold }),
            )?;
            Ok(true)
        }
        Err(e) if is_unique_violation(&e) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Update a raw email after applying its transaction; returns the matching pull outcome.
pub fn record_applied(conn: &Connection, raw_id: i64, applied: Applied) -> AppResult<Ingested> {
    Ok(match applied {
        Applied::Inserted => Ingested::New,
        Applied::Duplicate => {
            conn.execute("UPDATE raw_emails SET parse_reason = 'duplicate_txn' WHERE id = ?1", params![raw_id])?;
            Ingested::Duplicate
        }
        Applied::Updated(reason) => {
            conn.execute("UPDATE raw_emails SET parse_reason = ?1 WHERE id = ?2", params![reason, raw_id])?;
            Ingested::Duplicate
        }
        Applied::HoldWithoutTxn => {
            conn.execute(
                "UPDATE raw_emails SET parse_status = 'ignored', parse_reason = 'hold_notice' WHERE id = ?1",
                params![raw_id],
            )?;
            Ingested::Ignored
        }
    })
}

/// Store one message and create its transaction. Runs inside the caller's SQL transaction.
pub fn ingest(
    conn: &Connection,
    now: &str,
    mailbox_id: i64,
    uid: u32,
    e: &StoredEmail,
    domains: &DomainSet,
) -> AppResult<Ingested> {
    let exists: Option<i64> = conn
        .query_row("SELECT id FROM raw_emails WHERE message_id = ?1", params![e.message_id], |r| r.get(0))
        .optional()?;
    if exists.is_some() {
        return Ok(Ingested::AlreadySeen);
    }
    let (status, reason, parser, txn) = evaluate(e, domains);
    conn.execute(
        "INSERT INTO raw_emails (mailbox_id, imap_uid, message_id, from_addr, subject, received_at, auth_results,
         body_html, body_text, parse_status, parse_reason, parser_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            mailbox_id,
            uid,
            e.message_id,
            e.from_addr,
            e.subject,
            iso(e.received_at),
            e.auth_results,
            e.body_html,
            e.body_text,
            status,
            reason,
            parser,
            now
        ],
    )?;
    let raw_id = conn.last_insert_rowid();
    match (status, txn) {
        ("parsed", Some(t)) => {
            let applied = apply_transaction(conn, now, mailbox_id, raw_id, &t)?;
            record_applied(conn, raw_id, applied)
        }
        ("ignored", _) => Ok(Ingested::Ignored),
        _ => Ok(Ingested::Failed),
    }
}

/// Fill what an earlier parse left empty on an existing transaction (SPEC: backfill after a
/// parser improvement). Only empty fields are filled — payer name, email, note, related id, and
/// the fee while the transaction is not approved. Amounts, currency and the customer never
/// change. `needs_review` is cleared only when a specialised parser fully matches (same amount
/// and currency); for an unassigned reviewed transaction its type is corrected too.
/// Returns the names of the fields changed (empty when nothing changed).
pub fn backfill_transaction(
    conn: &Connection,
    now: &str,
    txn_id: i64,
    t: &ParsedTransaction,
    parser: &str,
) -> AppResult<Vec<&'static str>> {
    use crate::transactions::{derive, load_row, TxnStatus};
    let row = load_row(conn, txn_id)?;
    let mut changed: Vec<&'static str> = vec![];
    let fill = |old: &Option<String>, new: &Option<String>| -> Option<String> {
        match (old, new) {
            (None, Some(v)) if !v.trim().is_empty() => Some(v.clone()),
            _ => None,
        }
    };
    if let Some(v) = fill(&row.payer_name, &t.payer_name) {
        conn.execute("UPDATE paypal_transactions SET payer_name = ?1 WHERE id = ?2", params![v, txn_id])?;
        changed.push("payerName");
    }
    if let Some(v) = fill(&row.payer_email, &t.payer_email) {
        conn.execute("UPDATE paypal_transactions SET payer_email = ?1 WHERE id = ?2", params![v, txn_id])?;
        changed.push("payerEmail");
    }
    if let Some(v) = fill(&row.payer_note, &t.payer_note) {
        conn.execute("UPDATE paypal_transactions SET payer_note = ?1 WHERE id = ?2", params![v, txn_id])?;
        changed.push("payerNote");
    }
    if let Some(v) = fill(&row.related_txn_id, &t.related_txn_id) {
        conn.execute("UPDATE paypal_transactions SET related_txn_id = ?1 WHERE id = ?2", params![v, txn_id])?;
        changed.push("relatedTxnId");
    }
    let same_money = t.gross_minor == row.gross_minor && t.currency == row.currency;
    if row.fee_minor.is_none() && row.status != TxnStatus::Approved && same_money {
        if let Some(fee) = t.fee_minor.filter(|f| *f <= row.gross_minor) {
            let rule = if row.status == TxnStatus::PendingApproval { row.rule() } else { None };
            if let Ok(d) = derive(row.gross_minor, Some(fee), rule) {
                conn.execute(
                    "UPDATE paypal_transactions SET fee_minor = ?1, fee_is_estimated = 0, net_minor = ?2,
                     commission_minor = ?3, customer_amount_minor = ?4 WHERE id = ?5",
                    params![fee, d.net_minor, d.commission_minor, d.customer_amount_minor, txn_id],
                )?;
                changed.push("feeMinor");
            }
        }
    }
    let specialised = parser != "paypal_generic" && !t.needs_review;
    if row.needs_review && specialised && same_money {
        if row.status == TxnStatus::Unassigned && row.kind != t.kind {
            conn.execute("UPDATE paypal_transactions SET type = ?1 WHERE id = ?2", params![t.kind.as_str(), txn_id])?;
            changed.push("type");
        }
        conn.execute("UPDATE paypal_transactions SET needs_review = 0 WHERE id = ?1", params![txn_id])?;
        changed.push("needsReview");
    }
    if !changed.is_empty() {
        conn.execute("UPDATE paypal_transactions SET updated_at = ?1 WHERE id = ?2", params![now, txn_id])?;
        audit::log(
            conn,
            now,
            "txn.backfill",
            "transaction",
            Some(txn_id),
            json!({ "fields": changed, "parser": parser }),
        )?;
    }
    Ok(changed)
}
