//! PayPal email parsing (SPEC §5.3): classify the email by type × language from its subject,
//! extract the fields with that language's labels (English labels as a fallback), and fall back
//! to a generic parser that needs the owner's review.

use super::amount::{find_all, find_first, FoundMoney};
use super::lang::{en::EN, Lang, ALL};
use super::parser::{email_in, labeled, labeled_money, lower, parse_paypal_date_with, txn_id_in, ParseError};
use super::{Event, Outcome, ParsedEmail, ParsedTransaction};
use crate::transactions::TxnType;
use regex::Regex;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Payment,
    EcheckPending,
    EcheckCleared,
    OnHold,
    Refund,
    Reversal,
}

impl Kind {
    fn slug(self) -> &'static str {
        match self {
            Kind::Payment => "payment",
            Kind::EcheckPending => "echeck_pending",
            Kind::EcheckCleared => "echeck_cleared",
            Kind::OnHold => "on_hold",
            Kind::Refund => "refund",
            Kind::Reversal => "reversal",
        }
    }
}

fn has(text_lower: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|p| text_lower.contains(&lower(p)))
}

/// Compiled regexes are cached by pattern.
fn re(pattern: &str) -> Regex {
    static CACHE: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache.lock().unwrap();
    map.entry(pattern.to_string()).or_insert_with(|| Regex::new(pattern).expect("valid pattern")).clone()
}

/// Type and language of a financial PayPal email, from its subject.
pub fn classify(email: &ParsedEmail) -> Option<(Kind, &'static Lang)> {
    let s = lower(&email.subject);
    for lang in ALL {
        if has(&s, lang.refund_subjects) {
            return Some((Kind::Refund, lang));
        }
        if has(&s, lang.reversal_subjects) {
            return Some((Kind::Reversal, lang));
        }
        if has(&s, lang.echeck_words) {
            if has(&s, lang.cleared_words) {
                return Some((Kind::EcheckCleared, lang));
            }
            if has(&s, lang.pending_words) {
                return Some((Kind::EcheckPending, lang));
            }
        }
        if has(&s, lang.on_hold_subjects) {
            return Some((Kind::OnHold, lang));
        }
        if has(&s, lang.payment_subjects) {
            return Some((Kind::Payment, lang));
        }
    }
    None
}

/// Labels of `lang` followed by the English ones.
fn labels<'a>(lang: &'a Lang, pick: fn(&'a Lang) -> &'a [&'a str]) -> Vec<&'a str> {
    let mut v: Vec<&str> = pick(lang).to_vec();
    if lang.code != EN.code {
        v.extend_from_slice(pick(&EN));
    }
    v
}

fn id17_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b([0-9A-Z]{17})\b").unwrap())
}

/// PayPal transaction ids: 17 upper-case letters/digits with at least one digit and one letter.
fn ids17(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for c in id17_re().captures_iter(text) {
        let id = c[1].to_string();
        if id.chars().any(|c| c.is_ascii_digit()) && id.chars().any(|c| c.is_ascii_alphabetic()) && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

fn labeled_id(email: &ParsedEmail, labels: &[&str]) -> Option<String> {
    labeled(email, labels).and_then(|v| txn_id_in(&v))
}

/// "{name} sent you {amount}" (and the other languages' forms) → (name, amount text).
fn sent_you(email: &ParsedEmail, lang: &Lang) -> Option<(String, Option<String>)> {
    let patterns: Vec<&str> = labels(lang, |l| l.sent_you);
    for line in email.lines.iter().chain(std::iter::once(&email.subject)) {
        for p in &patterns {
            if let Some(c) = re(p).captures(line) {
                let name = c.name("name").map(|m| m.as_str().to_string()).unwrap_or_default();
                return Some((name, c.name("amount").map(|m| m.as_str().to_string())));
            }
        }
    }
    None
}

/// Strip an email address in parentheses or angle brackets from a name.
fn clean_name(s: &str) -> Option<String> {
    let mut n = s.to_string();
    for (open, close) in [('(', ')'), ('<', '>')] {
        if let (Some(a), Some(b)) = (n.find(open), n.rfind(close)) {
            if a < b && n[a..b].contains('@') {
                n = format!("{}{}", &n[..a], &n[b + close.len_utf8()..]);
            }
        }
    }
    let n = n.trim().trim_end_matches(['.', ',', ':', '!', '،']).trim().to_string();
    if n.is_empty() || n.contains('@') || n.chars().count() > 120 {
        None
    } else {
        Some(n)
    }
}

/// "Note from John Doe: text", "Note from John Doe:" + next line, or "Message: text".
fn note(email: &ParsedEmail, lang: &Lang) -> Option<String> {
    let clean = |s: &str| s.trim().trim_matches(['"', '“', '”', '„', '«', '»']).trim().to_string();
    let note_labels = labels(lang, |l| l.note);
    for (i, line) in email.lines.iter().enumerate() {
        let l = lower(line);
        let Some(label) = note_labels.iter().find(|n| l.starts_with(&lower(n))) else { continue };
        let rest: String = line.chars().skip(label.chars().count()).collect();
        if rest.chars().next().map(|c| c.is_alphanumeric()).unwrap_or(false) && !label.ends_with(' ') {
            // "Messages" for label "Message"; but Hebrew "הודעה מ" + name is fine (label ends with a word).
            let ends_with_from = ["from", "מ", "من"].iter().any(|f| label.to_lowercase().ends_with(f));
            if !ends_with_from {
                continue;
            }
        }
        let value = match rest.find(':') {
            Some(p) => clean(&rest[p + 1..]),
            None if ["from", " מ", "من"].iter().any(|f| label.to_lowercase().ends_with(f)) => String::new(),
            None => clean(&rest),
        };
        let value = if value.is_empty() { email.lines.get(i + 1).map(|n| clean(n)).unwrap_or_default() } else { value };
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn occurred_at(email: &ParsedEmail, lang: &Lang) -> chrono::DateTime<chrono::Utc> {
    labeled(email, &labels(lang, |l| l.date))
        .and_then(|d| parse_paypal_date_with(&d, email.received_at, lang.code != "en"))
        .unwrap_or(email.received_at)
}

fn first_money(email: &ParsedEmail) -> Option<FoundMoney> {
    find_first(&email.subject).or_else(|| email.lines.iter().find_map(|l| find_first(l)))
}

/// Payments, eCheck pending/cleared and on-hold notices share the same fields.
fn parse_payment(email: &ParsedEmail, lang: &Lang, event: Event) -> Result<ParsedTransaction, ParseError> {
    let txn_labels = labels(lang, |l| l.txn_id);
    let paypal_txn_id = labeled_id(email, &txn_labels)
        .or_else(|| {
            email
                .lines
                .iter()
                .find(|l| txn_labels.iter().any(|t| lower(l).contains(&lower(t))))
                .and_then(|l| txn_id_in(l))
        })
        .or_else(|| ids17(&email.text()).into_iter().next())
        .ok_or(ParseError { field: "paypal_txn_id" })?;
    let sent = sent_you(email, lang);
    let gross = labeled_money(email, &labels(lang, |l| l.gross))
        .or_else(|| sent.as_ref().and_then(|(_, a)| a.as_deref().and_then(find_first)))
        .or_else(|| first_money(email))
        .ok_or(ParseError { field: "gross" })?;
    let fee = labeled_money(email, &labels(lang, |l| l.fee))
        .filter(|f| f.currency == gross.currency && f.minor <= gross.minor)
        .map(|f| f.minor)
        .or_else(|| {
            labeled_money(email, &labels(lang, |l| l.net))
                .filter(|n| n.currency == gross.currency && n.minor <= gross.minor)
                .map(|n| gross.minor - n.minor)
        });
    let payer_name = sent
        .as_ref()
        .and_then(|(n, _)| clean_name(n))
        .or_else(|| labeled(email, &labels(lang, |l| l.payer_name)).and_then(|v| clean_name(&v)))
        .or_else(|| {
            labels(lang, |l| l.subject_from)
                .iter()
                .find_map(|p| re(p).captures(&email.subject).and_then(|c| clean_name(&c["name"])))
        });
    let payer_email = labeled(email, &labels(lang, |l| l.payer_email)).and_then(|v| email_in(&v)).or_else(|| {
        let name = payer_name.as_deref()?;
        email.lines.iter().filter(|l| l.contains(name)).find_map(|l| email_in(l))
    });
    Ok(ParsedTransaction {
        kind: TxnType::Payment,
        paypal_txn_id,
        related_txn_id: None,
        gross_minor: gross.minor,
        currency: gross.currency,
        fee_minor: fee,
        occurred_at: occurred_at(email, lang),
        payer_name,
        payer_email,
        payer_note: note(email, lang),
        event,
        needs_review: false,
    })
}

fn parse_refund(email: &ParsedEmail, lang: &Lang) -> Result<ParsedTransaction, ParseError> {
    let related = labeled_id(email, &labels(lang, |l| l.original_id));
    let mut own = labeled_id(email, &labels(lang, |l| l.refund_id));
    if own.is_some() && own == related {
        own = None;
    }
    let own = own.or_else(|| ids17(&email.text()).into_iter().find(|id| Some(id) != related.as_ref()));
    let paypal_txn_id = match (own, &related) {
        (Some(id), _) => id,
        (None, Some(orig)) => format!("REFUND-{orig}"),
        (None, None) => return Err(ParseError { field: "paypal_txn_id" }),
    };
    let gross = labeled_money(email, &labels(lang, |l| l.refund_amount))
        .or_else(|| first_money(email))
        .ok_or(ParseError { field: "gross" })?;
    let payer_name = labeled(email, &labels(lang, |l| l.refund_to)).and_then(|n| clean_name(&n));
    let payer_email = labeled(email, &labels(lang, |l| l.payer_email)).and_then(|v| email_in(&v));
    Ok(ParsedTransaction {
        kind: TxnType::Refund,
        paypal_txn_id,
        related_txn_id: related,
        gross_minor: gross.minor,
        currency: gross.currency,
        fee_minor: None,
        occurred_at: occurred_at(email, lang),
        payer_name: payer_name.or_else(|| refund_to_from_subject(email)),
        payer_email,
        payer_note: None,
        event: Event::Normal,
        needs_review: false,
    })
}

fn refund_to_from_subject(email: &ParsedEmail) -> Option<String> {
    re(r"(?i)refund(?:\s+of\s+.+?)?\s+to\s+(?P<name>[^\d$€£¥₺₪].*?)\s*$")
        .captures(&email.subject)
        .and_then(|c| clean_name(&c["name"]))
}

fn parse_reversal(email: &ParsedEmail, lang: &Lang) -> Result<ParsedTransaction, ParseError> {
    let original =
        labeled_id(email, &labels(lang, |l| l.original_id)).or_else(|| labeled_id(email, &labels(lang, |l| l.txn_id)));
    let reversal_id = labeled_id(email, &labels(lang, |l| l.reversal_id)).filter(|id| Some(id) != original.as_ref());
    let case_id = labeled(email, &labels(lang, |l| l.case_id))
        .and_then(|v| v.split_whitespace().next().map(str::to_string))
        .filter(|v| v.chars().any(|c| c.is_ascii_digit()));
    let original = original.or_else(|| ids17(&email.text()).into_iter().next());
    let paypal_txn_id = match (reversal_id, &case_id, &original) {
        (Some(id), _, _) => id,
        (None, Some(case), _) => format!("REV-{case}"),
        (None, None, Some(orig)) => format!("REV-{orig}"),
        (None, None, None) => return Err(ParseError { field: "paypal_txn_id" }),
    };
    let gross = labeled_money(email, &labels(lang, |l| l.reversal_amount))
        .or_else(|| first_money(email))
        .ok_or(ParseError { field: "gross" })?;
    Ok(ParsedTransaction {
        kind: TxnType::Reversal,
        paypal_txn_id,
        related_txn_id: original,
        gross_minor: gross.minor,
        currency: gross.currency,
        fee_minor: None,
        occurred_at: occurred_at(email, lang),
        payer_name: labeled(email, &labels(lang, |l| l.buyer)).filter(|n| !n.contains('@')),
        payer_email: None,
        payer_note: labeled(email, &labels(lang, |l| l.reason)),
        event: Event::Normal,
        needs_review: false,
    })
}

/// Last resort for a verified PayPal email no specialised parser understood: a 17-character
/// PayPal transaction id and an amount with a currency make a transaction that needs review.
fn parse_generic(email: &ParsedEmail) -> Result<ParsedTransaction, ParseError> {
    let text = email.text();
    let ids = ids17(&format!("{}\n{}", email.subject, text));
    let paypal_txn_id = ids.first().cloned().ok_or(ParseError { field: "paypal_txn_id" })?;
    let money =
        find_all(&email.subject).into_iter().chain(find_all(&text)).next().ok_or(ParseError { field: "gross" })?;
    let s = lower(&format!("{}\n{}", email.subject, text));
    let kind = if ALL.iter().any(|l| has(&s, l.refund_subjects)) {
        TxnType::Refund
    } else if ALL.iter().any(|l| has(&s, l.reversal_subjects)) {
        TxnType::Reversal
    } else {
        TxnType::Payment
    };
    let payer = ALL.iter().find_map(|l| sent_you(email, l)).and_then(|(n, _)| clean_name(&n));
    Ok(ParsedTransaction {
        kind,
        related_txn_id: if kind == TxnType::Payment { None } else { ids.get(1).cloned() },
        paypal_txn_id,
        gross_minor: money.minor,
        currency: money.currency,
        fee_minor: None,
        occurred_at: email.received_at,
        payer_email: payer
            .as_deref()
            .and_then(|n| email.lines.iter().filter(|l| l.contains(n)).find_map(|l| email_in(l))),
        payer_name: payer,
        payer_note: None,
        event: Event::Normal,
        needs_review: true,
    })
}

pub fn parse_email(email: &ParsedEmail) -> Outcome {
    let subject = lower(&email.subject);
    let classified = classify(email);
    // Money the owner sent, or a refund the owner received: never customer money. Refunds and
    // reversals are decided first ("geri ödeme gönderdiniz" contains "ödeme gönderdiniz").
    let refund_or_reversal = matches!(classified, Some((Kind::Refund | Kind::Reversal, _)));
    if !refund_or_reversal
        && ALL.iter().any(|l| has(&subject, l.not_income_subjects) || has(&subject, l.refund_received_subjects))
    {
        return Outcome::Ignored { reason: "not_transactional".into() };
    }
    if let Some((kind, lang)) = classified {
        let parser = format!("paypal_{}_{}", kind.slug(), lang.code);
        let result = match kind {
            Kind::Payment => parse_payment(email, lang, Event::Normal),
            Kind::EcheckPending => parse_payment(email, lang, Event::EcheckPending),
            Kind::EcheckCleared => parse_payment(email, lang, Event::EcheckCleared),
            Kind::OnHold => parse_payment(email, lang, Event::OnHold),
            Kind::Refund => parse_refund(email, lang),
            Kind::Reversal => parse_reversal(email, lang),
        };
        return match result {
            Ok(txn) => Outcome::Parsed { parser, txn },
            Err(e) => Outcome::Failed { reason: format!("missing_field:{}", e.field), parser: Some(parser) },
        };
    }
    if ALL.iter().any(|l| has(&subject, l.non_transactional)) {
        return Outcome::Ignored { reason: "not_transactional".into() };
    }
    match parse_generic(email) {
        Ok(txn) => Outcome::Parsed { parser: "paypal_generic".into(), txn },
        Err(e) => {
            if ALL.iter().any(|l| has(&subject, l.money_cues)) {
                Outcome::Failed { reason: format!("missing_field:{}", e.field), parser: None }
            } else {
                Outcome::Ignored { reason: "not_transactional".into() }
            }
        }
    }
}
