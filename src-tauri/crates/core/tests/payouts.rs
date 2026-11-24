//! SPEC §4.8 / §6.5: numbered transfers, linked payouts, the eight figures and the statement.
//!
//! Hand-computed example (commission 25%):
//!   #1 100.00 fee 5 → net 95.00, commission 23.75, customer 71.25
//!   #2  50.00 fee 2 → net 48.00, commission 12.00, customer 36.00
//!   #3  20.00 fee 0 → net 20.00, commission  5.00, customer 15.00
//!   #4  10.00 fee 0 → unapproved (gap), approved again as #6: customer 7.50
//!   #5  30.00 fee 1 → net 29.00, commission 7.25, customer 21.75, then put on hold
//!   a refund of #1 confirmed as a 5.00 return

mod common;

use common::{code, harness};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::ledger::PayoutMethod;
use ppfeez_core::payouts::{
    range_label, CreateStatus, PayoutCreateInput, PayoutDetails, PayoutSelection, PayoutStatus, StatementFilter,
    StatementRow, StatementShow,
};
use ppfeez_core::transactions::{Transaction, TxnAction};
use rusqlite::{params, Connection};
use serde_json::json;

struct Setup {
    h: common::Harness,
    cid: i64,
    t: Vec<Transaction>,
    ret: i64,
}

fn approved(h: &common::Harness, cid: i64, gross: &str, fee: &str) -> Transaction {
    let t = h.manual("USD", gross, Some(fee));
    h.core.txn_assign(t.id, cid, None, true).unwrap()
}

fn setup() -> Setup {
    let h = harness();
    let c = h.customer("سامر", 2500);
    let t1 = approved(&h, c.id, "100", "5");
    let t2 = approved(&h, c.id, "50", "2");
    let t3 = approved(&h, c.id, "20", "0");
    let t4 = approved(&h, c.id, "10", "0");
    let t5 = approved(&h, c.id, "30", "1");
    assert_eq!([&t1, &t2, &t3, &t4, &t5].map(|t| t.customer_seq), [Some(1), Some(2), Some(3), Some(4), Some(5)]);
    // #4: unapprove leaves a gap, approving again gives a new number.
    let back = h.core.txn_unapprove(t4.id, "خطأ").unwrap();
    assert_eq!(back.customer_seq, None);
    h.core.txn_assign(t4.id, c.id, None, true).unwrap();
    let t4 = h.core.txn_get(t4.id).unwrap();
    assert_eq!(t4.customer_seq, Some(6), "numbers are never reused");
    // #5 on hold at PayPal.
    let conn = Connection::open(h.core.db_path()).unwrap();
    conn.execute("UPDATE paypal_transactions SET hold_status = 'on_hold' WHERE id = ?1", params![t5.id]).unwrap();
    // A refund of #1, confirmed as a 5.00 return.
    conn.execute(
        "INSERT INTO paypal_transactions (source, paypal_txn_id, related_txn_id, type, currency, gross_minor, occurred_at,
         status, created_at, updated_at) VALUES ('manual', 'REFUND-1', ?1, 'refund', 'USD', 1000, '2026-11-21T10:00:00Z',
         'unassigned', '2026-11-21T10:00:00Z', '2026-11-21T10:00:00Z')",
        params![t1.paypal_txn_id],
    )
    .unwrap();
    let refund_id = conn.last_insert_rowid();
    drop(conn);
    let ret = h.core.refund_confirm_reversal(refund_id, Some("5")).unwrap();
    assert_eq!(ret.amount_minor, -500);
    let t: Vec<Transaction> =
        [t1.id, t2.id, t3.id, t4.id, t5.id].iter().map(|id| h.core.txn_get(*id).unwrap()).collect();
    Setup { h, cid: c.id, t, ret: ret.id }
}

fn details() -> PayoutDetails {
    PayoutDetails {
        method: PayoutMethod::Usdt,
        platform: Some("Binance".into()),
        network: Some("TRC20".into()),
        destination: Some("TXyz-wallet".into()),
        reference: Some("0xabc".into()),
        note: None,
    }
}

fn input(txns: &[i64], returns: &[i64], status: CreateStatus) -> PayoutCreateInput {
    PayoutCreateInput {
        currency: "USD".into(),
        txn_ids: txns.to_vec(),
        returned_entry_ids: returns.to_vec(),
        amount_text: None,
        difference_reason: None,
        date: "2026-11-24".into(),
        details: details(),
        status,
        matched_confirmed: true,
    }
}

#[test]
fn range_labels() {
    assert_eq!(range_label(&[13, 14, 15, 16]), "(13-16)");
    assert_eq!(range_label(&[99, 100, 101, 103, 105]), "(99-105) بدون 102، 104");
    assert_eq!(range_label(&[7]), "(7)");
    assert_eq!(range_label(&[]), "");
}

#[test]
fn prepare_by_range_matches_the_sheet() {
    let s = setup();
    let p = s.h.core.payout_prepare(s.cid, "USD", &PayoutSelection::Range { from: 1, to: 5 }).unwrap();
    assert_eq!(p.missing_seqs, vec![4], "unapproved number");
    assert_eq!(p.found_count, 4);
    assert_eq!(p.excluded_held.iter().map(|t| t.customer_seq).collect::<Vec<_>>(), vec![Some(5)]);
    assert_eq!(p.counted_count, 3);
    assert_eq!(p.returned_count, 1);
    assert_eq!((p.gross_minor, p.net_paypal_minor, p.commission_minor), (17000, 16300, 4075));
    assert_eq!(p.due_minor, 7125 + 3600 + 1500 - 500);
    assert_eq!(p.range_label, "(1-3)");
    // Manual selection with a hole.
    let ids = PayoutSelection::Ids { txn_ids: vec![s.t[0].id, s.t[2].id] };
    assert_eq!(s.h.core.payout_prepare(s.cid, "USD", &ids).unwrap().range_label, "(1-3) بدون 2");
    // All unpaid: #1 #2 #3 #6 (and #5 held).
    let all = s.h.core.payout_prepare(s.cid, "USD", &PayoutSelection::Unpaid).unwrap();
    assert_eq!(all.counted_count, 4);
    assert_eq!(all.range_label, "(1-6) بدون 4، 5");
    let sel: PayoutSelection = serde_json::from_value(json!({ "kind": "range", "from": 2, "to": 3 })).unwrap();
    assert_eq!(s.h.core.payout_prepare(s.cid, "USD", &sel).unwrap().counted_count, 2);
}

#[test]
fn sent_payout_summary_and_overlap() {
    let s = setup();
    let ids = [s.t[0].id, s.t[1].id, s.t[2].id];
    let p = s.h.core.payout_create(s.cid, input(&ids, &[s.ret], CreateStatus::Sent)).unwrap();
    assert_eq!((p.seq, p.status, p.amount_minor, p.due_minor), (1, PayoutStatus::Sent, 11725, 11725));
    assert_eq!(p.range_label, "(1-3)");
    assert_eq!(p.txn_count, 3);
    assert_eq!(p.cumulative_paid_minor, 11725);
    let entry = s.h.core.ledger_entries(s.cid, "USD", None).unwrap().entries.into_iter().last().unwrap();
    assert_eq!(entry.amount_minor, -11725);
    assert_eq!(entry.payout_method, Some(PayoutMethod::Usdt));
    assert!(entry.description.contains("دفعة 1") && entry.description.contains("Binance"));
    assert!(!entry.deletable, "{:?}", entry.not_deletable_reason_ar);
    assert_eq!(s.h.balance(s.cid, "USD"), 15150 - 500 - 11725);

    // The eight figures.
    let sum = s.h.core.customer_summary(s.cid, "USD").unwrap();
    assert_eq!(sum.net_completed_minor, 12975 - 500);
    assert_eq!(sum.sent_minor, 11725);
    assert_eq!(sum.remaining_minor, 2925);
    assert_eq!(sum.not_paid_count, 1);
    assert_eq!(sum.gross_before_commission_minor, 17300);
    assert_eq!(sum.commission_minor, 4325);
    assert_eq!((sum.txn_count, sum.paid_count), (4, 3));

    // Paid transfers: no second payout, no unapprove, no delete.
    let t1 = s.h.core.txn_get(s.t[0].id).unwrap();
    assert_eq!(t1.payout.as_ref().map(|p| (p.seq, p.status.as_str())), Some((1, "sent")));
    assert!(!t1.allowed_actions.contains(&TxnAction::Unapprove));
    assert!(t1.allowed_actions.contains(&TxnAction::SetMatched));
    let err = s.h.core.payout_create(s.cid, input(&[s.t[0].id, s.t[3].id], &[], CreateStatus::Sent)).unwrap_err();
    assert_eq!((err.code, err.field.as_deref()), (ErrorCode::Validation, Some("overlap")));
    assert!(err.message_ar.contains("#1"), "{}", err.message_ar);
    assert_eq!(code(s.h.core.txn_unapprove(s.t[0].id, "x")), ErrorCode::InvalidTransition);
    let del = s.h.core.txn_delete(&[s.t[0].id], None).unwrap();
    assert_eq!(del.result.failed[0].code, ErrorCode::NotDeletable);
    assert_eq!(code(s.h.core.ledger_delete_entry(entry.id, None)), ErrorCode::NotDeletable);
    let prep = s.h.core.payout_prepare(s.cid, "USD", &PayoutSelection::Range { from: 1, to: 6 }).unwrap();
    assert_eq!(prep.already_paid.iter().map(|a| a.payout_seq).collect::<Vec<_>>(), vec![1, 1, 1]);
    assert_eq!(prep.returned_count, 0, "the return is settled");
}

#[test]
fn draft_then_sent_then_cancelled() {
    let s = setup();
    let before = s.h.balance(s.cid, "USD");
    let p = s.h.core.payout_create(s.cid, input(&[s.t[3].id], &[], CreateStatus::Draft)).unwrap();
    assert_eq!((p.status, p.ledger_entry_id), (PayoutStatus::Draft, None));
    assert_eq!(s.h.balance(s.cid, "USD"), before, "a draft does not touch the balance");
    let t = s.h.core.txn_get(s.t[3].id).unwrap();
    assert_eq!(t.payout.as_ref().map(|p| p.status.as_str()), Some("draft"));
    let sum = s.h.core.customer_summary(s.cid, "USD").unwrap();
    assert_eq!((sum.not_paid_count, sum.paid_count), (4, 0), "a draft only reserves: still not paid");
    assert_eq!(sum.not_paid_count + sum.paid_count, sum.txn_count);
    assert_eq!(code(s.h.core.txn_unapprove(s.t[3].id, "x")), ErrorCode::InvalidTransition);

    let p = s.h.core.payout_mark_sent(p.id, Some("2026-11-25")).unwrap();
    assert_eq!((p.status, p.date.as_str()), (PayoutStatus::Sent, "2026-11-25"));
    assert_eq!(s.h.balance(s.cid, "USD"), before - 750);
    assert_eq!(code(s.h.core.payout_mark_sent(p.id, None)), ErrorCode::InvalidTransition);

    let p = s.h.core.payout_update_details(p.id, PayoutDetails { method: PayoutMethod::Bank, ..details() }).unwrap();
    assert_eq!(p.details.method, PayoutMethod::Bank);
    assert_eq!(s.h.core.payout_defaults(s.cid).unwrap().unwrap().method, PayoutMethod::Bank);
    assert_eq!(s.h.core.payout_platform_suggestions().unwrap(), vec!["Binance".to_string()]);

    assert_eq!(code(s.h.core.payout_cancel(p.id, " ")), ErrorCode::Validation);
    let p = s.h.core.payout_cancel(p.id, "أُعيدت").unwrap();
    assert_eq!(p.status, PayoutStatus::Cancelled);
    assert_eq!(s.h.balance(s.cid, "USD"), before, "the entry is reversed");
    assert!(s.h.core.txn_get(s.t[3].id).unwrap().payout.is_none(), "unpaid again");
    let again = s.h.core.payout_create(s.cid, input(&[s.t[3].id], &[], CreateStatus::Sent)).unwrap();
    assert_eq!(again.seq, 2, "payout numbers continue after a cancelled one");
    let list = s.h.core.payouts_list(s.cid, "USD").unwrap();
    assert_eq!(
        list.iter().map(|p| (p.seq, p.status)).collect::<Vec<_>>(),
        vec![(1, PayoutStatus::Cancelled), (2, PayoutStatus::Sent)]
    );
    assert_eq!(list[1].cumulative_paid_minor, 750);
}

#[test]
fn amount_differences_need_a_reason_and_stay_in_the_balance() {
    let s = setup();
    let mut i = input(&[s.t[1].id], &[], CreateStatus::Sent);
    i.amount_text = Some("30".into());
    let err = s.h.core.payout_create(s.cid, i.clone()).unwrap_err();
    assert_eq!(err.field.as_deref(), Some("difference_reason"));
    i.difference_reason = Some("الباقي الأسبوع القادم".into());
    let before = s.h.balance(s.cid, "USD");
    let p = s.h.core.payout_create(s.cid, i).unwrap();
    assert_eq!((p.amount_minor, p.due_minor), (3000, 3600));
    assert_eq!(s.h.balance(s.cid, "USD"), before - 3000, "600 stays owed");

    let mut i = input(&[s.t[2].id], &[], CreateStatus::Sent);
    i.matched_confirmed = false;
    assert_eq!(s.h.core.payout_create(s.cid, i).unwrap_err().field.as_deref(), Some("matched"));
    let held = s.h.core.payout_create(s.cid, input(&[s.t[4].id], &[], CreateStatus::Sent)).unwrap_err();
    assert_eq!(held.code, ErrorCode::InvalidTransition, "held transfers are not paid");
    assert_eq!(code(s.h.core.payout_create(s.cid, input(&[], &[], CreateStatus::Sent))), ErrorCode::Validation);
}

#[test]
fn statement_rows_balances_and_filters() {
    let s = setup();
    s.h.core.payout_create(s.cid, input(&[s.t[0].id, s.t[1].id], &[], CreateStatus::Sent)).unwrap();
    s.h.core.payout_create(s.cid, input(&[s.t[2].id], &[], CreateStatus::Draft)).unwrap();
    let st = s.h.core.customer_statement(s.cid, "USD", &StatementFilter::default()).unwrap();
    assert_eq!(st.closing_balance_minor, s.h.balance(s.cid, "USD"));
    let kinds: Vec<&str> = st
        .rows
        .iter()
        .map(|r| match r {
            StatementRow::Txn { .. } => "txn",
            StatementRow::Payout { .. } => "payout",
            StatementRow::Entry { .. } => "entry",
        })
        .collect();
    // 5 approvals (#4's first credit and its reversal become entries), the return, payout 1, draft 2.
    assert_eq!(kinds.iter().filter(|k| **k == "txn").count(), 5);
    assert_eq!(kinds.iter().filter(|k| **k == "payout").count(), 2);
    assert_eq!(kinds.iter().filter(|k| **k == "entry").count(), 3);
    let last_balance = match st.rows.last().unwrap() {
        StatementRow::Txn { running_balance_minor, .. }
        | StatementRow::Payout { running_balance_minor, .. }
        | StatementRow::Entry { running_balance_minor, .. } => *running_balance_minor,
    };
    assert_eq!(last_balance, st.closing_balance_minor);

    let only = |show| {
        s.h.core
            .customer_statement(s.cid, "USD", &StatementFilter { show: Some(show), period: None })
            .unwrap()
            .rows
            .len()
    };
    assert_eq!(only(StatementShow::Unpaid), 2, "#6 and the held #5");
    assert_eq!(only(StatementShow::Paid), 2);
    assert_eq!(only(StatementShow::Payouts), 2);

    let v = serde_json::to_value(&st.rows[0]).unwrap();
    assert_eq!(v["kind"], "txn");
    assert!(v.get("runningBalanceMinor").is_some() && v["txn"]["customerSeq"] == 1);
    let f: StatementFilter = serde_json::from_value(json!({ "show": "payouts" })).unwrap();
    assert_eq!(f.show, Some(StatementShow::Payouts));

    let r = s.h.core.txn_set_matched(&[s.t[0].id, s.t[3].id], true).unwrap();
    assert_eq!(r.ok.len(), 2);
    assert!(s.h.core.txn_get(s.t[0].id).unwrap().matched);
    let pending = s.h.manual("USD", "5", Some("0"));
    assert_eq!(s.h.core.txn_set_matched(&[pending.id], true).unwrap().failed.len(), 1);
}

#[test]
fn customer_delete_removes_payouts() {
    let s = setup();
    s.h.core.payout_create(s.cid, input(&[s.t[0].id], &[], CreateStatus::Sent)).unwrap();
    let name = s.h.core.customer_get(s.cid).unwrap().name;
    s.h.core.customer_delete(s.cid, &name).unwrap();
    let conn = Connection::open(s.h.core.db_path()).unwrap();
    for table in ["payouts", "payout_items", "customer_seq_counters", "customer_payout_defaults"] {
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{table}");
    }
    let t = s.h.core.txn_get(s.t[0].id).unwrap();
    assert_eq!((t.customer_seq, t.payout.is_none()), (None, true));
}
