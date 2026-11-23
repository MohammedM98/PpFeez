//! Disputes / chargebacks / "payment reversed" emails.

use crate::paypal::amount::find_first;
use crate::paypal::parser::{
    labeled, labeled_money, labeled_txn_id, lower, parse_paypal_date, subject_has, ParseError, PaypalParser,
};
use crate::paypal::{ParsedEmail, ParsedTransaction};
use crate::transactions::TxnType;

pub struct ReversalParser;

pub const REVERSAL_ID: &[&str] = &["Reversal transaction ID", "Reversal ID"];
pub const CASE_ID: &[&str] = &["Case ID", "Case number", "Dispute ID"];
pub const ORIGINAL_ID: &[&str] = &["Original transaction ID", "Transaction ID", "Original transaction"];
pub const AMOUNT: &[&str] = &["Reversed amount", "Amount reversed", "Disputed amount", "Chargeback amount", "Amount"];
pub const DATE: &[&str] = &["Reversal date", "Date"];
pub const BUYER: &[&str] = &["Buyer name", "Buyer", "Filed by"];

impl PaypalParser for ReversalParser {
    fn name(&self) -> &'static str {
        "paypal_reversal_en"
    }

    fn matches(&self, email: &ParsedEmail) -> bool {
        let s = lower(&email.subject);
        if s.contains("refund") && !s.contains("chargeback") {
            return false;
        }
        subject_has(email, &["reversed", "reversal", "chargeback", "dispute", "a case"])
    }

    fn parse(&self, email: &ParsedEmail) -> Result<ParsedTransaction, ParseError> {
        let original = labeled_txn_id(email, ORIGINAL_ID);
        let reversal_id = labeled_txn_id(email, REVERSAL_ID).filter(|id| Some(id) != original.as_ref());
        let case_id = labeled(email, CASE_ID)
            .and_then(|v| v.split_whitespace().next().map(str::to_string))
            .filter(|v| v.chars().any(|c| c.is_ascii_digit()));
        let paypal_txn_id = match (reversal_id, &case_id, &original) {
            (Some(id), _, _) => id,
            (None, Some(case), _) => format!("REV-{case}"),
            (None, None, Some(orig)) => format!("REV-{orig}"),
            (None, None, None) => return Err(ParseError { field: "paypal_txn_id" }),
        };
        let gross =
            labeled_money(email, AMOUNT).or_else(|| find_first(&email.subject)).ok_or(ParseError { field: "gross" })?;
        let occurred_at =
            labeled(email, DATE).and_then(|d| parse_paypal_date(&d, email.received_at)).unwrap_or(email.received_at);
        let payer_name = labeled(email, BUYER).filter(|n| !n.contains('@'));
        let note = labeled(email, &["Reason"]);
        Ok(ParsedTransaction {
            kind: TxnType::Reversal,
            paypal_txn_id,
            related_txn_id: original,
            gross_minor: gross.minor,
            currency: gross.currency,
            fee_minor: None,
            occurred_at,
            payer_name,
            payer_email: None,
            payer_note: note,
        })
    }
}
