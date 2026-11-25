//! SPEC §4.9: standalone payouts are numbered with the customer's payouts and listed in the
//! payout register with the cumulative amount paid.

mod common;

use calamine::{open_workbook, Data, Reader, Xlsx};
use common::{harness, open_in, Harness};
use ppfeez_core::excel::statement as stmt;
use ppfeez_core::ledger::{PayoutInput, PayoutMethod};
use ppfeez_core::payouts::{
    CreateStatus, PayoutCreateInput, PayoutDetails, PayoutKind, PayoutStatus, StatementFilter, StatementRow,
    StatementShow,
};
use rusqlite::{params, Connection};

fn payout(h: &Harness, customer: i64, amount: &str, platform: &str, description: Option<&str>) -> i64 {
    h.core
        .ledger_add_payout(
            customer,
            PayoutInput {
                currency: "USD".into(),
                amount_text: amount.into(),
                entry_date: "2026-11-23".into(),
                method: PayoutMethod::Usdt,
                platform: Some(platform.into()),
                network: Some("TRC20".into()),
                destination: Some("TQ-wallet".into()),
                reference: Some("0xabc".into()),
                description: description.map(str::to_string),
                confirm_overdraw: Some(true),
            },
        )
        .unwrap()
        .id
}

fn approve(h: &Harness, customer: i64, gross: &str) -> i64 {
    let t = h.manual("USD", gross, Some("0"));
    h.core.txn_assign(t.id, customer, None, true).unwrap().id
}

fn linked(h: &Harness, customer: i64, txns: Vec<i64>) -> i64 {
    h.core
        .payout_create(
            customer,
            PayoutCreateInput {
                currency: "USD".into(),
                txn_ids: txns,
                returned_entry_ids: vec![],
                amount_text: None,
                difference_reason: None,
                date: "2026-11-22".into(),
                details: PayoutDetails {
                    method: PayoutMethod::Bank,
                    platform: Some("بنك".into()),
                    network: None,
                    destination: None,
                    reference: Some("TRX-1".into()),
                    note: Some("قديمة".into()),
                },
                status: CreateStatus::Sent,
                matched_confirmed: true,
            },
        )
        .unwrap()
        .id
}

#[test]
fn standalone_payouts_are_numbered_and_listed_with_the_cumulative() {
    let h = harness();
    let c = h.customer("Ali", 2500).id;
    let t = approve(&h, c, "100"); // 75.00
    approve(&h, c, "200"); // 150.00
    let p1 = linked(&h, c, vec![t]); // دفعة 1 (linked, 75.00)
    let e2 = payout(&h, c, "50", "Binance", None);
    let e3 = payout(&h, c, "30", "OKX", Some("دفعة نهاية الشهر"));
    let e4 = payout(&h, c, "10", "Binance", None);
    h.core.ledger_reverse_entry(e4, "خطأ").unwrap();

    let reg = h.core.payout_register(c, "USD").unwrap();
    let seqs: Vec<i64> = reg.iter().map(|r| r.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4], "one numbering for linked and standalone payouts");
    assert_eq!(
        (reg[0].kind, reg[0].payout_id, reg[0].range_label.as_deref()),
        (PayoutKind::Linked, Some(p1), Some("(1)"))
    );
    assert_eq!((reg[1].kind, reg[1].ledger_entry_id, reg[1].payout_id), (PayoutKind::Standalone, Some(e2), None));
    assert_eq!(reg[1].amount_minor, 5000);
    assert_eq!(
        (
            reg[1].platform.as_deref(),
            reg[1].network.as_deref(),
            reg[1].destination.as_deref(),
            reg[1].reference.as_deref()
        ),
        (Some("Binance"), Some("TRC20"), Some("TQ-wallet"), Some("0xabc"))
    );
    assert_eq!(reg[1].note, None, "the automatic description is not a note");
    assert_eq!(reg[2].note.as_deref(), Some("دفعة نهاية الشهر"));
    assert_eq!(reg[3].status, PayoutStatus::Cancelled, "a reversed standalone payout is cancelled");
    let cum: Vec<i64> = reg.iter().map(|r| r.cumulative_paid_minor).collect();
    assert_eq!(cum, vec![7500, 12500, 15500, 15500]);
    let _ = e3;

    // The next linked payout continues the numbering after the standalone ones.
    let t2 = approve(&h, c, "40");
    let p5 = linked(&h, c, vec![t2]);
    assert_eq!(h.core.payouts_list(c, "USD").unwrap().iter().find(|p| p.id == p5).unwrap().seq, 5);

    // Entries carry their number; the last details are the customer's defaults.
    let entries = h.core.ledger_entries(c, "USD", None).unwrap().entries;
    assert_eq!(entries.iter().find(|e| e.id == e2).unwrap().payout_seq, Some(2));
    let linked_entry = entries.iter().find(|e| e.payout_id == Some(p1)).unwrap();
    assert_eq!(linked_entry.payout_seq, Some(1));
    assert!(entries.iter().filter(|e| e.transaction_id.is_some()).all(|e| e.payout_seq.is_none()));
    let d = h.core.payout_defaults(c).unwrap().unwrap();
    assert_eq!((d.method, d.platform.as_deref()), (PayoutMethod::Bank, Some("بنك")), "the linked payout was last");
    payout(&h, c, "1", "Kraken", None);
    let d = h.core.payout_defaults(c).unwrap().unwrap();
    assert_eq!(
        (d.method, d.platform.as_deref(), d.network.as_deref(), d.destination.as_deref()),
        (PayoutMethod::Usdt, Some("Kraken"), Some("TRC20"), Some("TQ-wallet"))
    );
    assert!(h.core.payout_platform_suggestions().unwrap().contains(&"Kraken".to_string()));
    // Another currency has its own numbering.
    assert!(h.core.payout_register(c, "EUR").unwrap().is_empty());
}

#[test]
fn the_statement_filter_shows_transfers_only() {
    let h = harness();
    let c = h.customer("Ali", 2500).id;
    approve(&h, c, "100");
    payout(&h, c, "10", "Binance", None);
    let f = StatementFilter { show: Some(StatementShow::Transfers), ..Default::default() };
    let rows = h.core.customer_statement(c, "USD", &f).unwrap().rows;
    assert_eq!(rows.len(), 1);
    assert!(matches!(rows[0], StatementRow::Txn { .. }));
}

#[test]
fn a_standalone_payout_row_in_the_customer_file_shows_its_number() {
    let h = harness();
    let c = h.customer("Ali", 2500).id;
    let path = h.dir.path().join("ali.xlsx");
    h.core.customer_excel_create(c, &path.display().to_string(), false).unwrap();
    approve(&h, c, "100");
    let e = payout(&h, c, "10", "Binance", None);
    h.core.customer_excel_sync_due();
    let mut wb: Xlsx<_> = open_workbook(&path).unwrap();
    let rows: Vec<Vec<Data>> = wb.worksheet_range("كشف USD").unwrap().rows().map(|r| r.to_vec()).collect();
    let row = rows
        .iter()
        .find(|r| matches!(r.get(stmt::C_KEY as usize), Some(Data::String(k)) if *k == format!("U:{e}")))
        .unwrap();
    assert_eq!(row[stmt::C_SEQ as usize], Data::String("دفعة 1".into()));
}

/// A 0.6.0 database (schema 9): its standalone payouts are numbered after the linked ones.
#[test]
fn upgrade_numbers_existing_standalone_payouts() {
    const V9: [&str; 9] = [
        include_str!("../src/db/migrations/0001_init.sql"),
        include_str!("../src/db/migrations/0002_pull_range.sql"),
        include_str!("../src/db/migrations/0003_review_hold.sql"),
        include_str!("../src/db/migrations/0004_ledger_delete_flow.sql"),
        include_str!("../src/db/migrations/0005_excel_exported.sql"),
        include_str!("../src/db/migrations/0006_payouts.sql"),
        include_str!("../src/db/migrations/0007_customer_excel.sql"),
        include_str!("../src/db/migrations/0008_excel_sync.sql"),
        include_str!("../src/db/migrations/0009_excel_files.sql"),
    ];
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    {
        let conn = Connection::open(dir.path().join("data").join("ppfeez.db")).unwrap();
        for sql in V9 {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 9).unwrap();
        let now = "2026-11-20T10:00:00Z";
        conn.execute(
            "INSERT INTO customers (id, name, default_commission_bps, created_at, updated_at) VALUES (1, 'Owner Test', 2500, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payouts (id, customer_id, currency, payout_seq, status, amount_minor, due_minor, method,
               range_label, payout_date, created_at, updated_at)
             VALUES (1, 1, 'USD', 2, 'cancelled', 1000, 1000, 'bank', '', '2026-11-01', ?1, ?1)",
            params![now],
        )
        .unwrap();
        // Two standalone payouts (later one first by id) and an EUR one.
        for (id, cur, date) in [(10, "USD", "2026-11-12"), (11, "USD", "2026-11-10"), (12, "EUR", "2026-11-11")] {
            conn.execute(
                "INSERT INTO ledger_entries (id, customer_id, currency, type, amount_minor, payout_method, description,
                 entry_date, created_at) VALUES (?1, 1, ?2, 'payout', -500, 'usdt', 'دفعة للعميل — USDT', ?3, ?4)",
                params![id, cur, date, now],
            )
            .unwrap();
        }
    }
    let h = open_in(dir);
    let usd: Vec<(i64, Option<i64>)> =
        h.core.payout_register(1, "USD").unwrap().iter().map(|r| (r.seq, r.ledger_entry_id)).collect();
    assert_eq!(usd, vec![(2, None), (3, Some(11)), (4, Some(10))], "after the linked #2, in date order");
    assert_eq!(h.core.payout_register(1, "EUR").unwrap()[0].seq, 1);
}
