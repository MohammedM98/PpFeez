//! PayPal email parsing (SPEC §5.3).
//!
//! Emails are reduced to a [`ParsedEmail`] (subject + text lines). HTML bodies are turned into
//! text with `scraper`; block elements (paragraphs, table cells, line breaks) start new lines.
//! A registry of [`parser::PaypalParser`]s then extracts the transaction.

pub mod amount;
pub mod parser;
pub mod parsers;

use crate::transactions::TxnType;
use chrono::{DateTime, Utc};
use ego_tree::NodeRef;
use parser::{lower, PaypalParser};
use scraper::{Html, Node};

#[derive(Debug, Clone)]
pub struct ParsedEmail {
    pub subject: String,
    pub from_addr: String,
    pub received_at: DateTime<Utc>,
    /// Non-empty, trimmed text lines of the body.
    pub lines: Vec<String>,
}

impl ParsedEmail {
    /// Build from stored fields; HTML is preferred over the plain-text part when present.
    pub fn new(
        subject: &str,
        from_addr: &str,
        received_at: DateTime<Utc>,
        body_html: Option<&str>,
        body_text: Option<&str>,
    ) -> Self {
        let text = match body_html.filter(|h| !h.trim().is_empty()) {
            Some(h) => html_to_text(h),
            None => body_text.unwrap_or_default().to_string(),
        };
        let mut lines: Vec<String> = text
            .lines()
            .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|l| !l.is_empty())
            .collect();
        if lines.is_empty() {
            if let Some(t) = body_text {
                lines = t.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
            }
        }
        ParsedEmail { subject: subject.trim().to_string(), from_addr: from_addr.to_string(), received_at, lines }
    }

    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTransaction {
    pub kind: TxnType,
    pub paypal_txn_id: String,
    pub related_txn_id: Option<String>,
    pub gross_minor: i64,
    pub currency: String,
    pub fee_minor: Option<i64>,
    pub occurred_at: DateTime<Utc>,
    pub payer_name: Option<String>,
    pub payer_email: Option<String>,
    pub payer_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Parsed { parser: &'static str, txn: ParsedTransaction },
    Ignored { reason: String },
    Failed { reason: String, parser: Option<&'static str> },
}

const BLOCK: [&str; 22] = [
    "p",
    "div",
    "br",
    "tr",
    "td",
    "th",
    "li",
    "ul",
    "ol",
    "table",
    "tbody",
    "thead",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "section",
    "center",
    "hr",
    "blockquote",
];
const SKIP: [&str; 5] = ["script", "style", "head", "title", "noscript"];

fn walk(node: NodeRef<'_, Node>, out: &mut String) {
    match node.value() {
        Node::Text(t) => {
            let s: &str = t;
            let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
            if !collapsed.is_empty() {
                if !out.is_empty() && !out.ends_with('\n') && !out.ends_with(' ') {
                    out.push(' ');
                }
                out.push_str(&collapsed);
            }
        }
        Node::Element(e) => {
            let name = e.name();
            if SKIP.contains(&name) {
                return;
            }
            let block = BLOCK.contains(&name);
            if block && !out.ends_with('\n') {
                out.push('\n');
            }
            for child in node.children() {
                walk(child, out);
            }
            if block && !out.ends_with('\n') {
                out.push('\n');
            }
        }
        _ => {
            for child in node.children() {
                walk(child, out);
            }
        }
    }
}

/// HTML → text with one line per block element.
pub fn html_to_text(html: &str) -> String {
    let doc = Html::parse_document(html);
    let mut out = String::new();
    walk(doc.tree.root(), &mut out);
    out
}

pub fn registry() -> Vec<Box<dyn PaypalParser>> {
    vec![
        Box::new(parsers::refund::RefundParser),
        Box::new(parsers::reversal::ReversalParser),
        Box::new(parsers::payment::PaymentReceivedParser),
    ]
}

/// PayPal emails that never carry a customer payment.
const NON_TRANSACTIONAL: [&str; 25] = [
    "you received a refund",
    "you've received a refund",
    "refund from",
    "you sent a payment",
    "you've sent a payment",
    "you sent money",
    "you paid",
    "your payment to",
    "receipt for your payment",
    "you authorized a payment",
    "log in",
    "login",
    "logged in",
    "new device",
    "password",
    "security",
    "verify",
    "confirm your",
    "statement",
    "offer",
    "update to our",
    "policy",
    "agreement",
    "your account",
    "welcome",
];

/// Words that suggest money moved; such an email that no parser understood is a failure,
/// not something to silently ignore.
const MONEY_CUES: [&str; 8] =
    ["received", "money", "payment", "refund", "reversed", "reversal", "chargeback", "sent you"];

pub fn parse_email(email: &ParsedEmail) -> Outcome {
    for p in registry() {
        if p.matches(email) {
            return match p.parse(email) {
                Ok(txn) => Outcome::Parsed { parser: p.name(), txn },
                Err(e) => Outcome::Failed { reason: format!("missing_field:{}", e.field), parser: Some(p.name()) },
            };
        }
    }
    let subject = lower(&email.subject);
    if NON_TRANSACTIONAL.iter().any(|n| subject.contains(n)) || !MONEY_CUES.iter().any(|c| subject.contains(c)) {
        Outcome::Ignored { reason: "not_transactional".into() }
    } else {
        Outcome::Failed { reason: "no_parser_matched".into(), parser: None }
    }
}

/// Arabic text for a stored `parse_reason`.
pub fn reason_ar(reason: &str) -> String {
    if let Some(field) = reason.strip_prefix("missing_field:") {
        let f = match field {
            "paypal_txn_id" => "رقم المعاملة",
            "gross" => "المبلغ والعملة",
            "related_txn_id" => "رقم المعاملة الأصلية",
            other => other,
        };
        return format!("تعذّر استخراج حقل إلزامي: {f}");
    }
    match reason {
        "not_paypal_sender" => "المرسل ليس عنوان PayPal".into(),
        "no_auth_results" => "لا توجد نتيجة تحقق من Gmail (Authentication-Results)".into(),
        "dkim_fail" => "فشل التحقق من توقيع PayPal (DKIM) — قد تكون الرسالة مزوّرة".into(),
        "not_transactional" => "رسالة PayPal غير مالية".into(),
        "no_parser_matched" => "رسالة مالية بصيغة غير معروفة".into(),
        "duplicate_txn" => "المعاملة موجودة مسبقاً".into(),
        "manual" => "عولجت يدوياً".into(),
        "invalid_message" => "رسالة غير صالحة".into(),
        other => other.to_string(),
    }
}
