//! "You've got money" / "You received a payment" / "Payment received from ..." emails.

use crate::paypal::amount::find_first;
use crate::paypal::parser::{
    email_in, labeled, labeled_money, labeled_txn_id, lower, parse_paypal_date, subject_has, txn_id_in, ParseError,
    PaypalParser,
};
use crate::paypal::{ParsedEmail, ParsedTransaction};
use crate::transactions::TxnType;
use regex::Regex;
use std::sync::OnceLock;

pub struct PaymentReceivedParser;

/// Label tables (English). Order matters: most specific first.
pub const TXN_ID: &[&str] = &["Transaction ID", "Transaction number", "Receipt number"];
pub const GROSS: &[&str] = &["Amount received", "Gross amount", "Payment amount", "Total received", "Amount", "Total"];
pub const FEE: &[&str] = &["PayPal fee", "Fee amount", "Fees", "Fee"];
pub const NET: &[&str] = &["Net amount", "Net"];
pub const DATE: &[&str] = &["Transaction date", "Date"];
pub const PAYER_NAME: &[&str] = &["Sender name", "Buyer name", "Received from", "From", "Sender", "Buyer"];
pub const PAYER_EMAIL: &[&str] = &["Sender email", "Buyer email", "Sender's email", "Email address", "Email"];
pub const NOTE: &[&str] = &["Message from", "Note from", "Notes from", "Message", "Note"];

fn sent_you_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(?P<name>.+?)\s+(?:has\s+)?sent\s+you\s+(?P<amount>.+)$").unwrap())
}

fn subject_from_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:received|payment)\s+(?:of\s+)?(?:.*?\s)?from\s+(?P<name>.+?)\s*$").unwrap())
}

/// Strip an email address in parentheses or angle brackets from a name.
fn clean_name(s: &str) -> Option<String> {
    let mut n = s.to_string();
    for (open, close) in [('(', ')'), ('<', '>')] {
        if let (Some(a), Some(b)) = (n.find(open), n.rfind(close)) {
            if a < b && n[a..b].contains('@') {
                n = format!("{}{}", &n[..a], &n[b + 1..]);
            }
        }
    }
    let n = n.trim().trim_end_matches(['.', ',', ':', '!']).trim().to_string();
    if n.is_empty() || n.contains('@') || n.len() > 120 {
        None
    } else {
        Some(n)
    }
}

/// "Note from John Doe: text", "Note from John Doe:" + next line, or "Message: text".
fn note(email: &ParsedEmail) -> Option<String> {
    let clean = |s: &str| s.trim().trim_matches(['"', '“', '”']).trim().to_string();
    for (i, line) in email.lines.iter().enumerate() {
        let l = lower(line);
        let Some(label) = NOTE.iter().find(|n| l.starts_with(&lower(n))) else { continue };
        let rest = &line[label.len().min(line.len())..];
        if rest.chars().next().map(|c| c.is_alphanumeric()).unwrap_or(false) {
            continue; // e.g. "Messages"
        }
        let value = match rest.find(':') {
            Some(p) => clean(&rest[p + 1..]),
            // "Note from John Doe" without colon: the note is on the next line.
            None if label.ends_with("from") => String::new(),
            None => clean(rest),
        };
        let value = if value.is_empty() { email.lines.get(i + 1).map(|n| clean(n)).unwrap_or_default() } else { value };
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

impl PaypalParser for PaymentReceivedParser {
    fn name(&self) -> &'static str {
        "paypal_payment_received_en"
    }

    fn matches(&self, email: &ParsedEmail) -> bool {
        let s = lower(&email.subject);
        if s.contains("refund") || s.contains("reversed") || s.contains("you sent") {
            return false;
        }
        subject_has(
            email,
            &[
                "you've got money",
                "you have got money",
                "you received a payment",
                "you've received",
                "you received",
                "payment received",
                "sent you",
            ],
        )
    }

    fn parse(&self, email: &ParsedEmail) -> Result<ParsedTransaction, ParseError> {
        let paypal_txn_id = labeled_txn_id(email, TXN_ID)
            .or_else(|| {
                // "Transaction ID: XYZ" glued to other text on the same line.
                email.lines.iter().find(|l| lower(l).contains("transaction id")).and_then(|l| txn_id_in(l))
            })
            .ok_or(ParseError { field: "paypal_txn_id" })?;

        // "{name} sent you {amount}" line, used for name and as an amount fallback.
        let sent_you = email
            .lines
            .iter()
            .chain(std::iter::once(&email.subject))
            .find_map(|l| sent_you_re().captures(l).map(|c| (c["name"].to_string(), c["amount"].to_string())));

        let gross = labeled_money(email, GROSS)
            .or_else(|| sent_you.as_ref().and_then(|(_, a)| find_first(a)))
            .or_else(|| find_first(&email.subject))
            .ok_or(ParseError { field: "gross" })?;

        let fee = labeled_money(email, FEE)
            .filter(|f| f.currency == gross.currency && f.minor <= gross.minor)
            .map(|f| f.minor)
            .or_else(|| {
                labeled_money(email, NET)
                    .filter(|n| n.currency == gross.currency && n.minor <= gross.minor)
                    .map(|n| gross.minor - n.minor)
            });

        let payer_name = sent_you
            .as_ref()
            .and_then(|(n, _)| clean_name(n))
            .or_else(|| labeled(email, PAYER_NAME).and_then(|v| clean_name(&v)))
            .or_else(|| subject_from_re().captures(&email.subject).and_then(|c| clean_name(&c["name"])));

        let payer_email = labeled(email, PAYER_EMAIL).and_then(|v| email_in(&v)).or_else(|| {
            // "John Doe (john@example.com)" next to the payer name.
            let name = payer_name.as_deref()?;
            email.lines.iter().filter(|l| l.contains(name)).find_map(|l| email_in(l))
        });

        let payer_note = note(email);

        let occurred_at =
            labeled(email, DATE).and_then(|d| parse_paypal_date(&d, email.received_at)).unwrap_or(email.received_at);

        Ok(ParsedTransaction {
            kind: TxnType::Payment,
            paypal_txn_id,
            related_txn_id: None,
            gross_minor: gross.minor,
            currency: gross.currency,
            fee_minor: fee,
            occurred_at,
            payer_name,
            payer_email,
            payer_note,
        })
    }
}
