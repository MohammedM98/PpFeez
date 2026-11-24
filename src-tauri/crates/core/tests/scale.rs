//! SPEC §6.10: settings of the UI overhaul, and pages of up to 500 rows over 5,000+ transactions.

mod common;

use common::{code, harness};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::payouts::StatementFilter;
use ppfeez_core::settings::{Accent, Density, SettingsPatch, Theme};
use ppfeez_core::transactions::{StatusFilter, TxnFilter, TxnSort, TxnSortKey, TxnStatus};
use rusqlite::{params, Connection};
use std::time::Instant;

#[test]
fn ui_settings() {
    let h = harness();
    let s = h.core.get_settings().unwrap();
    assert_eq!((s.accent, s.density, s.ui_scale, s.ui_prefs.as_str()), (Accent::Blue, Density::Regular, 100, "{}"));
    let patch: SettingsPatch = serde_json::from_value(serde_json::json!({
        "theme": "high_contrast", "accent": "emerald", "density": "compact", "uiScale": 400,
        "uiPrefs": "{\"columns\":[\"date\"]}"
    }))
    .unwrap();
    let s = h.core.update_settings(patch).unwrap();
    assert_eq!(
        (s.theme, s.accent, s.density, s.ui_scale),
        (Theme::HighContrast, Accent::Emerald, Density::Compact, 150)
    );
    assert_eq!(s.ui_prefs, "{\"columns\":[\"date\"]}");
    let s = h.core.update_settings(SettingsPatch { ui_scale: Some(10), ..Default::default() }).unwrap();
    assert_eq!(s.ui_scale, 90, "clamped");
    let big = "x".repeat(256 * 1024 + 1);
    assert_eq!(
        code(h.core.update_settings(SettingsPatch { ui_prefs: Some(big), ..Default::default() })),
        ErrorCode::Validation
    );
    let v = serde_json::to_value(h.core.get_settings().unwrap()).unwrap();
    assert_eq!(
        (v["theme"].as_str(), v["accent"].as_str(), v["density"].as_str()),
        (Some("high_contrast"), Some("emerald"), Some("compact"))
    );
}

/// 5,000 transfers in the inbox and 1,500 approved for one customer, inserted directly.
fn big(h: &common::Harness) -> i64 {
    let c = h.customer("كبير", 2500);
    let conn = Connection::open(h.core.db_path()).unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    for i in 0..5000i64 {
        tx.execute(
            "INSERT INTO paypal_transactions (source, paypal_txn_id, type, payer_name, payer_email, currency, gross_minor,
             fee_minor, net_minor, fee_is_estimated, occurred_at, status, created_at, updated_at)
             VALUES ('manual', ?1, 'payment', ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, 'unassigned', ?8, ?8)",
            params![
                format!("BULK{i:013}"),
                format!("Payer {}", i % 97),
                format!("p{}@example.com", i % 97),
                if i % 3 == 0 { "EUR" } else { "USD" },
                1000 + i,
                if i % 2 == 0 { Some(30) } else { None },
                if i % 2 == 0 { Some(970 + i) } else { None },
                format!("2026-{:02}-{:02}T10:00:00Z", 1 + (i % 11), 1 + (i % 27)),
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    drop(conn);
    // 1,500 of them approved for the customer through the normal flow (ledger, numbers).
    let ids: Vec<i64> = {
        let conn = Connection::open(h.core.db_path()).unwrap();
        let mut stmt = conn
            .prepare("SELECT id FROM paypal_transactions WHERE fee_minor IS NOT NULL AND currency = 'USD' LIMIT 1500")
            .unwrap();
        let v = stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        v
    };
    for id in &ids {
        h.core.txn_assign(*id, c.id, None, true).unwrap();
    }
    c.id
}

#[test]
fn pages_of_500_over_5000_transactions_stay_fast() {
    let h = harness();
    let cid = big(&h);
    let sort = TxnSort { key: TxnSortKey::OccurredAt, dir: ppfeez_core::transactions::SortDir::Desc };
    let filter = TxnFilter {
        status: Some(StatusFilter::Status(TxnStatus::Unassigned)),
        search: Some("Payer 1".into()),
        ..Default::default()
    };
    let started = Instant::now();
    let page = h.core.txn_list(&filter, sort, 1, 500).unwrap();
    let filtered = started.elapsed();
    assert!(page.total > 300);
    assert_eq!(page.items.len() as i64, page.total.min(500));
    let started = Instant::now();
    let all = h.core.txn_list(&TxnFilter::default(), sort, 3, 500).unwrap();
    let plain = started.elapsed();
    assert_eq!((all.items.len(), all.total), (500, 5000));
    assert_eq!(
        h.core.txn_list(&TxnFilter::default(), sort, 1, 900).unwrap().items.len(),
        500,
        "page size capped at 500"
    );
    let started = Instant::now();
    let st = h.core.customer_statement(cid, "USD", &StatementFilter::default()).unwrap();
    let statement = started.elapsed();
    assert_eq!(st.rows.len(), 1500);
    eprintln!("filtered page {filtered:?}, plain page {plain:?}, statement of 1500 rows {statement:?}");
    // Measured here (debug): ~40 ms per page, ~260 ms for the statement; bounds leave room for CI runners.
    assert!(filtered.as_millis() < 500, "filtered page took {filtered:?}");
    assert!(plain.as_millis() < 500, "page took {plain:?}");
    assert!(statement.as_millis() < 2500, "statement took {statement:?}");
}
