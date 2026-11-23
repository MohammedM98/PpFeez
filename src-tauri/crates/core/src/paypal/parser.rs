//! Parser trait and shared extraction helpers. Adding a new email format (another language or
//! layout) means adding a parser with its own label table and a fixture `.eml` file.

use super::amount::{find_first, FoundMoney};
use super::{ParsedEmail, ParsedTransaction};
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    /// Name of the required field that could not be extracted.
    pub field: &'static str,
}

pub trait PaypalParser: Send + Sync {
    fn name(&self) -> &'static str;
    fn matches(&self, email: &ParsedEmail) -> bool;
    fn parse(&self, email: &ParsedEmail) -> Result<ParsedTransaction, ParseError>;
}

pub fn lower(s: &str) -> String {
    s.to_lowercase().replace(['’', '‘'], "'")
}

pub fn subject_has(email: &ParsedEmail, needles: &[&str]) -> bool {
    let s = lower(&email.subject);
    needles.iter().any(|n| s.contains(n))
}

/// Value of the first line that starts with one of `labels` (case-insensitive). The value is
/// the rest of the line after the label and an optional `:`; when empty, the next non-empty
/// line.
pub fn labeled(email: &ParsedEmail, labels: &[&str]) -> Option<String> {
    let lines = &email.lines;
    for label in labels {
        let label_l = lower(label);
        for (i, line) in lines.iter().enumerate() {
            let l = lower(line);
            if !l.starts_with(&label_l) {
                continue;
            }
            // Avoid "Amount received" matching label "Amount" only when the label is a word prefix.
            let rest = &line[line.char_indices().nth(label.chars().count()).map(|(b, _)| b).unwrap_or(line.len())..];
            if rest.chars().next().map(|c| c.is_alphanumeric()).unwrap_or(false) {
                continue;
            }
            let rest = rest.trim_start_matches([':', ' ', '\u{a0}', '-', '–']).trim();
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
            return lines.iter().skip(i + 1).map(|s| s.trim()).find(|s| !s.is_empty()).map(str::to_string);
        }
    }
    None
}

pub fn labeled_money(email: &ParsedEmail, labels: &[&str]) -> Option<FoundMoney> {
    labeled(email, labels).and_then(|v| find_first(&v))
}

fn txn_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b([0-9A-Z]{12,20})\b").unwrap())
}

/// A PayPal transaction id (12–20 upper-case letters/digits, at least one digit).
pub fn txn_id_in(value: &str) -> Option<String> {
    txn_id_re().captures_iter(value).map(|c| c[1].to_string()).find(|id| id.chars().any(|c| c.is_ascii_digit()))
}

pub fn labeled_txn_id(email: &ParsedEmail, labels: &[&str]) -> Option<String> {
    labeled(email, labels).and_then(|v| txn_id_in(&v))
}

fn email_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").unwrap())
}

pub fn email_in(value: &str) -> Option<String> {
    email_re()
        .find_iter(value)
        .map(|m| m.as_str().to_string())
        .find(|e| !e.to_ascii_lowercase().ends_with("paypal.com"))
}

/// Parse dates as PayPal writes them: `Nov 20, 2026`, `November 20, 2026 10:15:30 PST`,
/// `20 Nov 2026`, `2026-11-20`. Time zones other than UTC offsets are approximated by the
/// usual US PayPal zones.
pub fn parse_paypal_date(value: &str, received_at: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let v = value.trim().replace(',', "").replace("  ", " ");
    let mut parts: Vec<&str> = v.split_whitespace().collect();
    // Trailing zone abbreviation.
    let mut offset_h: i64 = 0;
    if let Some(last) = parts.last() {
        let tz = match last.to_ascii_uppercase().as_str() {
            "PST" => Some(-8),
            "PDT" => Some(-7),
            "MST" => Some(-7),
            "MDT" => Some(-6),
            "CST" => Some(-6),
            "CDT" => Some(-5),
            "EST" => Some(-5),
            "EDT" => Some(-4),
            "GMT" | "UTC" => Some(0),
            "CET" => Some(1),
            "CEST" => Some(2),
            _ => None,
        };
        if let Some(h) = tz {
            offset_h = h;
            parts.pop();
        }
    }
    let time = parts
        .last()
        .filter(|p| p.contains(':'))
        .and_then(|p| NaiveTime::parse_from_str(p, "%H:%M:%S").or_else(|_| NaiveTime::parse_from_str(p, "%H:%M")).ok());
    if time.is_some() {
        parts.pop();
    }
    let date_s = parts.join(" ");
    let date = ["%b %d %Y", "%B %d %Y", "%d %b %Y", "%d %B %Y", "%Y-%m-%d", "%m/%d/%Y"]
        .iter()
        .find_map(|f| NaiveDate::parse_from_str(&date_s, f).ok())?;
    match time {
        Some(t) => {
            let local = NaiveDateTime::new(date, t);
            Some(DateTime::<Utc>::from_naive_utc_and_offset(local - chrono::Duration::hours(offset_h), Utc))
        }
        None => {
            // Date only: keep the reception time when it is the same calendar day.
            if received_at.date_naive() == date {
                Some(received_at)
            } else {
                Some(DateTime::<Utc>::from_naive_utc_and_offset(date.and_hms_opt(12, 0, 0)?, Utc))
            }
        }
    }
}
