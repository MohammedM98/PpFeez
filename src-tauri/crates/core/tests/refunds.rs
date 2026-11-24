mod common;

use common::{code, fixture, harness};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::ledger::LedgerType;
use ppfeez_core::mail::mailboxes::MailboxInput;
use ppfeez_core::refunds::suggested_reversal;
use ppfeez_core::transactions::{FeeInput, TxnFilter, TxnStatus, TxnType};

fn pull(h: &common::Harness, files: &[&str]) -> i64 {
    let mb = h
        .core
        .mailbox_create(MailboxInput {
            label: "PayPal".into(),
            email: "owner@example.com".into(),
            host: None,
            port: None,
            folder: None,
            password: Some("pass".into()),
        })
        .unwrap();
    {
        let mut s = h.mail.0.lock().unwrap();
        for (i, f) in files.iter().enumerate() {
            s.messages.insert(100 + i as u32, fixture(f));
        }
    }
    let (run, cancel) = h.core.pull_start(mb.id, None).unwrap();
    h.core.pull_execute(run.id, &cancel, &|_| {});
    mb.id
}

fn find(h: &common::Harness, kind: TxnType) -> ppfeez_core::transactions::Transaction {
    let f = TxnFilter { kind: Some(kind), ..Default::default() };
    h.core.txn_list(&f, Default::default(), 1, 10).unwrap().items.remove(0)
}

#[test]
fn suggested_amounts() {
    assert_eq!(suggested_reversal(10000, 10000, 7125), -7125);
    assert_eq!(suggested_reversal(12000, 10000, 7125), -7125);
    // 40.00 of 100.00 → 40% of 71.25 = 28.50
    assert_eq!(suggested_reversal(4000, 10000, 7125), -2850);
    // half-up: 1/3 of 1.00 → 0.33; 1/2 of 0.01 → 0.01
    assert_eq!(suggested_reversal(1, 3, 100), -33);
    assert_eq!(suggested_reversal(1, 2, 1), -1);
}

#[test]
fn refund_before_approval_only_flags_the_original() {
    let h = harness();
    pull(&h, &["payment_received_basic.eml", "refund_sent_partial.eml"]);
    let refund = find(&h, TxnType::Refund);
    assert_eq!(refund.related_txn_id.as_deref(), Some("9AB12345CD6789012"));
    assert_eq!(refund.status, TxnStatus::Unassigned);
    assert!(!refund.allowed_actions.contains(&ppfeez_core::transactions::TxnAction::Assign));
    let original = find(&h, TxnType::Payment);
    assert_eq!(original.refunded_by.len(), 1);
    assert_eq!(original.refunded_by[0].gross_minor, 4000);
    assert!(h.core.refund_alerts().unwrap().is_empty(), "no alert while the original is not approved");
    let c = h.customer("Ali", 2500);
    assert_eq!(code(h.core.txn_assign(refund.id, c.id, None, false)), ErrorCode::InvalidTransition);
    assert_eq!(code(h.core.refund_confirm_reversal(refund.id, None)), ErrorCode::InvalidTransition);
    h.core.refund_dismiss(refund.id).unwrap();
    assert_eq!(h.core.txn_get(refund.id).unwrap().status, TxnStatus::Excluded);
}

#[test]
fn partial_refund_after_approval() {
    let h = harness();
    pull(&h, &["payment_received_basic.eml", "refund_sent_partial.eml"]);
    let c = h.customer("Ali", 2500);
    let original = find(&h, TxnType::Payment);
    h.core.txn_set_fee(original.id, FeeInput::Fee { fee_text: "5".into() }).unwrap();
    h.core.txn_assign(original.id, c.id, None, true).unwrap();
    assert_eq!(h.balance(c.id, "USD"), 7125);

    let alerts = h.core.refund_alerts().unwrap();
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].suggested_reversal_minor, -2850);
    assert_eq!(alerts[0].customer.id, c.id);
    assert_eq!(h.core.dashboard_summary(&Default::default()).unwrap().counts.refund_alerts, 1);

    let refund_id = alerts[0].refund_txn.id;
    let e = h.core.refund_confirm_reversal(refund_id, None).unwrap();
    assert_eq!((e.kind, e.amount_minor), (LedgerType::Reversal, -2850));
    assert_eq!(h.balance(c.id, "USD"), 7125 - 2850);
    assert_eq!(h.core.txn_get(refund_id).unwrap().status, TxnStatus::Excluded);
    assert!(h.core.refund_alerts().unwrap().is_empty());
    assert_eq!(code(h.core.refund_confirm_reversal(refund_id, None)), ErrorCode::InvalidTransition, "once only");
}

#[test]
fn full_reversal_with_edited_amount() {
    let h = harness();
    pull(&h, &["payment_received_basic.eml", "reversal_chargeback.eml"]);
    let c = h.customer("Ali", 2500);
    let original = find(&h, TxnType::Payment);
    h.core.txn_set_fee(original.id, FeeInput::Zero).unwrap();
    h.core.txn_assign(original.id, c.id, None, true).unwrap();
    let alerts = h.core.refund_alerts().unwrap();
    assert_eq!(alerts[0].suggested_reversal_minor, -7500, "full reversal = whole customer share");
    assert_eq!(alerts[0].refund_txn.kind, TxnType::Reversal);
    // The owner edits the amount before confirming (positive magnitude accepted).
    let e = h.core.refund_confirm_reversal(alerts[0].refund_txn.id, Some("70.00")).unwrap();
    assert_eq!(e.amount_minor, -7000);
    assert_eq!(h.balance(c.id, "USD"), 500);
}
