//! SPEC §6.3: the transactions screen is an inbox; assigned rows live on the customer page.

mod common;

use common::harness;
use ppfeez_core::transactions::{StatusFilter, TxnFilter, TxnStatus};
use rusqlite::Connection;
use serde_json::json;

fn inbox(h: &common::Harness) -> Vec<i64> {
    let f = TxnFilter { status: Some(StatusFilter::Status(TxnStatus::Unassigned)), ..Default::default() };
    h.core.txn_list(&f, Default::default(), 1, 50).unwrap().items.into_iter().map(|t| t.id).collect()
}

fn customer_rows(h: &common::Harness, customer: i64, status: TxnStatus) -> Vec<i64> {
    let f = TxnFilter { status: Some(StatusFilter::Status(status)), customer_id: Some(customer), ..Default::default() };
    h.core.txn_list(&f, Default::default(), 1, 50).unwrap().items.into_iter().map(|t| t.id).collect()
}

#[test]
fn assigning_moves_a_row_from_the_inbox_to_the_customer_and_back() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100", Some("5"));
    assert_eq!(inbox(&h), vec![t.id]);
    h.core.txn_assign(t.id, c.id, None, false).unwrap();
    assert!(inbox(&h).is_empty());
    assert_eq!(customer_rows(&h, c.id, TxnStatus::PendingApproval), vec![t.id]);
    h.core.txn_approve(t.id).unwrap();
    assert_eq!(customer_rows(&h, c.id, TxnStatus::Approved), vec![t.id]);
    h.core.txn_unapprove(t.id, "x").unwrap();
    assert_eq!(inbox(&h), vec![t.id], "unapprove returns it to the inbox");
    h.core.txn_assign(t.id, c.id, None, false).unwrap();
    h.core.txn_unassign(t.id).unwrap();
    assert_eq!(inbox(&h), vec![t.id], "unassign returns it to the inbox");
}

#[test]
fn search_all_finds_every_status_and_its_location() {
    let h = harness();
    let c = h.customer("سارة", 2500);
    let a = h.manual("USD", "100.00", Some("5")); // customer amount 71.25 once assigned
    h.core.txn_assign(a.id, c.id, None, true).unwrap();
    let p = h.manual("EUR", "50,00", Some("0"));
    h.core.txn_assign(p.id, c.id, None, false).unwrap();
    let x = h.manual("USD", "12.34", None);
    h.core.txn_set_excluded(x.id, true).unwrap();
    let j = h.manual("JPY", "5000", None);
    let free = h.manual("USD", "71.30", None);

    let hits = h.core.txn_search_all("71.25", None).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].txn.id, a.id);
    assert_eq!(
        serde_json::to_value(&hits[0].location).unwrap(),
        json!({ "kind": "customer", "customerId": c.id, "customerName": "سارة", "status": "approved" })
    );
    let loc = |q: &str| serde_json::to_value(&h.core.txn_search_all(q, None).unwrap()[0].location).unwrap();
    assert_eq!(loc("50.00")["status"], json!("pending_approval"));
    assert_eq!(loc("12.34"), json!({ "kind": "excluded" }));
    assert_eq!(loc("71.30"), json!({ "kind": "inbox" }));
    assert_eq!(h.core.txn_search_all("5,000", None).unwrap()[0].txn.id, j.id, "0-decimal currency");
    // Text: payer name, email, PayPal id.
    assert_eq!(h.core.txn_search_all("john.doe@", None).unwrap().len(), 5);
    assert_eq!(h.core.txn_search_all(&free.paypal_txn_id[..12], None).unwrap()[0].txn.id, free.id);
    assert_eq!(h.core.txn_search_all("John", Some(2)).unwrap().len(), 2, "limit");
    assert!(h.core.txn_search_all("   ", None).unwrap().is_empty());
    assert!(h.core.txn_search_all("%", None).unwrap().is_empty(), "LIKE wildcards escaped");
}

#[test]
fn customers_with_pending_approvals() {
    let h = harness();
    let a = h.customer("A", 2500);
    let b = h.customer("B", 2500);
    let t = h.manual("USD", "10", None);
    h.core.txn_assign(t.id, a.id, None, false).unwrap();
    let ids = |p: Option<bool>| -> Vec<i64> {
        h.core.customers_list_filtered(None, None, p).unwrap().into_iter().map(|c| c.id).collect()
    };
    assert_eq!(ids(Some(true)), vec![a.id]);
    assert_eq!(ids(Some(false)), vec![b.id]);
    assert_eq!(ids(None).len(), 2);
}

#[test]
fn inbox_query_uses_the_status_index() {
    let h = harness();
    let conn = Connection::open(h.core.db_path()).unwrap();
    let plan: Vec<String> = conn
        .prepare(
            "EXPLAIN QUERY PLAN SELECT t.* FROM paypal_transactions t WHERE 1=1 AND t.status = ?
             ORDER BY t.occurred_at DESC, t.id DESC LIMIT 50",
        )
        .unwrap()
        .query_map(["unassigned"], |r| r.get::<_, String>(3))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(plan.iter().any(|p| p.contains("idx_txn_status")), "{plan:?}");
}
