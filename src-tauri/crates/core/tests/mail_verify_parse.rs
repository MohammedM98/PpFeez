mod common;

use chrono::{TimeZone, Utc};
use common::fixture;
use ppfeez_core::mail::ingest::{evaluate, extract};
use ppfeez_core::mail::verify::{check_auth_results, is_paypal_address, verify, Verdict};
use ppfeez_core::paypal::{html_to_text, parse_email, Outcome, ParsedEmail};
use ppfeez_core::transactions::TxnType;

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 28, 0, 0, 0).unwrap()
}

fn load(name: &str) -> ppfeez_core::mail::ingest::StoredEmail {
    extract(&fixture(name), "fallback", now()).expect("parsable message")
}

#[test]
fn accepts_paypal_with_dkim_pass() {
    let e = load("payment_received_basic.eml");
    assert_eq!(e.from_addr, "service@paypal.com");
    assert!(e.auth_results.as_deref().unwrap().starts_with("mx.google.com;"));
    assert_eq!(verify(&e.from_addr, e.auth_results.as_deref()), Verdict::Ok);
    assert!(is_paypal_address("service@intl.paypal.com"));
    assert!(is_paypal_address("<member@mail.paypal.com>"));
    assert!(!is_paypal_address("service@paypal.com.evil.example"));
    assert!(!is_paypal_address("service@notpaypal.com"));
    assert!(!is_paypal_address("service@x.paypal.com"), "only approved subdomains");
}

#[test]
fn rejects_spoofed_display_name() {
    let e = load("spoofed_display_name.eml");
    assert_eq!(e.from_addr, "attacker@evil.example");
    assert_eq!(verify(&e.from_addr, e.auth_results.as_deref()), Verdict::NotPaypalSender);
    let (status, reason, _, txn) = evaluate(&e);
    assert_eq!((status, reason.as_deref(), txn.is_none()), ("ignored", Some("not_paypal_sender"), true));
}

#[test]
fn rejects_dkim_fail() {
    let e = load("dkim_fail.eml");
    assert_eq!(verify(&e.from_addr, e.auth_results.as_deref()), Verdict::DkimFail);
    assert_eq!(evaluate(&e).1.as_deref(), Some("dkim_fail"));
}

#[test]
fn ignores_planted_lower_authentication_results() {
    let e = load("planted_auth_header.eml");
    // Only the top-most (Gmail's) header is considered; it has no PayPal DKIM pass.
    assert!(e.auth_results.as_deref().unwrap().contains("evil.example"));
    assert_eq!(verify(&e.from_addr, e.auth_results.as_deref()), Verdict::DkimFail);
}

#[test]
fn auth_results_edge_cases() {
    assert_eq!(check_auth_results(None), Verdict::NoAuthResults);
    assert_eq!(check_auth_results(Some("evil.example; dkim=pass header.i=@paypal.com")), Verdict::NoAuthResults);
    assert_eq!(check_auth_results(Some("mx.google.com; dkim=pass header.d=paypal.com")), Verdict::Ok);
    assert_eq!(
        check_auth_results(Some("mx.google.com;\r\n dkim=pass (2048-bit key) header.i=@e.paypal.com")),
        Verdict::Ok
    );
    assert_eq!(
        check_auth_results(Some("mx.google.com; dkim=pass header.i=@paypal.com.evil.example")),
        Verdict::DkimFail
    );
    assert_eq!(
        check_auth_results(Some("mx.google.com; dkim=neutral (body hash did not verify) header.i=@paypal.com")),
        Verdict::DkimFail
    );
    assert_eq!(
        check_auth_results(Some("mx.google.com; spf=pass (comment dkim=pass header.i=@paypal.com) smtp.mailfrom=x")),
        Verdict::DkimFail,
        "text inside comments does not count"
    );
}

fn parsed(name: &str) -> ppfeez_core::paypal::ParsedTransaction {
    match evaluate(&load(name)) {
        ("parsed", _, Some(_), Some(t)) => t,
        other => panic!("{name}: {other:?}"),
    }
}

#[test]
fn payment_basic_html() {
    let t = parsed("payment_received_basic.eml");
    assert_eq!(t.kind, TxnType::Payment);
    assert_eq!(t.paypal_txn_id, "9AB12345CD6789012");
    assert_eq!((t.gross_minor, t.currency.as_str(), t.fee_minor), (10000, "USD", None));
    assert_eq!(t.payer_name.as_deref(), Some("John Doe"));
    assert_eq!(t.payer_email.as_deref(), Some("john.doe@example.com"));
    assert_eq!(t.payer_note.as_deref(), Some("For Ahmed – order #12"));
    // Date-only "Nov 20, 2026" on the reception day keeps the reception time.
    assert_eq!(t.occurred_at, Utc.with_ymd_and_hms(2026, 11, 20, 22, 22, 1).unwrap());
}

#[test]
fn payment_with_fee_text_eur() {
    let t = parsed("payment_received_with_fee.eml");
    assert_eq!(t.paypal_txn_id, "3KL45678MN9012345");
    assert_eq!((t.gross_minor, t.currency.as_str(), t.fee_minor), (5000, "EUR", Some(205)));
    assert_eq!(t.payer_name.as_deref(), Some("Maria Rossi"));
    assert_eq!(t.payer_email.as_deref(), Some("maria.rossi@example.org"));
    assert_eq!(t.payer_note.as_deref(), Some("Rent share November"));
    assert_eq!(t.occurred_at, Utc.with_ymd_and_hms(2026, 11, 21, 8, 5, 12).unwrap());
}

#[test]
fn payment_jpy() {
    let t = parsed("payment_received_jpy.eml");
    assert_eq!((t.gross_minor, t.currency.as_str()), (5000, "JPY"));
    assert_eq!(t.payer_name.as_deref(), Some("Taro Yamada"));
    assert_eq!(t.paypal_txn_id, "5JP00000AB1234567");
}

#[test]
fn payment_fee_from_net_with_dot_thousands() {
    let t = parsed("payment_received_eur_net.eml");
    assert_eq!((t.gross_minor, t.currency.as_str()), (123456, "EUR"));
    assert_eq!(t.fee_minor, Some(123456 - 118023));
    assert_eq!(t.payer_name.as_deref(), Some("Hans Muller"));
    assert_eq!(t.payer_email.as_deref(), Some("hans.muller@example.net"));
}

#[test]
fn refund_partial() {
    let t = parsed("refund_sent_partial.eml");
    assert_eq!(t.kind, TxnType::Refund);
    assert_eq!(t.paypal_txn_id, "7RF98765QP4321098");
    assert_eq!(t.related_txn_id.as_deref(), Some("9AB12345CD6789012"));
    assert_eq!((t.gross_minor, t.currency.as_str()), (4000, "USD"));
    assert_eq!(t.payer_name.as_deref(), Some("John Doe"));
}

#[test]
fn reversal_chargeback() {
    let t = parsed("reversal_chargeback.eml");
    assert_eq!(t.kind, TxnType::Reversal);
    assert_eq!(t.paypal_txn_id, "REV-PP-D-123456");
    assert_eq!(t.related_txn_id.as_deref(), Some("9AB12345CD6789012"));
    assert_eq!(t.gross_minor, 10000);
    assert_eq!(t.payer_note.as_deref(), Some("Unauthorized transaction"));
}

#[test]
fn non_financial_and_own_payments_are_ignored() {
    for f in ["non_financial_login.eml", "payment_sent_ignored.eml"] {
        let (status, reason, _, _) = evaluate(&load(f));
        assert_eq!((status, reason.as_deref()), ("ignored", Some("not_transactional")), "{f}");
    }
}

#[test]
fn missing_required_field_fails_with_field_name() {
    let (status, reason, parser, _) = evaluate(&load("payment_missing_txn_id.eml"));
    assert_eq!(status, "failed");
    assert_eq!(reason.as_deref(), Some("missing_field:paypal_txn_id"));
    assert_eq!(parser, Some("paypal_payment_received_en"));
}

#[test]
fn unknown_financial_email_fails() {
    let e = ParsedEmail::new("Money is on hold: payment received", "service@paypal.com", now(), None, Some("x"));
    // Matches the payment parser but has no data.
    assert!(matches!(parse_email(&e), Outcome::Failed { .. }));
    let e = ParsedEmail::new(
        "Your refund request was reversed by money order",
        "service@paypal.com",
        now(),
        None,
        Some("x"),
    );
    assert!(matches!(parse_email(&e), Outcome::Failed { .. }));
}

#[test]
fn html_to_text_drops_scripts_and_breaks_blocks() {
    let t = html_to_text("<html><head><title>T</title></head><body><p>A <b>bold</b></p><script>x()</script><table><tr><td>K</td><td>V</td></tr></table></body></html>");
    let lines: Vec<&str> = t.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    assert_eq!(lines, vec!["A bold", "K", "V"]);
}

#[test]
fn every_fixture_has_an_expected_outcome() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/emails");
    let mut n = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        if !name.ends_with(".eml") {
            continue;
        }
        n += 1;
        let (status, ..) = evaluate(&load(&name));
        let expected =
            if name.starts_with("payment_received") || name.starts_with("refund") || name.starts_with("reversal") {
                "parsed"
            } else if name.starts_with("payment_missing") {
                "failed"
            } else {
                "ignored"
            };
        assert_eq!(status, expected, "{name}");
    }
    assert!(n >= 12);
}

#[test]
fn imap_dates_use_english_months() {
    use ppfeez_core::mail::imap_fetcher::imap_date;
    let d = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
    assert_eq!(imap_date(d("2026-11-01")), "1-Nov-2026");
    assert_eq!(imap_date(d("2026-01-31")), "31-Jan-2026");
}
