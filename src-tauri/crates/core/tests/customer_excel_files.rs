//! SPEC §6.8.4: several statement files per customer, one of them current.

mod common;

use calamine::{open_workbook, Data, Reader, Xlsx};
use common::{code, harness, open_in, Harness};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::excel::customer::{ExcelStart, ExcelStatus, ItemKind, ItemRef};
use ppfeez_core::excel::statement as stmt;
use ppfeez_core::ledger::{AdjustmentInput, Direction, PayoutInput, PayoutMethod};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

fn rows(path: &Path, cur: &str) -> Vec<Vec<Data>> {
    let mut wb: Xlsx<_> = open_workbook(path).unwrap();
    wb.worksheet_range(&format!("كشف {cur}"))
        .unwrap()
        .rows()
        .filter(|r| r.get(stmt::C_KEY as usize).is_some_and(|k| matches!(k, Data::String(x) if x.contains(':'))))
        .map(|r| r.to_vec())
        .collect()
}

fn s(d: &Data) -> String {
    match d {
        Data::String(s) => s.clone(),
        Data::Empty => String::new(),
        o => format!("{o:?}"),
    }
}

fn keys(path: &Path, cur: &str) -> Vec<String> {
    rows(path, cur).iter().map(|r| s(&r[stmt::C_KEY as usize])).collect()
}

fn seqs(path: &Path) -> Vec<String> {
    rows(path, "USD").iter().map(|r| s(&r[stmt::C_SEQ as usize])).collect()
}

fn approve(h: &Harness, customer: i64, currency: &str, gross: &str) -> i64 {
    let t = h.manual(currency, gross, Some("0"));
    h.core.txn_assign(t.id, customer, None, true).unwrap().id
}

fn payout(h: &Harness, customer: i64, currency: &str, amount: &str) -> i64 {
    h.core
        .ledger_add_payout(
            customer,
            PayoutInput {
                currency: currency.into(),
                amount_text: amount.into(),
                entry_date: "2026-11-23".into(),
                method: PayoutMethod::Usdt,
                platform: None,
                network: None,
                destination: None,
                reference: None,
                description: None,
                confirm_overdraw: Some(true),
            },
        )
        .unwrap()
        .id
}

fn sync(h: &Harness) -> i64 {
    h.core.customer_excel_sync_due().iter().map(|e| e.added).sum()
}

/// Customer "Ali" (25%) with a current statement holding everything so far.
fn linked(h: &Harness) -> (i64, PathBuf) {
    let c = h.customer("Ali", 2500);
    let path = h.dir.path().join("ali-2026.xlsx");
    h.core.customer_excel_create(c.id, &path.display().to_string(), false).unwrap();
    (c.id, path)
}

fn new_file(h: &Harness, c: i64, name: &str, start: ExcelStart) -> (i64, PathBuf, i64) {
    let path = h.dir.path().join(name);
    let r = h.core.customer_excel_new_file(c, &path.display().to_string(), &start, true, None).unwrap();
    assert!(r.file.is_current && r.file.exists);
    (r.file.id, path, r.added)
}

fn counts(h: &Harness, c: i64) -> (i64, i64, i64) {
    let l = h.core.customer_excel_get(c).unwrap().unwrap();
    (l.exported_count, l.pending_count, l.not_exported_count)
}

#[test]
fn a_new_file_with_carried_balance_starts_with_the_balance_then_only_new_rows() {
    let h = harness();
    let (c, old) = linked(&h);
    approve(&h, c, "USD", "100"); // +75
    let t2 = approve(&h, c, "USD", "20"); // +15
    payout(&h, c, "USD", "10"); // −10 → USD 80
    approve(&h, c, "EUR", "40"); // +30
    payout(&h, c, "EUR", "50"); // −50 → EUR −20
    assert_eq!(sync(&h), 5);
    let old_bytes = std::fs::read(&old).unwrap();

    let (file, new, added) = new_file(&h, c, "ali-2027.xlsx", ExcelStart::CarryBalance);
    assert_eq!(added, 0, "only the balance");
    let usd = rows(&new, "USD");
    assert_eq!(usd.len(), 1);
    assert_eq!(s(&usd[0][stmt::C_LABEL as usize]), "رصيد مرحّل من الملف السابق");
    assert_eq!(usd[0][stmt::C_CREDIT as usize], Data::Float(80.0));
    let eur = rows(&new, "EUR");
    assert_eq!((eur.len(), eur[0][stmt::C_DEBIT as usize].clone()), (1, Data::Float(20.0)), "negative: عليه");
    let link = h.core.customer_excel_get(c).unwrap().unwrap();
    assert_eq!((link.current_file_id, link.files_count, link.path.clone()), (file, 2, new.display().to_string()));
    assert_eq!(counts(&h, c), (0, 0, 0), "everything is in the carried balance");
    assert_eq!(h.core.txn_get(t2).unwrap().excel_status, ExcelStatus::Exported);

    // New movements go to the new file only; the old file is not touched.
    let t3 = approve(&h, c, "USD", "8");
    assert_eq!(sync(&h), 1);
    assert_eq!(keys(&new, "USD").len(), 2);
    assert_eq!(std::fs::read(&old).unwrap(), old_bytes, "the previous file stays as it was");
    // Unapproving a transfer that is inside the carried balance writes its reversal row.
    h.core.txn_unapprove(t2, "خطأ").unwrap();
    assert_eq!(sync(&h), 1);
    let last = rows(&new, "USD").pop().unwrap();
    // Not "-T:": the transfer's own row is not in this file, so the transfer figures ignore it.
    assert!(s(&last[stmt::C_KEY as usize]).starts_with("-~T:"));
    assert_eq!(last[stmt::C_DEBIT as usize], Data::Float(15.0));
    assert_eq!(s(&last[stmt::C_LABEL as usize]), "إلغاء اعتماد الحوالة #2");
    // Adding a carried item by hand is a duplicate, not a second line.
    let p = h.core.customer_excel_preview(c, &[ItemRef { kind: ItemKind::Txn, id: t3 }], None).unwrap();
    assert_eq!(p.duplicates.len(), 1);
    let r = h.core.customer_excel_add(c, &[ItemRef { kind: ItemKind::Txn, id: 1 }], None).unwrap();
    assert_eq!((r.added, r.skipped_duplicates), (0, 1));
    assert_eq!(h.core.customer_excel_files(c).unwrap()[0].exported_count, 2, "carried lines are not counted");
    if let Ok(d) = std::env::var("DUMP_DIR") {
        std::fs::copy(&new, Path::new(&d).join("carried.xlsx")).unwrap();
    }
}

#[test]
fn all_copies_every_movement() {
    let h = harness();
    let (c, _) = linked(&h);
    approve(&h, c, "USD", "100");
    approve(&h, c, "USD", "20");
    payout(&h, c, "USD", "10");
    sync(&h);
    let (_, new, added) = new_file(&h, c, "copy.xlsx", ExcelStart::All);
    assert_eq!(added, 3);
    assert_eq!(seqs(&new), vec!["Float(1.0)", "Float(2.0)", ""]);
    assert!(!keys(&new, "USD").iter().any(|k| k.starts_with("B:")));
    assert_eq!(counts(&h, c), (3, 0, 0));
}

#[test]
fn from_a_transfer_number_or_a_date_carries_what_comes_before() {
    let h = harness();
    let (c, _) = linked(&h);
    h.core
        .ledger_add_adjustment(
            c,
            AdjustmentInput {
                currency: "USD".into(),
                amount_text: "5".into(),
                direction: Direction::Credit,
                entry_date: "2026-11-01".into(),
                description: "رصيد قديم".into(),
            },
        )
        .unwrap();
    for g in ["10", "20", "30"] {
        approve(&h, c, "USD", g); // 7.5, 15, 22.5 on 2026-11-23
    }
    sync(&h);

    // From #2: 5 + 7.5 carried, then #2 and #3 (already in the old file, but this is another file).
    let (_, f2, added) = new_file(&h, c, "from2.xlsx", ExcelStart::FromSeq { seq: 2 });
    assert_eq!(added, 2);
    let r = rows(&f2, "USD");
    assert_eq!(s(&r[0][stmt::C_LABEL as usize]), "رصيد مرحّل قبل الحوالة #2");
    assert_eq!(r[0][stmt::C_CREDIT as usize], Data::Float(12.5));
    assert_eq!(seqs(&f2)[1..], ["Float(2.0)", "Float(3.0)"]);

    // From a date: the old adjustment is carried, the three transfers follow.
    let (_, fd, added) = new_file(&h, c, "fromdate.xlsx", ExcelStart::FromDate { date: "2026-11-10".into() });
    assert_eq!(added, 3);
    assert_eq!(rows(&fd, "USD")[0][stmt::C_CREDIT as usize], Data::Float(5.0));

    let e = h.core.customer_excel_new_file(
        c,
        &h.dir.path().join("x.xlsx").display().to_string(),
        &ExcelStart::FromSeq { seq: 9 },
        true,
        None,
    );
    assert_eq!(code(e), ErrorCode::Validation);
    assert!(!h.dir.path().join("x.xlsx").exists(), "nothing created on a refused start");
}

#[test]
fn manual_adds_choose_the_file_and_duplicates_are_per_file() {
    let h = harness();
    let (c, old) = linked(&h);
    let old_id = h.core.customer_excel_get(c).unwrap().unwrap().current_file_id;
    let t1 = approve(&h, c, "USD", "100");
    sync(&h);
    let (new_id, new, _) = new_file(&h, c, "new.xlsx", ExcelStart::FromSeq { seq: 1 });
    assert_eq!(keys(&new, "USD").len(), 2, "balance 0 and #1");

    // Automatic sync off; a new transfer can be added to the previous file by hand.
    h.core.customer_excel_set_auto(c, false).unwrap();
    let t2 = approve(&h, c, "USD", "20");
    let items = [ItemRef { kind: ItemKind::Txn, id: t2 }, ItemRef { kind: ItemKind::Txn, id: t1 }];
    let p = h.core.customer_excel_preview(c, &items, Some(old_id)).unwrap();
    assert_eq!((p.to_add.len(), p.duplicates.len()), (1, 1), "#1 is already in the old file");
    let r = h.core.customer_excel_add(c, &items, Some(old_id)).unwrap();
    assert_eq!((r.added, r.skipped_duplicates, r.path), (1, 1, old.display().to_string()));
    // Status is relative to the current (new) file, where #2 is not.
    assert_eq!(h.core.txn_get(t2).unwrap().excel_status, ExcelStatus::NotExported);
    assert_eq!(h.core.txn_get(t1).unwrap().excel_status, ExcelStatus::Exported);
    let r = h.core.customer_excel_send_unexported(c, Some(new_id)).unwrap();
    assert_eq!(r.added, 1);
    assert_eq!(keys(&new, "USD").len(), 3);
    assert_eq!(keys(&old, "USD").len(), 2);
}

#[test]
fn set_current_and_remove_from_the_list() {
    let h = harness();
    let (c, old) = linked(&h);
    let old_id = h.core.customer_excel_get(c).unwrap().unwrap().current_file_id;
    let (new_id, new, _) = new_file(&h, c, "new.xlsx", ExcelStart::CarryBalance);
    assert_eq!(code(h.core.customer_excel_remove_file(c, new_id)), ErrorCode::InvalidTransition);

    let l = h.core.customer_excel_set_current(c, old_id).unwrap();
    assert_eq!((l.current_file_id, l.path), (old_id, old.display().to_string()));
    approve(&h, c, "USD", "10");
    assert_eq!(sync(&h), 1);
    assert_eq!(keys(&old, "USD").len(), 1);
    assert_eq!(keys(&new, "USD").len(), 1, "only its balance row");

    h.core.customer_excel_remove_file(c, new_id).unwrap();
    assert!(new.exists(), "the file itself is kept");
    let files = h.core.customer_excel_files(c).unwrap();
    assert_eq!(files.iter().map(|f| (f.id, f.is_current)).collect::<Vec<_>>(), vec![(old_id, true)]);
    let conn = Connection::open(h.core.db_path()).unwrap();
    let left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM customer_excel_items WHERE file_path = ?1",
            params![new.display().to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);

    // Unlink keeps the list; setting a file current links it again.
    h.core.customer_excel_unlink(c).unwrap();
    assert!(h.core.customer_excel_get(c).unwrap().is_none());
    assert_eq!(h.core.customer_excel_files(c).unwrap().len(), 1);
    assert!(h.core.customer_excel_set_current(c, old_id).unwrap().auto_sync);
}

/// A 0.5.1 database (schema 8): the linked file becomes the current file, tracking intact.
#[test]
fn upgrade_from_0_5_1() {
    const V8: [&str; 8] = [
        include_str!("../src/db/migrations/0001_init.sql"),
        include_str!("../src/db/migrations/0002_pull_range.sql"),
        include_str!("../src/db/migrations/0003_review_hold.sql"),
        include_str!("../src/db/migrations/0004_ledger_delete_flow.sql"),
        include_str!("../src/db/migrations/0005_excel_exported.sql"),
        include_str!("../src/db/migrations/0006_payouts.sql"),
        include_str!("../src/db/migrations/0007_customer_excel.sql"),
        include_str!("../src/db/migrations/0008_excel_sync.sql"),
    ];
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    let path = dir.path().join("owner.xlsx").display().to_string();
    {
        let conn = Connection::open(dir.path().join("data").join("ppfeez.db")).unwrap();
        for sql in V8 {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 8).unwrap();
        let now = "2026-11-20T10:00:00Z";
        conn.execute(
            "INSERT INTO customers (id, name, default_commission_bps, created_at, updated_at) VALUES (1, 'Owner Test', 2500, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO customer_excel (customer_id, file_path, updated_at, add_by_default, auto_sync) VALUES (1, ?1, ?2, 1, 0)",
            params![path, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO customer_excel_items (customer_id, file_path, line_key, item_kind, item_id, currency, status, added_at)
             VALUES (1, ?1, 'U:2', 'ledger', 2, 'USD', 'exported', ?2)",
            params![path, now],
        )
        .unwrap();
    }
    let h = open_in(dir);
    let files = h.core.customer_excel_files(1).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(
        (files[0].path.as_str(), files[0].is_current, files[0].start_mode.as_str()),
        (path.as_str(), true, "all")
    );
    assert_eq!(files[0].exported_count, 1);
    let link = h.core.customer_excel_get(1).unwrap().unwrap();
    assert_eq!(
        (link.current_file_id, link.files_count, link.add_to_excel_by_default, link.auto_sync),
        (files[0].id, 1, true, false)
    );
}
