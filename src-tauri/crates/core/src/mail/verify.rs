//! Sender verification before any parsing (SPEC §5.2, §5.6). Both checks must pass:
//!
//! 1. The domain of the actual `From` address (not the display name) is an approved PayPal
//!    domain or a subdomain of one (built-in country list + domains the owner added).
//! 2. The top-most header named exactly `Authentication-Results` — the one Gmail's
//!    `mx.google.com` adds — reports `dkim=pass` with `header.d`/`header.i` an approved PayPal
//!    domain aligned with the `From` domain (equal to it or a parent of it). Headers lower in the
//!    message, and `ARC-Authentication-Results`, could come from the sender and are ignored.
//!
//! A sender whose registrable domain is `paypal.<public suffix>` but not approved, with an
//! aligned passing DKIM signature, is reported as [`Verdict::UnknownPaypalDomain`].

use crate::paypal::domains::{is_paypal_like, is_same_or_sub, registrable, DomainSet};

pub const GOOGLE_AUTHSERV: &str = "mx.google.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    /// `From` is not a PayPal address.
    NotPaypalSender,
    /// No `Authentication-Results` header from Gmail at the top.
    NoAuthResults,
    /// Gmail did not report a passing, aligned PayPal DKIM signature.
    DkimFail,
    /// A `paypal.<suffix>` domain that is not approved yet, with valid DKIM.
    UnknownPaypalDomain,
}

impl Verdict {
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Verdict::Ok => None,
            Verdict::NotPaypalSender => Some("not_paypal_sender"),
            Verdict::NoAuthResults => Some("no_auth_results"),
            Verdict::DkimFail => Some("dkim_fail"),
            Verdict::UnknownPaypalDomain => Some("unknown_paypal_domain"),
        }
    }
}

/// Domain part of an address (`service@paypal.co.il` → `paypal.co.il`).
pub fn address_domain(addr: &str) -> Option<String> {
    let addr = addr.trim().trim_matches(|c| c == '<' || c == '>').to_ascii_lowercase();
    match addr.rsplit_once('@') {
        Some((local, domain)) if !local.is_empty() && domain.contains('.') => {
            Some(domain.trim_end_matches('.').to_string())
        }
        _ => None,
    }
}

pub fn is_paypal_address(addr: &str, domains: &DomainSet) -> bool {
    address_domain(addr).map(|d| domains.is_approved(&d)).unwrap_or(false)
}

/// Unfold a header value and drop RFC 5322 comments `( ... )`.
fn normalize(value: &str) -> String {
    let unfolded: String = value.split(['\r', '\n']).map(str::trim).collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    let mut depth = 0usize;
    for ch in unfolded.chars() {
        match ch {
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

/// Signing domains of the `dkim=pass` results in Gmail's top-most header.
/// `None` when the header is missing or not from `mx.google.com`.
pub fn dkim_pass_domains(top_most: Option<&str>) -> Option<Vec<String>> {
    let value = normalize(top_most?);
    let mut parts = value.split(';');
    let authserv = parts.next().unwrap_or("").split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    if authserv != GOOGLE_AUTHSERV {
        return None;
    }
    let mut out = vec![];
    for clause in parts {
        let tokens: Vec<&str> = clause.split_whitespace().collect();
        let Some(first) = tokens.first() else { continue };
        if !first.eq_ignore_ascii_case("dkim=pass") {
            continue;
        }
        for t in &tokens[1..] {
            let lower = t.to_ascii_lowercase();
            if let Some(v) = lower.strip_prefix("header.d=").or_else(|| lower.strip_prefix("header.i=")) {
                let d = v.trim_matches('"');
                let d = d.rsplit_once('@').map(|(_, d)| d).unwrap_or(d).trim_start_matches('@');
                if !d.is_empty() {
                    out.push(d.trim_end_matches('.').to_string());
                }
            }
        }
    }
    Some(out)
}

pub fn verify(from_addr: &str, top_auth_results: Option<&str>, domains: &DomainSet) -> Verdict {
    let Some(from_domain) = address_domain(from_addr) else { return Verdict::NotPaypalSender };
    let approved = domains.is_approved(&from_domain);
    let paypal_like = !approved && is_paypal_like(&from_domain);
    if !approved && !paypal_like {
        return Verdict::NotPaypalSender;
    }
    let Some(signers) = dkim_pass_domains(top_auth_results) else { return Verdict::NoAuthResults };
    // Alignment: the signing domain equals the From domain or is a parent of it.
    let aligned = |d: &String| is_same_or_sub(&from_domain, d);
    if approved {
        if signers.iter().any(|d| aligned(d) && domains.is_approved(d)) {
            Verdict::Ok
        } else {
            Verdict::DkimFail
        }
    } else {
        let reg = registrable(&from_domain);
        if signers.iter().any(|d| aligned(d) && registrable(d) == reg) {
            Verdict::UnknownPaypalDomain
        } else {
            Verdict::DkimFail
        }
    }
}
