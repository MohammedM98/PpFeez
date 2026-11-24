//! PayPal sender domains (SPEC §5.6).
//!
//! Three layers:
//! 1. [`BUILTIN`]: PayPal's official country domains (and their subdomains).
//! 2. Domains the owner adds in settings (`extraPaypalDomains`).
//! 3. Any other `paypal.<public suffix>` registrable domain is an *unknown PayPal domain*: its
//!    mail is kept as `ignored: unknown_paypal_domain` until the owner trusts the domain.

use crate::error::{AppError, AppResult};

/// Official PayPal sender domains confirmed from PayPal's own pages (the per-country
/// "How do I confirm my email address" help article, help138, names the sender address):
/// - `paypal.com`   — https://www.paypal.com/us/cshelp/article/how-do-i-confirm-my-email-address-help138
///   (`service@paypal.com`) and PayPal's "Common email scams" page.
/// - `paypal.co.il` — https://www.paypal.com/il/cshelp/article/how-do-i-confirm-my-email-address-help138
///   (`service@paypal.co.il`).
/// - `paypal.co.uk` — https://www.paypal.com/uk/cshelp/article/how-do-i-confirm-my-email-address-help138
///   (`service@paypal.co.uk`).
///
/// Other country domains listed in SPEC §5.6 (paypal.de, paypal.fr, paypal.com.au, paypal.com.tr, …)
/// could not be confirmed from an official PayPal source, so they are left out on purpose: their mail
/// still arrives as "unknown PayPal domain" (with valid DKIM) and the owner can trust it in one step.
pub const BUILTIN: &[&str] = &["paypal.com", "paypal.co.il", "paypal.co.uk"];

/// The set of approved PayPal domains (layers 1 + 2).
#[derive(Debug, Clone, Default)]
pub struct DomainSet {
    domains: Vec<String>,
}

impl DomainSet {
    pub fn new(extra: &[String]) -> Self {
        let mut domains: Vec<String> = BUILTIN.iter().map(|d| d.to_string()).collect();
        for d in extra {
            let d = d.trim().to_ascii_lowercase();
            if !d.is_empty() && !domains.contains(&d) {
                domains.push(d);
            }
        }
        DomainSet { domains }
    }

    /// Only the built-in list (tests and defaults).
    pub fn builtin() -> Self {
        Self::new(&[])
    }

    /// The approved domain that `domain` equals or is a subdomain of.
    pub fn approved_root(&self, domain: &str) -> Option<&str> {
        let domain = domain.trim_end_matches('.').to_ascii_lowercase();
        self.domains.iter().map(String::as_str).find(|d| is_same_or_sub(&domain, d))
    }

    pub fn is_approved(&self, domain: &str) -> bool {
        self.approved_root(domain).is_some()
    }
}

/// `domain == parent` or `domain` ends with `.parent`.
pub fn is_same_or_sub(domain: &str, parent: &str) -> bool {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    let parent = parent.trim_end_matches('.').to_ascii_lowercase();
    domain == parent || domain.ends_with(&format!(".{parent}"))
}

/// Registrable domain (eTLD+1) from the Public Suffix List: `mail.paypal.co.il` → `paypal.co.il`.
pub fn registrable(domain: &str) -> Option<String> {
    let d = domain.trim_end_matches('.').to_ascii_lowercase();
    psl::domain_str(&d).map(str::to_string)
}

/// True when the registrable domain is exactly `paypal.<ICANN public suffix>`.
pub fn is_paypal_like(domain: &str) -> bool {
    let d = domain.trim_end_matches('.').to_ascii_lowercase();
    let Some(reg) = psl::domain(d.as_bytes()) else { return false };
    let suffix = reg.suffix();
    if suffix.typ() != Some(psl::Type::Icann) {
        return false;
    }
    let mut expected = b"paypal.".to_vec();
    expected.extend_from_slice(suffix.as_bytes());
    reg.as_bytes() == expected.as_slice()
}

/// Validate an owner-entered domain: lowercase ASCII hostname with at least one dot.
pub fn validate_domain(input: &str) -> AppResult<String> {
    let d = input.trim().trim_start_matches('@').trim_end_matches('.').to_ascii_lowercase();
    let label_ok = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    if d.len() > 253 || !d.contains('.') || !d.split('.').all(label_ok) {
        return Err(AppError::validation("extraPaypalDomains", format!("نطاق غير صالح: {}", input.trim())));
    }
    Ok(d)
}

/// The IMAP search key for PayPal candidates: `FROM "paypal"` (all countries and subdomains),
/// OR-ed with any extra domain that does not contain "paypal". Acceptance happens in
/// verification; the search only collects candidates.
pub fn paypal_from_query(extra: &[String]) -> String {
    let mut q = "FROM \"paypal\"".to_string();
    for d in extra {
        let d = d.trim().to_ascii_lowercase();
        if d.is_empty() || d.contains("paypal") || d.contains('"') || d.contains('\\') {
            continue;
        }
        q = format!("OR {q} FROM \"{d}\"");
    }
    q
}
