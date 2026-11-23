mod common;

use common::{code, fixture, harness};
use ppfeez_core::emails::ParseStatus;
use ppfeez_core::error::ErrorCode;
use ppfeez_core::mail::mailboxes::MailboxInput;
use ppfeez_core::mail::pull::PullStatus;
use ppfeez_core::transactions::TxnFilter;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// A synthetic verified PayPal payment email with a unique id.
fn payment_eml(n: u32) -> Vec<u8> {
    format!(
        "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@paypal.com header.s=pp\r\n\
From: service@paypal.com\r\nTo: owner@example.com\r\nSubject: You've got money\r\n\
Date: Fri, 20 Nov 2026 10:00:00 +0000\r\nMessage-ID: <gen-{n}@paypal.com>\r\nContent-Type: text/plain\r\n\r\n\
Customer {n} sent you ${n}.00 USD\r\nTransaction ID: {:017}\r\n",
        9_000_000_000_000_000u64 + n as u64
    )
    .into_bytes()
}

fn mailbox(h: &common::Harness) -> i64 {
    h.core
        .mailbox_create(MailboxInput {
            label: "PayPal".into(),
            email: "owner@example.com".into(),
            host: None,
            port: None,
            folder: None,
            password: Some("abcd efgh".into()),
        })
        .unwrap()
        .id
}

fn run(h: &common::Harness, mb: i64) -> ppfeez_core::mail::pull::PullRun {
    let (run, cancel) = h.core.pull_start(mb).unwrap();
    h.core.pull_execute(run.id, &cancel, &|_| {})
}

fn txn_count(h: &common::Harness) -> i64 {
    h.core.txn_counts(&TxnFilter::default()).unwrap().all
}

#[test]
fn batches_progress_and_last_uid() {
    let h = harness();
    let mb = mailbox(&h);
    {
        let mut s = h.mail.0.lock().unwrap();
        for uid in 1..=120 {
            s.messages.insert(uid * 2, payment_eml(uid));
        }
    }
    let progress = Mutex::new(vec![]);
    let (r, cancel) = h.core.pull_start(mb).unwrap();
    let done = h.core.pull_execute(r.id, &cancel, &|p| progress.lock().unwrap().push(p.fetched_count));
    assert_eq!(done.status, PullStatus::Done);
    assert_eq!((done.total_count, done.fetched_count, done.new_transactions_count), (120, 120, 120));
    assert_eq!(*progress.lock().unwrap(), vec![0, 50, 100, 120], "one event per batch of 50");
    let batches: Vec<usize> = h.mail.0.lock().unwrap().fetched_batches.iter().map(Vec::len).collect();
    assert_eq!(batches, vec![50, 50, 20]);
    let m = h.core.mailbox_get(mb).unwrap();
    assert_eq!(m.last_uid, 240);
    assert!(m.last_pulled_at.is_some());
    assert_eq!(txn_count(&h), 120);
    assert_eq!(h.secrets_password(mb), "abcdefgh", "app password stored without spaces");
}

trait Pw {
    fn secrets_password(&self, mb: i64) -> String;
}
impl Pw for common::Harness {
    fn secrets_password(&self, mb: i64) -> String {
        use ppfeez_core::mail::secrets::{mailbox_key, SecretStore};
        self.secrets.get(&mailbox_key(mb)).unwrap().unwrap()
    }
}

#[test]
fn second_pull_is_incremental_without_duplicates() {
    let h = harness();
    let mb = mailbox(&h);
    {
        let mut s = h.mail.0.lock().unwrap();
        s.messages.insert(1, fixture("payment_received_basic.eml"));
        s.messages.insert(2, fixture("non_financial_login.eml"));
        s.messages.insert(3, fixture("payment_missing_txn_id.eml"));
    }
    let first = run(&h, mb);
    assert_eq!((first.new_transactions_count, first.ignored_count, first.failed_count), (1, 1, 1));
    h.mail.0.lock().unwrap().messages.insert(4, fixture("payment_received_with_fee.eml"));
    let second = run(&h, mb);
    assert_eq!(h.mail.0.lock().unwrap().searches, vec![None, Some(3)]);
    assert_eq!((second.total_count, second.new_transactions_count), (1, 1));
    let third = run(&h, mb);
    assert_eq!((third.total_count, third.new_transactions_count), (0, 0));
    assert_eq!(txn_count(&h), 2);
}

#[test]
fn same_transaction_in_two_emails_counts_as_duplicate() {
    let h = harness();
    let mb = mailbox(&h);
    let copy = String::from_utf8(fixture("payment_received_basic.eml"))
        .unwrap()
        .replace("payment-basic-001@paypal.com", "payment-basic-copy@paypal.com")
        .into_bytes();
    {
        let mut s = h.mail.0.lock().unwrap();
        s.messages.insert(1, fixture("payment_received_basic.eml"));
        s.messages.insert(2, copy);
    }
    let r = run(&h, mb);
    assert_eq!((r.new_transactions_count, r.duplicate_count), (1, 1));
    assert_eq!(txn_count(&h), 1);
}

#[test]
fn uidvalidity_change_rescans_without_duplicates() {
    let h = harness();
    let mb = mailbox(&h);
    {
        let mut s = h.mail.0.lock().unwrap();
        s.messages.insert(10, payment_eml(1));
        s.messages.insert(11, payment_eml(2));
    }
    run(&h, mb);
    {
        // The server renumbers the folder: same messages, new UIDs, new UIDVALIDITY.
        let mut s = h.mail.0.lock().unwrap();
        s.uid_validity = 2;
        s.messages.clear();
        s.messages.insert(1, payment_eml(1));
        s.messages.insert(2, payment_eml(2));
        s.messages.insert(3, payment_eml(3));
    }
    let r = run(&h, mb);
    assert_eq!(h.mail.0.lock().unwrap().searches.last(), Some(&None), "full search again");
    assert_eq!((r.total_count, r.new_transactions_count, r.duplicate_count), (3, 1, 2));
    assert_eq!(h.core.mailbox_get(mb).unwrap().last_uid, 3);
    assert_eq!(txn_count(&h), 3);
}

#[test]
fn error_mid_run_then_resume() {
    let h = harness();
    let mb = mailbox(&h);
    {
        let mut s = h.mail.0.lock().unwrap();
        for uid in 1..=120 {
            s.messages.insert(uid, payment_eml(uid));
        }
        s.fail_on_fetch_call = Some(2);
    }
    let r = run(&h, mb);
    assert_eq!(r.status, PullStatus::Failed);
    assert_eq!(r.error.as_deref(), Some("انقطع الاتصال"));
    assert_eq!(r.new_transactions_count, 50, "first batch kept");
    assert_eq!(h.core.mailbox_get(mb).unwrap().last_uid, 50);
    assert!(h.core.mailbox_get(mb).unwrap().last_pulled_at.is_none());

    let r = run(&h, mb);
    assert_eq!(r.status, PullStatus::Done);
    assert_eq!((r.total_count, r.new_transactions_count), (70, 70));
    assert_eq!(txn_count(&h), 120);
}

#[test]
fn cancel_between_batches() {
    let h = harness();
    let mb = mailbox(&h);
    {
        let mut s = h.mail.0.lock().unwrap();
        for uid in 1..=120 {
            s.messages.insert(uid, payment_eml(uid));
        }
    }
    let (r, cancel) = h.core.pull_start(mb).unwrap();
    let flag: &AtomicBool = &cancel;
    let done = h.core.pull_execute(r.id, flag, &|p| {
        if p.fetched_count >= 50 {
            flag.store(true, Ordering::SeqCst);
        }
    });
    assert_eq!(done.status, PullStatus::Cancelled);
    assert_eq!(done.fetched_count, 50);
    assert_eq!(code(h.core.pull_cancel(r.id)), ErrorCode::InvalidTransition, "no longer running");
}

#[test]
fn one_running_pull_per_mailbox_and_stale_runs_fail_on_startup() {
    let h = harness();
    let mb = mailbox(&h);
    let (r, cancel) = h.core.pull_start(mb).unwrap();
    assert_eq!(code(h.core.pull_start(mb)), ErrorCode::PullRunning);
    assert!(h.core.mailbox_get(mb).unwrap().running);
    h.core.pull_cancel(r.id).unwrap();
    assert!(cancel.load(Ordering::SeqCst));

    // Simulate a crash: reopen the database while the run is still marked running.
    let dir = h.dir;
    let h2 = common::open_in(dir);
    let runs = h2.core.pull_runs_list(5).unwrap();
    assert_eq!(runs[0].status, PullStatus::Failed);
    assert_eq!(runs[0].error.as_deref(), Some("انقطع"));
    h2.secrets.set_for_test(mb);
    h2.core.pull_start(mb).unwrap();
}

trait SetPw {
    fn set_for_test(&self, mb: i64);
}
impl SetPw for ppfeez_core::mail::secrets::MemorySecretStore {
    fn set_for_test(&self, mb: i64) {
        use ppfeez_core::mail::secrets::{mailbox_key, SecretStore};
        self.set(&mailbox_key(mb), "x").unwrap();
    }
}

#[test]
fn auth_failure_and_missing_password() {
    let h = harness();
    let mb = h
        .core
        .mailbox_create(MailboxInput {
            label: "No password".into(),
            email: "a@example.com".into(),
            host: None,
            port: None,
            folder: None,
            password: None,
        })
        .unwrap();
    assert!(!mb.has_password);
    assert_eq!(code(h.core.mailbox_test(Some(mb.id), None)), ErrorCode::ImapAuth);
    let r = run(&h, mb.id);
    assert_eq!(r.status, PullStatus::Failed);
    h.core.mailbox_set_password(mb.id, "wrong").unwrap();
    assert_eq!(code(h.core.mailbox_test(Some(mb.id), None)), ErrorCode::ImapAuth);
    // Unsaved settings can be tested too (onboarding).
    let ok = h
        .core
        .mailbox_test(
            None,
            Some(MailboxInput {
                label: "x".into(),
                email: "b@example.com".into(),
                host: None,
                port: None,
                folder: None,
                password: Some("good".into()),
            }),
        )
        .unwrap();
    assert!(ok.ok);
}

#[test]
fn mailbox_management() {
    let h = harness();
    let mb = mailbox(&h);
    let bad =
        MailboxInput { label: "".into(), email: "x".into(), host: None, port: None, folder: None, password: None };
    assert_eq!(code(h.core.mailbox_create(bad)), ErrorCode::Validation);
    let dup = MailboxInput {
        label: "Again".into(),
        email: "OWNER@example.com".into(),
        host: None,
        port: None,
        folder: None,
        password: None,
    };
    assert_eq!(code(h.core.mailbox_create(dup)), ErrorCode::Duplicate);

    let m = h.core.mailbox_set_active(mb, false).unwrap();
    assert!(!m.is_active);
    assert_eq!(code(h.core.pull_start(mb)), ErrorCode::Validation);
    h.core.mailbox_set_active(mb, true).unwrap();

    h.mail.0.lock().unwrap().messages.insert(1, fixture("payment_received_basic.eml"));
    run(&h, mb);
    assert_eq!(code(h.core.mailbox_delete(mb)), ErrorCode::HasDependents);

    let empty = h
        .core
        .mailbox_create(MailboxInput {
            label: "Empty".into(),
            email: "empty@example.com".into(),
            host: None,
            port: None,
            folder: None,
            password: Some("p".into()),
        })
        .unwrap();
    h.mail.0.lock().unwrap().messages.insert(2, fixture("non_financial_login.eml"));
    run(&h, empty.id);
    h.core.mailbox_delete(empty.id).unwrap();
    assert_eq!(h.core.mailbox_list().unwrap().len(), 1);
}

#[test]
fn emails_screen_reparse_and_ignore() {
    let h = harness();
    let mb = mailbox(&h);
    {
        let mut s = h.mail.0.lock().unwrap();
        s.messages.insert(1, fixture("payment_missing_txn_id.eml"));
        s.messages.insert(2, fixture("dkim_fail.eml"));
        s.messages.insert(3, fixture("payment_received_jpy.eml"));
    }
    run(&h, mb);
    let failed = h.core.emails_list(ParseStatus::Failed, None, 1, 50).unwrap();
    assert_eq!(failed.total, 1);
    let f = &failed.items[0];
    assert_eq!(f.parse_reason.as_deref(), Some("missing_field:paypal_txn_id"));
    assert_eq!(f.parse_reason_ar.as_deref(), Some("تعذّر استخراج حقل إلزامي: رقم المعاملة"));
    let ignored = h.core.emails_list(ParseStatus::Ignored, Some("money"), 1, 50).unwrap();
    assert_eq!(ignored.items[0].parse_reason.as_deref(), Some("dkim_fail"));
    let parsed = h.core.emails_list(ParseStatus::Parsed, None, 1, 50).unwrap();
    assert!(parsed.items[0].transaction_id.is_some());

    // Re-parse keeps failing (no new parser), and parsed ones are refused.
    let r = h.core.email_reparse(&[f.id, parsed.items[0].id]).unwrap();
    assert!(r.ok.is_empty());
    assert_eq!(r.failed.len(), 2);
    // A forged email stays ignored on re-parse.
    let r = h.core.email_reparse(&[ignored.items[0].id]).unwrap();
    assert_eq!(r.failed.len(), 1);
    assert_eq!(h.core.email_get(ignored.items[0].id).unwrap().summary.parse_reason.as_deref(), Some("dkim_fail"));

    // Manual transaction from a failed email links it.
    let t = h
        .core
        .txn_create_manual(ppfeez_core::transactions::ManualTxnInput {
            occurred_at: "2026-11-26 13:00".into(),
            payer_name: Some("Ali Hassan".into()),
            payer_email: None,
            payer_note: None,
            currency: "USD".into(),
            gross_text: "25".into(),
            fee_text: None,
            paypal_txn_id: Some("8MANUAL000000001".into()),
            note: None,
            raw_email_id: Some(f.id),
        })
        .unwrap();
    assert_eq!(t.raw_email_id, Some(f.id));
    assert_eq!(t.mailbox.as_ref().map(|m| m.id), Some(mb));
    let e = h.core.email_get(f.id).unwrap();
    assert_eq!((e.summary.parse_status, e.summary.transaction_id), (ParseStatus::Parsed, Some(t.id)));

    h.core.email_set_ignored(ignored.items[0].id).unwrap();
    assert_eq!(code(h.core.email_set_ignored(parsed.items[0].id)), ErrorCode::InvalidTransition);
    let body = h.core.email_get(parsed.items[0].id).unwrap();
    assert!(body.body_html.unwrap().contains("Taro Yamada"));
    assert_eq!(body.parser_name.as_deref(), Some("paypal_payment_received_en"));
}

#[test]
fn reparse_succeeds_once_the_email_becomes_parsable() {
    // Simulates "update the program with a new parser": a failed row whose stored body
    // is understood by the current parsers is turned into a transaction.
    let h = harness();
    let mb = mailbox(&h);
    h.mail.0.lock().unwrap().messages.insert(1, fixture("payment_received_with_fee.eml"));
    run(&h, mb);
    let conn = rusqlite::Connection::open(h.core.db_path()).unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys=ON; DELETE FROM audit_log; DELETE FROM paypal_transactions;
         UPDATE raw_emails SET parse_status='failed', parse_reason='no_parser_matched', parser_name=NULL;",
    )
    .unwrap();
    let id = h.core.emails_list(ParseStatus::Failed, None, 1, 5).unwrap().items[0].id;
    let r = h.core.email_reparse(&[id]).unwrap();
    assert_eq!(r.ok, vec![id]);
    assert_eq!(txn_count(&h), 1);
    assert_eq!(h.core.email_get(id).unwrap().summary.parse_status, ParseStatus::Parsed);
}
