//! PayPal email parsing (SPEC §5.3).
//!
//! Emails are reduced to a [`ParsedEmail`] (subject + text lines). HTML bodies are turned into
//! text with `scraper`; block elements (paragraphs, table cells, line breaks) start new lines.
//! [`parsers::parse_email`] classifies the email (type × language, `lang/*.rs`) and extracts the
//! transaction; a generic fallback catches unknown layouts for review.

pub mod amount;
pub mod domains;
pub mod lang;
pub mod parser;
pub mod parsers;

use crate::transactions::TxnType;
use chrono::{DateTime, Utc};
use ego_tree::NodeRef;
use scraper::{Html, Node};

/// Bidi control characters PayPal puts around numbers in RTL emails (LRM, RLM, ALM, embeddings,
/// overrides and isolates). They are removed before any parsing.
pub fn strip_bidi(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'))
        .collect()
}

#[derive(Debug, Clone)]
pub struct ParsedEmail {
    pub subject: String,
    pub from_addr: String,
    pub received_at: DateTime<Utc>,
    /// Non-empty, trimmed text lines of the body (bidi marks removed, spaces collapsed).
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
        let clean = |t: &str| -> Vec<String> {
            strip_bidi(t)
                .lines()
                .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|l| !l.is_empty())
                .collect()
        };
        let mut lines = clean(&text);
        if lines.is_empty() {
            if let Some(t) = body_text {
                lines = clean(t);
            }
        }
        let subject = strip_bidi(subject).split_whitespace().collect::<Vec<_>>().join(" ");
        ParsedEmail { subject, from_addr: from_addr.to_string(), received_at, lines }
    }

    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

/// What a PayPal email says happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Normal,
    /// eCheck payment not cleared yet: the transaction cannot be approved until it clears.
    EcheckPending,
    /// eCheck cleared: updates the transaction with the same id.
    EcheckCleared,
    /// Funds on hold: a note on the existing transaction, never a new one.
    OnHold,
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
    pub event: Event,
    /// Set by the generic fallback parser: the owner confirms the data before approval.
    pub needs_review: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Parsed { parser: String, txn: ParsedTransaction },
    Ignored { reason: String },
    Failed { reason: String, parser: Option<String> },
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

pub use parsers::parse_email;

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
        "unknown_paypal_domain" => "نطاق PayPal غير معروف — يمكنك الوثوق به من هنا".into(),
        "hold_notice" => "إشعار حجز مبلغ لمعاملة غير موجودة بعد".into(),
        "echeck_cleared" => "اكتمال شيك إلكتروني (حُدّثت المعاملة)".into(),
        "hold_applied" => "إشعار حجز (عُلّمت المعاملة «محجوزة»)".into(),
        other => other.to_string(),
    }
}
