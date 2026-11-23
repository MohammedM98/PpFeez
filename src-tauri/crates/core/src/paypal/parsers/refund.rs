//! "You sent a refund" / "Refund to ..." emails (money returned to a payer).

use crate::paypal::amount::find_first;
use crate::paypal::parser::{
    email_in, labeled, labeled_money, labeled_txn_id, lower, parse_paypal_date, subject_has, ParseError, PaypalParser,
};
use crate::paypal::{ParsedEmail, ParsedTransaction};
use crate::transactions::TxnType;
use regex::Regex;
use std::sync::OnceLock;

pub struct RefundParser;

pub const REFUND_ID: &[&str] = &["Refund transaction ID", "Refund ID", "Transaction ID"];
pub const ORIGINAL_ID: &[&str] = &["Original transaction ID", "Original transaction", "Original payment ID", "For transaction"];
pub const AMOUNT: &[&str] = &["Refund amount", "Amount refunded", "Total refund", "Refunded amount", "Amount"];
pub const DATE: &[&str] = &["Refund date", "Transaction date", "Date"];
pub const TO_NAME: &[&str] = &["Refunded to", "Refund to", "Buyer", "Recipient"];

fn refund_to_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)refund(?:\s+of\s+.+?)?\s+to\s+(?P<name>[^\d$€£¥₺].*?)\s*$").unwrap())
}

impl PaypalParser for RefundParser {
    fn name(&self) -> &'static str {
        "paypal_refund_sent_en"
    }

    fn matches(&self, email: &ParsedEmail) -> bool {
        let s = lower(&email.subject);
        if s.contains("received a refund") || s.contains("refund from") {
            return false;
        }
        subject_has(email, &["you sent a refund", "you've sent a refund", "you have sent a refund", "refund to", "you refunded"])
    }

    fn parse(&self, email: &ParsedEmail) -> Result<ParsedTransaction, ParseError> {
        let related = labeled_txn_id(email, ORIGINAL_ID);
        let mut own = labeled_txn_id(email, REFUND_ID);
        if own.is_some() && own == related {
            own = None;
        }
        let paypal_txn_id = match (own, &related) {
            (Some(id), _) => id,
            // Only the original id is known: derive a stable id for the refund row.
            (None, Some(orig)) => format!("REFUND-{orig}"),
            (None, None) => return Err(ParseError { field: "paypal_txn_id" }),
        };
        let gross = labeled_money(email, AMOUNT)
            .or_else(|| find_first(&email.subject))
            .or_else(|| email.lines.iter().find(|l| lower(l).contains("refund")).and_then(|l| find_first(l)))
            .ok_or(ParseError { field: "gross" })?;
        let payer_name = labeled(email, TO_NAME)
            .or_else(|| refund_to_re().captures(&email.subject).map(|c| c["name"].to_string()))
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty() && !n.contains('@'));
        let payer_email = labeled(email, &["Buyer email", "Recipient email", "Email"]).and_then(|v| email_in(&v));
        let occurred_at = labeled(email, DATE)
            .and_then(|d| parse_paypal_date(&d, email.received_at))
            .unwrap_or(email.received_at);
        Ok(ParsedTransaction {
            kind: TxnType::Refund,
            paypal_txn_id,
            related_txn_id: related,
            gross_minor: gross.minor,
            currency: gross.currency,
            fee_minor: None,
            occurred_at,
            payer_name,
            payer_email,
            payer_note: None,
        })
    }
}
