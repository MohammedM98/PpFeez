//! SPEC §5.3 / §5.6: every payment email type in en/he/ar/tr, the generic fallback, review,
//! eCheck and on-hold handling, PayPal country domains and spoof rejection.

mod common;

use chrono::{TimeZone, Utc};
use common::{code, fixture, harness};
use ppfeez_core::emails::ParseStatus;
use ppfeez_core::error::ErrorCode;
use ppfeez_core::mail::ingest::{evaluate, extract};
use ppfeez_core::mail::mailboxes::MailboxInput;
use ppfeez_core::mail::verify::{verify, Verdict};
use ppfeez_core::paypal::domains::{is_paypal_like, paypal_from_query, registrable, DomainSet};
use ppfeez_core::paypal::{parse_email, Event, Outcome, ParsedEmail};
use ppfeez_core::settings::SettingsPatch;
use ppfeez_core::transactions::{FeeInput, HoldStatus, TxnAction, TxnDetailsInput, TxnFilter, TxnStatus, TxnType};
use serde::Deserialize;

#[derive(Deserialize, Debug)]
struct Expected {
    file: String,
    lang: String,
    domain: String,
    kind: String,
    txn: String,
    gross: i64,
    currency: String,
    fee: Option<i64>,
    payer: Option<String>,
    event: String,
    related: Option<String>,
}

fn expectations() -> Vec<Expected> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/emails/types_expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn stored(name: &str) -> ppfeez_core::mail::ingest::StoredEmail {
    extract(&fixture(name), "fallback", Utc.with_ymd_and_hms(2026, 11, 20, 0, 0, 0).unwrap()).unwrap()
}

fn with_tr() -> DomainSet {
    DomainSet::new(&["paypal.com.tr".to_string()])
}

#[test]
fn every_type_and_language_parses() {
    let all = expectations();
    // 10 types for each of the 4 languages.
    for lang in ["en", "he", "ar", "tr"] {
        assert_eq!(all.iter().filter(|e| e.lang == lang).count(), 10, "{lang}");
    }
    for e in &all {
        let s = stored(&e.file);
        let (status, reason, parser, txn) = evaluate(&s, &with_tr());
        assert_eq!(status, "parsed", "{}: {reason:?}", e.file);
        let parser = parser.unwrap();
        assert!(parser.ends_with(&format!("_{}", e.lang)), "{}: parser {parser}", e.file);
        let t = txn.unwrap();
        let kind = match t.kind {
            TxnType::Payment => "payment",
            TxnType::Refund => "refund",
            TxnType::Reversal => "reversal",
        };
        let event = match t.event {
            Event::Normal => "normal",
            Event::EcheckPending => "echeck_pending",
            Event::EcheckCleared => "echeck_cleared",
            Event::OnHold => "on_hold",
        };
        assert_eq!(kind, e.kind, "{}", e.file);
        assert_eq!(event, e.event, "{}", e.file);
        assert_eq!(t.paypal_txn_id, e.txn, "{}", e.file);
        assert_eq!((t.gross_minor, t.currency.as_str()), (e.gross, e.currency.as_str()), "{}", e.file);
        assert_eq!(t.fee_minor, e.fee, "{}", e.file);
        assert_eq!(t.related_txn_id, e.related, "{}", e.file);
        if let Some(p) = &e.payer {
            assert_eq!(t.payer_name.as_deref(), Some(p.as_str()), "{}", e.file);
        }
        assert!(!t.needs_review, "{}", e.file);
        assert!(!e.domain.is_empty());
    }
}

#[test]
fn notes_dates_and_bidi_marks() {
    let t = evaluate(&stored("he_friends.eml"), &with_tr()).3.unwrap();
    assert_eq!(t.payer_note.as_deref(), Some("שכירות"));
    assert_eq!(t.occurred_at.date_naive().to_string(), "2026-11-18", "dd/mm/yyyy");
    let t = evaluate(&stored("ar_friends.eml"), &with_tr()).3.unwrap();
    assert_eq!(t.payer_note.as_deref(), Some("إيجار"));
    let t = evaluate(&stored("tr_friends.eml"), &with_tr()).3.unwrap();
    assert_eq!(t.payer_note.as_deref(), Some("Kira"));
    assert_eq!(t.occurred_at.date_naive().to_string(), "2026-11-18", "dd.mm.yyyy");
    let t = evaluate(&stored("en_goods.eml"), &with_tr()).3.unwrap();
    assert_eq!(t.payer_email.as_deref(), Some("marco@example.org"));
}

#[test]
fn generic_parser_catches_unknown_layouts_for_review() {
    let (status, _, parser, txn) = evaluate(&stored("generic_unknown_layout.eml"), &DomainSet::builtin());
    assert_eq!((status, parser.as_deref()), ("parsed", Some("paypal_generic")));
    let t = txn.unwrap();
    assert!(t.needs_review);
    assert_eq!((t.paypal_txn_id.as_str(), t.gross_minor, t.currency.as_str()), ("5GEN0000000000001", 7700, "USD"));
    // No 17-character id: not a transaction.
    let e = ParsedEmail::new("PayPal notice", "service@paypal.com", Utc::now(), None, Some("Value: $77.00 USD"));
    assert!(matches!(parse_email(&e), Outcome::Ignored { .. }));
    let e = ParsedEmail::new("Payment notice", "service@paypal.com", Utc::now(), None, Some("Value: $77.00 USD"));
    assert_eq!(parse_email(&e), Outcome::Failed { reason: "missing_field:paypal_txn_id".into(), parser: None });
}

#[test]
fn owner_payments_and_received_refunds_are_ignored_in_every_language() {
    for subject in [
        "You sent a payment of $20.00 USD to Shop",
        "You received a refund from Shop",
        "שלחת תשלום לחנות",
        "קיבלת החזר מחנות",
        "لقد أرسلت دفعة إلى متجر",
        "Ödeme gönderdiniz",
        "Geri ödeme aldınız",
    ] {
        let e = ParsedEmail::new(
            subject,
            "service@paypal.com",
            Utc::now(),
            None,
            Some("Transaction ID: 1AB00000000000009\n$20.00 USD"),
        );
        assert_eq!(parse_email(&e), Outcome::Ignored { reason: "not_transactional".into() }, "{subject}");
    }
}

#[test]
fn domains_and_spoofs() {
    let d = DomainSet::builtin();
    let v = |f: &str, set: &DomainSet| {
        let s = stored(f);
        verify(&s.from_addr, s.auth_results.as_deref(), set)
    };
    assert_eq!(v("he_goods.eml", &d), Verdict::Ok, "paypal.co.il with header.d=paypal.co.il");
    assert_eq!(v("spoof_lookalike_subdomain.eml", &d), Verdict::NotPaypalSender, "paypal.co.il.evil.com");
    assert_eq!(v("spoof_hyphen_domain.eml", &d), Verdict::NotPaypalSender, "paypal-co-il.com");
    assert_eq!(v("spoof_digit_one.eml", &d), Verdict::NotPaypalSender, "paypa1.com");
    assert_eq!(v("spoof_display_name.eml", &d), Verdict::NotPaypalSender, "paypal.com in the display name");
    assert_eq!(v("spoof_dkim_other_domain.eml", &d), Verdict::DkimFail, "approved From, DKIM of another domain");
    assert_eq!(v("spoof_arc_only.eml", &d), Verdict::NoAuthResults, "ARC-Authentication-Results is not trusted");
    assert_eq!(v("tr_goods.eml", &d), Verdict::UnknownPaypalDomain);
    assert_eq!(v("unknown_paypal_de.eml", &d), Verdict::UnknownPaypalDomain);
    assert_eq!(v("tr_goods.eml", &with_tr()), Verdict::Ok, "extra domain from settings");
    // Alignment: DKIM of the parent domain is fine, DKIM of a sibling approved domain is not.
    let ar = |dom: &str| format!("mx.google.com; dkim=pass header.d={dom}");
    assert_eq!(verify("service@mail.paypal.co.il", Some(&ar("paypal.co.il")), &d), Verdict::Ok);
    assert_eq!(verify("service@paypal.co.il", Some(&ar("paypal.com")), &d), Verdict::DkimFail);
    assert_eq!(verify("service@paypal.co.il", Some(&ar("mail.paypal.co.il")), &d), Verdict::DkimFail);
    // PSL helpers.
    assert_eq!(registrable("mail.paypal.co.il").as_deref(), Some("paypal.co.il"));
    assert!(is_paypal_like("service.paypal.com.tr"));
    assert!(!is_paypal_like("paypal.co.il.evil.com"));
    assert!(!is_paypal_like("paypal-co-il.com"));
    assert!(!is_paypal_like("mypaypal.com"));
}

#[test]
fn imap_query_for_one_and_several_domains() {
    assert_eq!(paypal_from_query(&[]), r#"FROM "paypal""#);
    assert_eq!(paypal_from_query(&["paypal.com.tr".into()]), r#"FROM "paypal""#, "already matched by 'paypal'");
    assert_eq!(paypal_from_query(&["pp-mail.example".into()]), r#"OR FROM "paypal" FROM "pp-mail.example""#);
    assert_eq!(
        paypal_from_query(&["a.example".into(), "b.example".into()]),
        r#"OR OR FROM "paypal" FROM "a.example" FROM "b.example""#
    );
}

fn mailbox(h: &common::Harness) -> i64 {
    h.core
        .mailbox_create(MailboxInput {
            label: "PayPal".into(),
            email: "owner@example.com".into(),
            host: None,
            port: None,
            folder: None,
            password: Some("pw".into()),
        })
        .unwrap()
        .id
}

fn pull(h: &common::Harness, mb: i64, files: &[&str]) -> ppfeez_core::mail::pull::PullRun {
    {
        let mut s = h.mail.0.lock().unwrap();
        let start = s.messages.keys().max().copied().unwrap_or(0);
        for (i, f) in files.iter().enumerate() {
            s.messages.insert(start + 1 + i as u32, fixture(f));
        }
    }
    let (run, cancel) = h.core.pull_start(mb, None).unwrap();
    h.core.pull_execute(run.id, &cancel, &|_| {})
}

fn by_id(h: &common::Harness, paypal_id: &str) -> ppfeez_core::transactions::Transaction {
    let f = TxnFilter { search: Some(paypal_id.into()), ..Default::default() };
    h.core
        .txn_list(&f, Default::default(), 1, 5)
        .unwrap()
        .items
        .into_iter()
        .find(|t| t.paypal_txn_id == paypal_id)
        .unwrap()
}

#[test]
fn pull_uses_the_broad_query_and_imports_israeli_mail() {
    let h = harness();
    let mb = mailbox(&h);
    let r = pull(&h, mb, &["he_friends.eml", "he_goods.eml", "spoof_hyphen_domain.eml"]);
    assert_eq!(h.mail.0.lock().unwrap().queries.last().map(String::as_str), Some(r#"FROM "paypal""#));
    assert_eq!((r.new_transactions_count, r.ignored_count), (2, 1));
    // Pulling everything again adds nothing.
    let (run, cancel) = h.core.pull_start(mb, Some(ppfeez_core::mail::pull::PullRange::All)).unwrap();
    let again = h.core.pull_execute(run.id, &cancel, &|_| {});
    assert_eq!((again.new_transactions_count, again.duplicate_count), (0, 3), "already stored emails are skipped");
}

#[test]
fn generic_transactions_need_review_before_approval() {
    let h = harness();
    let mb = mailbox(&h);
    pull(&h, mb, &["generic_unknown_layout.eml"]);
    let t = by_id(&h, "5GEN0000000000001");
    assert!(t.needs_review);
    assert_eq!(t.review_reason_ar.as_deref(), Some("صيغة غير معروفة — راجع البيانات"));
    assert!(t.allowed_actions.contains(&TxnAction::ConfirmReview));
    assert!(t.allowed_actions.contains(&TxnAction::EditDetails));
    assert_eq!(h.core.txn_counts(&TxnFilter::default()).unwrap().needs_review, 1);
    let only = TxnFilter { needs_review_only: Some(true), ..Default::default() };
    assert_eq!(h.core.txn_list(&only, Default::default(), 1, 5).unwrap().total, 1);
    assert_eq!(h.core.dashboard_summary(&Default::default()).unwrap().counts.needs_review, 1);

    let c = h.customer("Ali", 2500);
    h.core.txn_set_fee(t.id, FeeInput::Zero).unwrap();
    assert_eq!(code(h.core.txn_assign(t.id, c.id, None, true)), ErrorCode::InvalidTransition, "approval blocked");
    let t = h.core.txn_assign(t.id, c.id, None, false).unwrap();
    assert!(!t.allowed_actions.contains(&TxnAction::Approve));
    // Correct the data, then confirm.
    let t = h
        .core
        .txn_edit_details(
            t.id,
            TxnDetailsInput {
                gross_text: Some("80.00".into()),
                payer_name: Some("Real Payer".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        (t.gross_minor, t.customer_amount_minor, t.payer_name.as_deref()),
        (8000, Some(6000), Some("Real Payer"))
    );
    let t = h.core.txn_confirm_review(t.id).unwrap();
    assert!(!t.needs_review);
    assert_eq!(code(h.core.txn_confirm_review(t.id)), ErrorCode::InvalidTransition);
    let t = h.core.txn_approve(t.id).unwrap();
    assert_eq!(t.status, TxnStatus::Approved);
    assert_eq!(code(h.core.txn_edit_details(t.id, TxnDetailsInput::default())), ErrorCode::InvalidTransition);
    let actions: Vec<_> = h.core.txn_history(t.id).unwrap().into_iter().map(|i| i.action).collect();
    assert!(actions.contains(&"txn.edit_details".to_string()) && actions.contains(&"txn.confirm_review".to_string()));
}

#[test]
fn echeck_pending_then_cleared_updates_the_same_transaction() {
    let h = harness();
    let mb = mailbox(&h);
    pull(&h, mb, &["en_echeck_pending.eml"]);
    let t = by_id(&h, "1EN00000000000006");
    assert_eq!(t.hold_status, Some(HoldStatus::PendingEcheck));
    let c = h.customer("Ali", 2500);
    h.core.txn_set_fee(t.id, FeeInput::Zero).unwrap();
    h.core.txn_assign(t.id, c.id, None, false).unwrap();
    assert_eq!(code(h.core.txn_approve(t.id)), ErrorCode::InvalidTransition, "pending eCheck cannot be approved");
    let r = pull(&h, mb, &["en_echeck_cleared.eml"]);
    assert_eq!((r.new_transactions_count, r.duplicate_count), (0, 1));
    let t = by_id(&h, "1EN00000000000006");
    assert_eq!(t.hold_status, None);
    assert_eq!(h.core.txn_counts(&TxnFilter::default()).unwrap().all, 1, "no second transaction");
    h.core.txn_approve(t.id).unwrap();
}

#[test]
fn on_hold_marks_the_existing_transaction_and_never_creates_one() {
    let h = harness();
    let mb = mailbox(&h);
    // Hold notice before the payment: nothing created.
    let r = pull(&h, mb, &["he_on_hold.eml"]);
    assert_eq!((r.new_transactions_count, r.ignored_count), (0, 1));
    assert_eq!(h.core.txn_counts(&TxnFilter::default()).unwrap().all, 0);
    let ignored = h.core.emails_list(ParseStatus::Ignored, None, 1, 5).unwrap();
    assert_eq!(ignored.items[0].parse_reason.as_deref(), Some("hold_notice"));
    // Payment, then a hold notice for the same id.
    let h = harness();
    let mb = mailbox(&h);
    pull(&h, mb, &["he_friends.eml"]);
    let r = pull(&h, mb, &["he_on_hold.eml"]);
    assert_eq!(r.new_transactions_count, 0);
    let t = by_id(&h, "1HE00000000000001");
    assert_eq!(t.hold_status, Some(HoldStatus::OnHold));
    assert_eq!(h.core.txn_counts(&TxnFilter::default()).unwrap().all, 1);
}

#[test]
fn unknown_paypal_domain_can_be_trusted_and_reparsed() {
    let h = harness();
    let mb = mailbox(&h);
    let r = pull(&h, mb, &["tr_friends.eml", "tr_goods.eml", "unknown_paypal_de.eml"]);
    assert_eq!((r.new_transactions_count, r.ignored_count), (0, 3));
    let unknown = h.core.unknown_paypal_domains().unwrap();
    let list: Vec<(String, i64)> = unknown.into_iter().map(|u| (u.domain, u.count)).collect();
    assert_eq!(list, vec![("paypal.com.tr".to_string(), 2), ("paypal.de".to_string(), 1)]);
    assert_eq!(h.core.dashboard_summary(&Default::default()).unwrap().counts.unknown_paypal_domains, 2);

    let res = h.core.paypal_domain_trust("paypal.com.tr").unwrap();
    assert_eq!(res.domain, "paypal.com.tr");
    assert_eq!(res.reparsed.ok.len(), 2);
    assert!(res.reparsed.failed.is_empty());
    assert_eq!(h.core.txn_counts(&TxnFilter::default()).unwrap().all, 2);
    assert_eq!(h.core.get_settings().unwrap().extra_paypal_domains, vec!["paypal.com.tr".to_string()]);
    assert_eq!(h.core.unknown_paypal_domains().unwrap().len(), 1, "paypal.de still waiting");
    // New mail from the trusted domain is accepted directly.
    let r = pull(&h, mb, &["tr_request.eml"]);
    assert_eq!(r.new_transactions_count, 1);
    assert_eq!(code(h.core.paypal_domain_trust("not a domain")), ErrorCode::Validation);
}

#[test]
fn extra_domains_setting_is_validated() {
    let h = harness();
    let s = h
        .core
        .update_settings(SettingsPatch {
            extra_paypal_domains: Some(vec![" PayPal.DE ".into(), "paypal.de".into(), "paypal.com".into()]),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(s.extra_paypal_domains, vec!["paypal.de".to_string()], "normalized, de-duplicated, built-ins dropped");
    assert_eq!(s.builtin_paypal_domains, vec!["paypal.com", "paypal.co.il", "paypal.co.uk"]);
    let bad =
        h.core.update_settings(SettingsPatch { extra_paypal_domains: Some(vec!["evil".into()]), ..Default::default() });
    assert_eq!(code(bad), ErrorCode::Validation);
}
