//! SPEC §4.7: deleting transactions, customers, ledger entries, and "start fresh".

mod common;

use common::{code, fixture, harness, open_in};
use ppfeez_core::deletion::ResetScope;
use ppfeez_core::emails::ParseStatus;
use ppfeez_core::error::ErrorCode;
use ppfeez_core::ledger::{LedgerType, PayoutInput, PayoutMethod};
use ppfeez_core::mail::mailboxes::MailboxInput;
use ppfeez_core::mail::secrets::{mailbox_key, SecretStore};
use ppfeez_core::settings::SettingsPatch;
use ppfeez_core::transactions::{FeeInput, TxnAction, TxnFilter, TxnStatus};
use rusqlite::Connection;

fn backups_on(h: &common::Harness) {
    let dir = h.dir.path().join("backups");
    h.core
        .update_settings(SettingsPatch { backup_dir: Some(Some(dir.display().to_string())), ..Default::default() })
        .unwrap();
}

fn approved(h: &common::Harness, customer: i64, gross: &str) -> i64 {
    let t = h.manual("USD", gross, Some("0"));
    h.core.txn_assign(t.id, customer, None, true).unwrap();
    t.id
}

fn payout(h: &common::Harness, customer: i64, amount: &str) -> i64 {
    h.core
        .ledger_add_payout(
            customer,
            PayoutInput {
                platform: None,
                network: None,
                destination: None,
                currency: "USD".into(),
                amount_text: amount.into(),
                entry_date: "2026-11-23".into(),
                method: PayoutMethod::Cash,
                reference: None,
                description: None,
                confirm_overdraw: Some(true),
            },
        )
        .unwrap()
        .id
}

fn audit_actions(h: &common::Harness) -> Vec<String> {
    let conn = Connection::open(h.core.db_path()).unwrap();
    let mut stmt = conn.prepare("SELECT action FROM audit_log ORDER BY id").unwrap();
    stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
}

#[test]
fn delete_unapproved_and_approved_transactions() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let free = h.manual("USD", "10", None);
    assert!(free.allowed_actions.contains(&TxnAction::Delete));
    let r = h.core.txn_delete(&[free.id], Some("test")).unwrap();
    assert_eq!(r.result.ok, vec![free.id]);
    assert!(r.backup.is_none(), "single delete: no backup");
    assert_eq!(code(h.core.txn_get(free.id)), ErrorCode::NotFound);

    let a = approved(&h, c.id, "100"); // balance 75.00
    let other = approved(&h, c.id, "40"); // + 30.00
    h.core.txn_unapprove(other, "wrong").unwrap(); // credit + reversal remain
    h.core.txn_assign(other, c.id, None, true).unwrap(); // credit again
    assert_eq!(h.balance(c.id, "USD"), 10500);

    let p = h.core.txn_delete_preview(&[a, other, 999]).unwrap();
    assert_eq!((p.count, p.approved_count, p.ledger_entry_count), (2, 2, 4));
    assert_eq!(p.effects.len(), 1);
    assert_eq!((p.effects[0].customer_name.as_str(), p.effects[0].balance_delta_minor), ("Ali", -10500));

    backups_on(&h);
    let r = h.core.txn_delete(&[a, other, 999], None).unwrap();
    assert_eq!(r.result.ok, vec![a, other]);
    assert_eq!(r.result.failed[0].code, ErrorCode::NotFound);
    assert!(r.backup.is_some(), "bulk delete takes a backup");
    assert_eq!(h.balance(c.id, "USD"), 0, "as if they never existed");
    assert!(h.core.ledger_entries(c.id, "USD", None).unwrap().entries.is_empty());
    assert_eq!(audit_actions(&h).iter().filter(|a| *a == "txn.delete").count(), 3);
}

#[test]
fn deleted_email_transactions_do_not_come_back_but_reparse_restores_them() {
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
    h.mail.0.lock().unwrap().messages.insert(1, fixture("payment_received_basic.eml"));
    let (run, cancel) = h.core.pull_start(mb, None).unwrap();
    h.core.pull_execute(run.id, &cancel, &|_| {});
    let t = h.core.txn_list(&TxnFilter::default(), Default::default(), 1, 5).unwrap().items.remove(0);
    h.core.txn_delete(&[t.id], None).unwrap();

    let (run, cancel) = h.core.pull_start(mb, Some(ppfeez_core::mail::pull::PullRange::All)).unwrap();
    let r = h.core.pull_execute(run.id, &cancel, &|_| {});
    assert_eq!(r.new_transactions_count, 0, "not imported again");
    let ignored = h.core.emails_list(ParseStatus::Ignored, None, 1, 5).unwrap();
    assert_eq!(ignored.items[0].parse_reason.as_deref(), Some("deleted_by_user"));
    // A parser update must not restore it on its own.
    let conn = Connection::open(h.core.db_path()).unwrap();
    conn.execute("UPDATE settings SET value = '1' WHERE key = 'parser_version'", []).unwrap();
    drop(conn);
    let h = open_in(h.dir);
    assert_eq!(h.core.txn_counts(&TxnFilter::default()).unwrap().all, 0);
    // The owner can bring it back.
    let r = h.core.email_reparse(&[ignored.items[0].id]).unwrap();
    assert_eq!(r.ok.len(), 1);
    let back = h.core.txn_list(&TxnFilter::default(), Default::default(), 1, 5).unwrap().items.remove(0);
    assert_eq!((back.paypal_txn_id.as_str(), back.status), ("9AB12345CD6789012", TxnStatus::Unassigned));
}

#[test]
fn delete_customer_removes_ledger_and_unassigns_transactions() {
    let h = harness();
    let c = h.customer("سارة", 2500);
    let a = approved(&h, c.id, "100");
    let pending = h.manual("USD", "20", None);
    h.core.txn_assign(pending.id, c.id, None, false).unwrap();
    payout(&h, c.id, "10");
    let p = h.core.customer_delete_preview(c.id).unwrap();
    assert_eq!((p.assigned_count, p.approved_count, p.ledger_entry_count), (1, 1, 2));
    assert_eq!(p.balances[0].minor, 6500);

    // Surrounding spaces are tolerated, any other difference is not.
    let e = h.core.customer_delete(c.id, "Sara").unwrap_err();
    assert_eq!((e.code, e.field.as_deref()), (ErrorCode::ConfirmMismatch, Some("confirmName")));
    backups_on(&h);
    let r = h.core.customer_delete(c.id, "سارة").unwrap();
    assert!(r.backup.is_some());
    assert_eq!(code(h.core.customer_get(c.id)), ErrorCode::NotFound);
    for id in [a, pending.id] {
        let t = h.core.txn_get(id).unwrap();
        assert_eq!((t.status, t.customer.is_none(), t.customer_amount_minor), (TxnStatus::Unassigned, true, None));
    }
    assert!(audit_actions(&h).contains(&"customer.delete".to_string()));
}

#[test]
fn delete_ledger_entries() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    approved(&h, c.id, "100"); // 75.00
    let p1 = payout(&h, c.id, "10");
    let p2 = payout(&h, c.id, "5");
    h.core.ledger_reverse_entry(p2, "duplicate").unwrap();
    let entries = h.core.ledger_entries(c.id, "USD", None).unwrap().entries;
    let credit = entries.iter().find(|e| e.kind == LedgerType::Credit).unwrap();
    assert!(!credit.deletable);
    assert!(credit.not_deletable_reason_ar.is_some());
    assert_eq!(code(h.core.ledger_delete_entry(credit.id, None)), ErrorCode::NotDeletable);
    assert_eq!(code(h.core.ledger_delete_preview(credit.id)), ErrorCode::NotDeletable);

    // A plain payout.
    let pv = h.core.ledger_delete_preview(p1).unwrap();
    assert_eq!((pv.entries.len(), pv.balance_before_minor, pv.balance_after_minor), (1, 6500, 7500));
    h.core.ledger_delete_entry(p1, Some("typo")).unwrap();
    assert_eq!(h.balance(c.id, "USD"), 7500);

    // A reversed payout goes together with its reversal.
    let pv = h.core.ledger_delete_preview(p2).unwrap();
    assert_eq!((pv.entries.len(), pv.balance_after_minor), (2, 7500));
    h.core.ledger_delete_entry(p2, None).unwrap();
    assert_eq!(h.core.ledger_entries(c.id, "USD", None).unwrap().entries.len(), 1);

    // Deleting only a reversal makes the original active again.
    let p3 = payout(&h, c.id, "20");
    let rev = h.core.ledger_reverse_entry(p3, "x").unwrap();
    h.core.ledger_delete_entry(rev.id, None).unwrap();
    assert_eq!(h.balance(c.id, "USD"), 5500);
    let p3e = h.core.ledger_entries(c.id, "USD", None).unwrap().entries.into_iter().find(|e| e.id == p3).unwrap();
    assert_eq!(p3e.reversed_by_entry_id, None);

    // Direct SQL outside the flow still fails; UPDATE always fails.
    let conn = Connection::open(h.core.db_path()).unwrap();
    assert!(conn.execute("DELETE FROM ledger_entries WHERE id = ?1", [p3]).is_err());
    assert!(conn.execute("UPDATE ledger_entries SET amount_minor = 1 WHERE id = ?1", [p3]).is_err());
    let token: i64 = conn.query_row("SELECT COUNT(*) FROM _ledger_delete_token", [], |r| r.get(0)).unwrap();
    assert_eq!(token, 0, "token never left behind");
    assert!(audit_actions(&h).iter().filter(|a| *a == "ledger.delete").count() >= 3);
}

#[test]
fn failure_midway_leaves_nothing_deleted() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let a = approved(&h, c.id, "100");
    // Make the audit insert fail inside the delete transaction.
    let conn = Connection::open(h.core.db_path()).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'txn.delete'
         BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    )
    .unwrap();
    assert!(h.core.txn_delete(&[a], None).is_err());
    assert_eq!(h.core.txn_get(a).unwrap().status, TxnStatus::Approved);
    assert_eq!(h.balance(c.id, "USD"), 7500);
    let token: i64 = conn.query_row("SELECT COUNT(*) FROM _ledger_delete_token", [], |r| r.get(0)).unwrap();
    assert_eq!(token, 0, "rolled back with the transaction");
}

fn seeded() -> common::Harness {
    let h = harness();
    let c = h.customer("Ali", 2500);
    approved(&h, c.id, "100");
    payout(&h, c.id, "10");
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
    h.mail.0.lock().unwrap().messages.insert(1, fixture("payment_received_basic.eml"));
    let (run, cancel) = h.core.pull_start(mb, None).unwrap();
    h.core.pull_execute(run.id, &cancel, &|_| {});
    h.core.update_settings(SettingsPatch { default_commission_bps: Some(1000), ..Default::default() }).unwrap();
    h.core.set_lock_password(None, Some("1234")).unwrap();
    h
}

#[test]
fn reset_requires_the_word_and_always_backs_up() {
    let h = seeded();
    let all = ResetScope { transactions: true, customers: true, mailboxes: true, settings: true };
    let e = h.core.data_reset(all, "delete").unwrap_err();
    assert_eq!(e.code, ErrorCode::ConfirmMismatch);
    let p = h.core.data_reset_preview(all).unwrap();
    assert_eq!((p.transactions, p.customers, p.mailboxes, p.raw_emails, p.pull_runs), (2, 1, 1, 1, 1));
    assert_eq!(p.ledger_entries, 2);
    // No backup folder set: the mandatory backup goes to <data dir>/pre-reset.
    let r = h.core.data_reset(all, "حذف").unwrap();
    assert!(r.backup.path.contains("pre-reset"));
    assert!(std::path::Path::new(&r.backup.path).exists());
    assert_eq!(h.core.txn_counts(&TxnFilter::default()).unwrap().all, 0);
    assert!(h.core.customers_list(None, None).unwrap().is_empty());
    assert!(h.core.mailbox_list().unwrap().is_empty());
    assert!(h.secrets.get(&mailbox_key(1)).unwrap().is_none(), "password removed from the credential store");
    let s = h.core.get_settings().unwrap();
    assert_eq!(s.default_commission_bps, 2500, "settings back to defaults");
    assert!(h.core.app_status().unwrap().lock_enabled, "the lock stays");
    assert!(audit_actions(&h).contains(&"data.reset".to_string()));
}

#[test]
fn reset_transactions_only_rewinds_the_mailbox_and_keeps_payouts() {
    let h = seeded();
    let scope = ResetScope { transactions: true, ..Default::default() };
    let p = h.core.data_reset_preview(scope).unwrap();
    assert_eq!(p.ledger_entries, 1, "only the credit linked to a transaction");
    h.core.data_reset(scope, "حذف").unwrap();
    let mb = h.core.mailbox_list().unwrap().remove(0);
    assert_eq!((mb.last_uid, mb.last_pulled_at), (0, None));
    let c = h.core.customers_list(None, None).unwrap().remove(0);
    assert_eq!(c.balances[0].minor, -1000, "the payout stays");
    // Pulling again starts from the beginning.
    let (run, cancel) = h.core.pull_start(mb.id, None).unwrap();
    let r = h.core.pull_execute(run.id, &cancel, &|_| {});
    assert_eq!(r.new_transactions_count, 1);
}

#[test]
fn reset_customers_only_unassigns_transactions() {
    let h = seeded();
    let scope = ResetScope { customers: true, ..Default::default() };
    assert!(h.core.data_reset_preview(scope).unwrap().notes.iter().any(|n| n.contains("غير مخصّصة")));
    h.core.data_reset(scope, "حذف").unwrap();
    assert!(h.core.customers_list(None, None).unwrap().is_empty());
    let counts = h.core.txn_counts(&TxnFilter::default()).unwrap();
    assert_eq!((counts.all, counts.unassigned), (2, 2));
}

#[test]
fn reset_mailboxes_only_detaches_transactions() {
    let h = seeded();
    h.core.data_reset(ResetScope { mailboxes: true, ..Default::default() }, "حذف").unwrap();
    assert!(h.core.mailbox_list().unwrap().is_empty());
    let items = h.core.txn_list(&TxnFilter::default(), Default::default(), 1, 5).unwrap().items;
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|t| t.mailbox.is_none() && t.raw_email_id.is_none()));
}

#[test]
fn approved_fee_untouched_by_delete_preview() {
    // The preview never changes anything.
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100", None);
    h.core.txn_set_fee(t.id, FeeInput::Zero).unwrap();
    h.core.txn_assign(t.id, c.id, None, true).unwrap();
    h.core.txn_delete_preview(&[t.id]).unwrap();
    h.core.customer_delete_preview(c.id).unwrap();
    assert_eq!(h.balance(c.id, "USD"), 7500);
}
