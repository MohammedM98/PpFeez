//! 0.5.0 sanity: upgrading a 0.4.x database (schema 5) with approved transfers, then the whole
//! prepare → payout → customer Excel flow on it.

mod common;

use common::open_in;
use ppfeez_core::excel::customer::{ItemKind, ItemRef};
use ppfeez_core::ledger::PayoutMethod;
use ppfeez_core::payouts::{CreateStatus, PayoutCreateInput, PayoutDetails, PayoutSelection};
use rusqlite::{params, Connection};

const V5: [&str; 5] = [
    include_str!("../src/db/migrations/0001_init.sql"),
    include_str!("../src/db/migrations/0002_pull_range.sql"),
    include_str!("../src/db/migrations/0003_review_hold.sql"),
    include_str!("../src/db/migrations/0004_ledger_delete_flow.sql"),
    include_str!("../src/db/migrations/0005_excel_exported.sql"),
];

/// A 0.4.x database: customer "Owner Test" with three approved USD transfers (approved out of
/// id order) and one EUR transfer, each with its credit in the ledger.
fn v5_database(dir: &std::path::Path) {
    std::fs::create_dir_all(dir.join("data")).unwrap();
    let conn = Connection::open(dir.join("data").join("ppfeez.db")).unwrap();
    for sql in V5 {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 5).unwrap();
    let now = "2026-11-01T10:00:00Z";
    conn.execute(
        "INSERT INTO customers (id, name, default_commission_bps, created_at, updated_at) VALUES (1, 'Owner Test', 2500, ?1, ?1)",
        params![now],
    )
    .unwrap();
    // (id, currency, gross, fee, approved_at)
    let rows = [
        (1, "USD", 10000, 500, "2026-11-03T10:00:00Z"),
        (2, "USD", 2000, 0, "2026-11-02T10:00:00Z"),
        (3, "USD", 5000, 200, "2026-11-04T10:00:00Z"),
        (4, "EUR", 4000, 0, "2026-11-02T12:00:00Z"),
    ];
    for (id, cur, gross, fee, approved) in rows {
        let net = gross - fee;
        let commission = net / 4;
        let customer_amount = net - commission;
        conn.execute(
            "INSERT INTO paypal_transactions (id, source, paypal_txn_id, type, payer_name, currency, gross_minor, fee_minor,
             net_minor, fee_is_estimated, occurred_at, status, customer_id, commission_mode, commission_bps, commission_minor,
             customer_amount_minor, assigned_at, approved_at, created_at, updated_at)
             VALUES (?1, 'manual', ?2, 'payment', 'Payer', ?3, ?4, ?5, ?6, 0, ?7, 'approved', 1, 'percent', 2500, ?8, ?9, ?7, ?7, ?7, ?7)",
            params![id, format!("OLD{id:014}"), cur, gross, fee, net, approved, commission, customer_amount],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ledger_entries (customer_id, currency, type, amount_minor, paypal_transaction_id, description,
             entry_date, created_at) VALUES (1, ?1, 'credit', ?2, ?3, 'اعتماد', '2026-11-05', ?4)",
            params![cur, customer_amount, id, approved],
        )
        .unwrap();
    }
}

#[test]
fn upgrade_numbers_existing_transfers_then_prepare_pay_and_add_to_excel() {
    let dir = tempfile::tempdir().unwrap();
    v5_database(dir.path());
    let h = open_in(dir);
    let conn = Connection::open(h.core.db_path()).unwrap();
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(version, 8);
    drop(conn);

    // Numbered by approval order per currency: #2 approved first, then #1, then #3.
    let seq = |id: i64| h.core.txn_get(id).unwrap().customer_seq;
    assert_eq!([seq(2), seq(1), seq(3), seq(4)], [Some(1), Some(2), Some(3), Some(1)]);
    assert_eq!(h.balance(1, "USD"), 7125 + 1500 + 3600, "ledger untouched");
    // The next approval continues the numbering.
    let t = h.manual("USD", "10", Some("0"));
    let t = h.core.txn_assign(t.id, 1, None, true).unwrap();
    assert_eq!(t.customer_seq, Some(4));

    // Prepare everything unpaid, pay it, add the payout and its transfers to the statement.
    let prep = h.core.payout_prepare(1, "USD", &PayoutSelection::Unpaid).unwrap();
    assert_eq!((prep.counted_count, prep.range_label.as_str()), (4, "(1-4)"));
    assert_eq!(prep.due_minor, 7125 + 1500 + 3600 + 750);
    let payout = h
        .core
        .payout_create(
            1,
            PayoutCreateInput {
                currency: "USD".into(),
                txn_ids: prep.included.iter().map(|t| t.id).collect(),
                returned_entry_ids: prep.returned.iter().map(|e| e.id).collect(),
                amount_text: None,
                difference_reason: None,
                date: "2026-11-24".into(),
                details: PayoutDetails {
                    method: PayoutMethod::Usdt,
                    platform: Some("Binance".into()),
                    network: Some("TRC20".into()),
                    destination: None,
                    reference: Some("0xfeed".into()),
                    note: None,
                },
                status: CreateStatus::Sent,
                matched_confirmed: true,
            },
        )
        .unwrap();
    assert_eq!(h.balance(1, "USD"), 0);
    let sum = h.core.customer_summary(1, "USD").unwrap();
    assert_eq!((sum.paid_count, sum.not_paid_count, sum.remaining_minor), (4, 0, 0));

    let path = h.dir.path().join("Owner Test.xlsx");
    let created = h.core.customer_excel_create(1, &path.display().to_string(), true).unwrap();
    assert_eq!(created.sheets, vec!["كشف EUR".to_string(), "كشف USD".to_string()]);
    assert_eq!(created.added, 4 + 1 + 1, "4 USD transfers, the payout, 1 EUR transfer");
    let again = h
        .core
        .customer_excel_add(
            1,
            &[ItemRef { kind: ItemKind::Payout, id: payout.id }, ItemRef { kind: ItemKind::Txn, id: 2 }],
        )
        .unwrap();
    assert_eq!((again.added, again.skipped_duplicates), (0, 2));
    assert!(h.core.txn_get(1).unwrap().in_customer_excel);
    if let Ok(d) = std::env::var("DUMP_DIR") {
        std::fs::copy(&path, std::path::Path::new(&d).join("e2e.xlsx")).unwrap();
    }
}
