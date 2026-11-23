//! Sender verification before any parsing (SPEC §5.2). Both checks must pass:
//!
//! 1. The actual `From` address (not the display name) is `@paypal.com` or an approved
//!    PayPal subdomain.
//! 2. The top-most `Authentication-Results` header — the one Gmail's `mx.google.com` adds —
//!    reports `dkim=pass` with `header.i`/`header.d` ending in `paypal.com`. Headers lower in
//!    the message could have been planted by the sender and are ignored.

pub const APPROVED_DOMAINS: [&str; 4] = ["paypal.com", "intl.paypal.com", "mail.paypal.com", "e.paypal.com"];
pub const GOOGLE_AUTHSERV: &str = "mx.google.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    /// `From` is not a PayPal address.
    NotPaypalSender,
    /// No `Authentication-Results` header from Gmail at the top.
    NoAuthResults,
    /// Gmail did not report a passing PayPal DKIM signature.
    DkimFail,
}

impl Verdict {
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Verdict::Ok => None,
            Verdict::NotPaypalSender => Some("not_paypal_sender"),
            Verdict::NoAuthResults => Some("no_auth_results"),
            Verdict::DkimFail => Some("dkim_fail"),
        }
    }
}

pub fn is_paypal_address(addr: &str) -> bool {
    let addr = addr.trim().trim_matches(|c| c == '<' || c == '>').to_ascii_lowercase();
    match addr.rsplit_once('@') {
        Some((local, domain)) if !local.is_empty() => APPROVED_DOMAINS.contains(&domain),
        _ => false,
    }
}

fn domain_is_paypal(d: &str) -> bool {
    let d = d.trim().trim_start_matches('@').trim_end_matches('.').to_ascii_lowercase();
    let d = d.rsplit_once('@').map(|(_, dom)| dom.to_string()).unwrap_or(d);
    d == "paypal.com" || d.ends_with(".paypal.com")
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

/// Check the top-most Authentication-Results value.
pub fn check_auth_results(top_most: Option<&str>) -> Verdict {
    let Some(raw) = top_most else {
        return Verdict::NoAuthResults;
    };
    let value = normalize(raw);
    let mut parts = value.split(';');
    let authserv = parts.next().unwrap_or("").split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    if authserv != GOOGLE_AUTHSERV {
        return Verdict::NoAuthResults;
    }
    for clause in parts {
        let tokens: Vec<&str> = clause.split_whitespace().collect();
        let Some(first) = tokens.first() else { continue };
        if !first.eq_ignore_ascii_case("dkim=pass") {
            continue;
        }
        let signed_by_paypal = tokens.iter().skip(1).any(|t| {
            let lower = t.to_ascii_lowercase();
            lower
                .strip_prefix("header.i=")
                .or_else(|| lower.strip_prefix("header.d="))
                .map(domain_is_paypal)
                .unwrap_or(false)
        });
        if signed_by_paypal {
            return Verdict::Ok;
        }
    }
    Verdict::DkimFail
}

pub fn verify(from_addr: &str, top_auth_results: Option<&str>) -> Verdict {
    if !is_paypal_address(from_addr) {
        return Verdict::NotPaypalSender;
    }
    check_auth_results(top_auth_results)
}
