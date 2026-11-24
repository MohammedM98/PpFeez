//! Real PayPal Israel (en-IL) "You've got money" emails from the owner's mailbox, redacted: every
//! person, address, account and tracking token is fictional; layout, amounts and dates are real.
//! The payer's name is only in "Accept your $X USD from NAME"; these emails carry no payer email.

mod common;

use chrono::{TimeZone, Utc};
use common::{fixture, harness, open_in};
use ppfeez_core::mail::ingest::{evaluate, extract};
use ppfeez_core::mail::mailboxes::MailboxInput;
use ppfeez_core::paypal::domains::DomainSet;
use ppfeez_core::paypal::Event;
use ppfeez_core::transactions::{TxnFilter, TxnType};
use rusqlite::Connection;

struct Case {
    file: &'static str,
    txn: &'static str,
    gross: i64,
    fee: i64,
    payer: &'static str,
    occurred: &'static str,
}

const CASES: &[Case] = &[
    Case {
        file: "real_il_goods_fee.eml",
        txn: "9TS7001002003004A",
        gross: 10000,
        fee: 673,
        payer: "Rami Nasser",
        occurred: "2026-11-24T08:47:15+00:00",
    },
    Case {
        file: "real_il_shipping_il.eml",
        txn: "55667788KL990011B",
        gross: 54600,
        fee: 2226,
        payer: "Yusuf Khalil",
        occurred: "2026-11-23T20:34:00+00:00",
    },
    // "Transaction date 24 November 2026" (Israel) on an email received 23 Nov 23:40 UTC.
    Case {
        file: "real_il_shipping_au.eml",
        txn: "7XY300400500600QC",
        gross: 900,
        fee: 93,
        payer: "Emma Clarke",
        occurred: "2026-11-23T23:40:27+00:00",
    },
];

#[test]
fn real_israeli_emails_parse_with_the_payer_name() {
    let now = Utc.with_ymd_and_hms(2026, 11, 25, 0, 0, 0).unwrap();
    for c in CASES {
        let s = extract(&fixture(c.file), "fallback", now).unwrap();
        let (status, reason, parser, txn) = evaluate(&s, &DomainSet::new(&[]));
        assert_eq!(status, "parsed", "{}: {reason:?}", c.file);
        assert_eq!(parser.as_deref(), Some("paypal_payment_en"), "{}", c.file);
        let t = txn.unwrap();
        assert_eq!(t.kind, TxnType::Payment, "{}", c.file);
        assert_eq!(t.event, Event::Normal, "{}", c.file);
        assert_eq!(t.paypal_txn_id, c.txn, "{}", c.file);
        assert_eq!((t.gross_minor, t.currency.as_str(), t.fee_minor), (c.gross, "USD", Some(c.fee)), "{}", c.file);
        // The payer, never the account owner greeted at the top ("Sami Haddad, you received ...").
        assert_eq!(t.payer_name.as_deref(), Some(c.payer), "{}", c.file);
        assert_eq!(t.payer_email, None, "{}: no payer email in this layout", c.file);
        assert_eq!(t.payer_note, None, "{}", c.file);
        assert_eq!(t.occurred_at.to_rfc3339(), c.occurred, "{}", c.file);
        assert!(!t.needs_review, "{}", c.file);
    }
}

#[test]
fn update_fills_payer_names_left_empty_by_older_versions() {
    let h = harness();
    let mb = h
        .core
        .mailbox_create(MailboxInput {
            label: "PayPal".into(),
            email: "owner@example.com".into(),
            host: None,
            port: None,
            folder: None,
            password: Some("pw".into()),
        })
        .unwrap()
        .id;
    {
        let mut s = h.mail.0.lock().unwrap();
        for (i, c) in CASES.iter().enumerate() {
            s.messages.insert(i as u32 + 1, fixture(c.file));
        }
    }
    let (run, cancel) = h.core.pull_start(mb, None).unwrap();
    h.core.pull_execute(run.id, &cancel, &|_| {});

    // As imported by 0.3.0 and earlier: no names; then start the updated app.
    let conn = Connection::open(h.core.db_path()).unwrap();
    conn.execute_batch(
        "UPDATE paypal_transactions SET payer_name = NULL;
         UPDATE settings SET value = '2' WHERE key = 'parser_version';",
    )
    .unwrap();
    drop(conn);
    let h = open_in(h.dir);
    let all = h.core.txn_list(&TxnFilter::default(), Default::default(), 1, 10).unwrap();
    assert_eq!(all.items.len(), CASES.len(), "no duplicates");
    for c in CASES {
        let t = all.items.iter().find(|t| t.paypal_txn_id == c.txn).unwrap();
        assert_eq!(t.payer_name.as_deref(), Some(c.payer), "{}", c.file);
        assert_eq!((t.gross_minor, t.fee_minor), (c.gross, Some(c.fee)), "{}", c.file);
    }
}
