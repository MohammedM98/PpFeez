//! Re-parse after a parser update fills what earlier parses left empty, without duplicates and
//! without touching amounts, currency or the customer (owner feedback on 0.2.2).

mod common;

use common::{fixture, harness, open_in};
use ppfeez_core::mail::mailboxes::MailboxInput;
use ppfeez_core::paypal::{html_to_text, ParsedEmail};
use ppfeez_core::transactions::{FeeInput, TxnFilter, TxnStatus};
use rusqlite::Connection;

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

fn pull(h: &common::Harness, mb: i64, files: &[&str]) {
    {
        let mut s = h.mail.0.lock().unwrap();
        for (i, f) in files.iter().enumerate() {
            s.messages.insert(i as u32 + 1, fixture(f));
        }
    }
    let (run, cancel) = h.core.pull_start(mb, None).unwrap();
    h.core.pull_execute(run.id, &cancel, &|_| {});
}

fn txn(h: &common::Harness, id: &str) -> ppfeez_core::transactions::Transaction {
    let f = TxnFilter { search: Some(id.into()), ..Default::default() };
    h.core.txn_list(&f, Default::default(), 1, 5).unwrap().items.remove(0)
}

/// Simulate transactions imported by an older parser: names, emails, notes and fees missing,
/// then restart the app with an older parser version.
fn age(h: common::Harness) -> common::Harness {
    let conn = Connection::open(h.core.db_path()).unwrap();
    conn.execute_batch(
        "UPDATE paypal_transactions SET payer_name = NULL, payer_email = NULL, payer_note = NULL
           WHERE status <> 'approved' OR 1=1;
         UPDATE paypal_transactions SET fee_minor = NULL, net_minor = NULL WHERE status = 'unassigned';
         INSERT INTO settings (key, value) VALUES ('parser_version', '1')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    )
    .unwrap();
    drop(conn);
    let dir = h.dir;
    open_in(dir)
}

#[test]
fn update_backfills_missing_fields_once_without_duplicates() {
    let h = harness();
    let mb = mailbox(&h);
    pull(&h, mb, &["en_friends.eml", "en_goods.eml", "he_friends.eml"]);
    // Approve one transaction first: its amounts must never change.
    let c = h.customer("Ali", 2500);
    let t = txn(&h, "1EN00000000000001");
    h.core.txn_set_fee(t.id, FeeInput::Zero).unwrap();
    let approved = h.core.txn_assign(t.id, c.id, None, true).unwrap();

    let h = age(h); // reopens the core: the one-off re-parse runs at startup
    let a = txn(&h, "1EN00000000000001");
    assert_eq!(a.payer_name.as_deref(), Some("Dana White"));
    assert_eq!(a.payer_note.as_deref(), Some("Rent for Ahmed"));
    assert_eq!(a.status, TxnStatus::Approved);
    assert_eq!(
        (a.gross_minor, a.fee_minor, a.customer_amount_minor, a.customer.as_ref().map(|c| c.id)),
        (approved.gross_minor, approved.fee_minor, approved.customer_amount_minor, Some(c.id)),
        "approved money untouched"
    );
    let g = txn(&h, "1EN00000000000002");
    assert_eq!((g.payer_name.as_deref(), g.payer_email.as_deref()), (Some("Marco Bianchi"), Some("marco@example.org")));
    assert_eq!((g.fee_minor, g.net_minor), (Some(290), Some(7260)), "missing fee filled before approval");
    assert_eq!(txn(&h, "1HE00000000000001").payer_name.as_deref(), Some("נועה לוי"));
    assert_eq!(h.core.txn_counts(&TxnFilter::default()).unwrap().all, 3, "no duplicates");
    let hist: Vec<String> = h.core.txn_history(g.id).unwrap().into_iter().map(|i| i.action).collect();
    assert!(hist.contains(&"txn.backfill".to_string()));

    // Runs once: clearing a name again is not refilled on the next start.
    let conn = Connection::open(h.core.db_path()).unwrap();
    conn.execute("UPDATE paypal_transactions SET payer_name = NULL WHERE paypal_txn_id = '1EN00000000000002'", [])
        .unwrap();
    drop(conn);
    let h = open_in(h.dir);
    assert_eq!(txn(&h, "1EN00000000000002").payer_name, None);
    // But the owner can trigger it on any parsed email.
    let email_id = txn(&h, "1EN00000000000002").raw_email_id.unwrap();
    let r = h.core.email_reparse(&[email_id]).unwrap();
    assert_eq!(r.ok, vec![email_id]);
    assert_eq!(txn(&h, "1EN00000000000002").payer_name.as_deref(), Some("Marco Bianchi"));
}

#[test]
fn review_is_cleared_only_when_a_specialised_parser_matches_the_same_amount() {
    let h = harness();
    let mb = mailbox(&h);
    pull(&h, mb, &["en_goods.eml", "generic_unknown_layout.eml"]);
    let conn = Connection::open(h.core.db_path()).unwrap();
    // Pretend en_goods was caught by the generic parser of an older version.
    conn.execute_batch(
        "UPDATE paypal_transactions SET needs_review = 1, review_reason = 'generic_parser', type = 'refund'
           WHERE paypal_txn_id = '1EN00000000000002';
         UPDATE raw_emails SET parser_name = 'paypal_generic';",
    )
    .unwrap();
    drop(conn);
    let goods = txn(&h, "1EN00000000000002");
    let generic = txn(&h, "5GEN0000000000001");
    let r = h.core.email_reparse(&[goods.raw_email_id.unwrap(), generic.raw_email_id.unwrap()]).unwrap();
    assert_eq!(r.ok.len(), 2);
    let goods = txn(&h, "1EN00000000000002");
    assert!(!goods.needs_review, "specialised parser now matches");
    assert_eq!(goods.kind, ppfeez_core::transactions::TxnType::Payment, "type corrected while unassigned");
    assert!(txn(&h, "5GEN0000000000001").needs_review, "still only the generic parser");
}

#[test]
fn mailto_links_keep_the_address() {
    let t = html_to_text(r#"<p><a href="mailto:dana@example.com?subject=x">Dana White</a> sent you $5.00 USD</p>"#);
    assert!(t.contains("Dana White (dana@example.com)"), "{t}");
    let e = ParsedEmail::new(
        "You've got money",
        "service@paypal.com",
        chrono::Utc::now(),
        Some(
            r#"<p><a href="mailto:dana@example.com">Dana White</a> sent you $5.00 USD</p><p>Transaction ID: 1MT00000000000001</p>"#,
        ),
        None,
    );
    match ppfeez_core::paypal::parse_email(&e) {
        ppfeez_core::paypal::Outcome::Parsed { txn, .. } => {
            assert_eq!(txn.payer_name.as_deref(), Some("Dana White"));
            assert_eq!(txn.payer_email.as_deref(), Some("dana@example.com"));
        }
        other => panic!("{other:?}"),
    }
}
