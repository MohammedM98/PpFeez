//! SPEC §6.8.6: no "تم الإرسال؟" column in the customer's Excel file. Files of 0.5.x/0.6.0 keep
//! working: with the column it is still kept up to date; if the owner deleted it, writing goes on
//! without a layout error. The two transfer counts of the header are values in both.

mod common;

use calamine::{open_workbook, Data, Reader, Xlsx};
use common::{harness, Harness};
use ppfeez_core::excel::statement as stmt;
use ppfeez_core::ledger::PayoutMethod;
use ppfeez_core::payouts::{CreateStatus, PayoutCreateInput, PayoutDetails};
use std::path::Path;

fn rows(path: &Path) -> Vec<Vec<Data>> {
    let mut wb: Xlsx<_> = open_workbook(path).unwrap();
    wb.worksheet_range("كشف USD").unwrap().rows().map(|r| r.to_vec()).collect()
}

fn formulas(path: &Path) -> Vec<String> {
    let mut wb: Xlsx<_> = open_workbook(path).unwrap();
    let f = wb.worksheet_formula("كشف USD").unwrap();
    f.rows().flat_map(|r| r.iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>()).collect()
}

fn s(d: &Data) -> String {
    match d {
        Data::String(s) => s.clone(),
        Data::Empty => String::new(),
        o => format!("{o:?}"),
    }
}

/// Column of a header in the table header row (found by the key column's header).
fn col_of(path: &Path, header: &str) -> Option<usize> {
    let r = rows(path);
    let head = r.iter().find(|r| r.iter().any(|c| s(c) == "مفتاح")).unwrap();
    head.iter().position(|c| s(c) == header)
}

/// The cell of `header` on the row whose key starts with `key`.
fn cell(path: &Path, key: &str, header: &str) -> String {
    let (k, c) = (col_of(path, "مفتاح").unwrap(), col_of(path, header).unwrap());
    let r = rows(path);
    s(&r.iter().find(|r| s(&r[k]).starts_with(key)).unwrap()[c])
}

fn figure(path: &Path, label: &str) -> Data {
    let r = rows(path);
    let row = r.iter().find(|r| r.iter().any(|c| s(c) == label)).unwrap();
    let i = row.iter().position(|c| s(c) == label).unwrap();
    row[i + 1].clone()
}

fn approve(h: &Harness, customer: i64, gross: &str) -> i64 {
    let t = h.manual("USD", gross, Some("0"));
    h.core.txn_assign(t.id, customer, None, true).unwrap().id
}

fn pay(h: &Harness, customer: i64, txns: Vec<i64>) -> i64 {
    h.core
        .payout_create(
            customer,
            PayoutCreateInput {
                currency: "USD".into(),
                txn_ids: txns,
                returned_entry_ids: vec![],
                amount_text: None,
                difference_reason: None,
                date: "2026-11-23".into(),
                details: PayoutDetails {
                    method: PayoutMethod::Usdt,
                    platform: Some("Binance".into()),
                    network: None,
                    destination: None,
                    reference: Some("0xfeed".into()),
                    note: None,
                },
                status: CreateStatus::Sent,
                matched_confirmed: true,
            },
        )
        .unwrap()
        .id
}

fn sync(h: &Harness) -> i64 {
    let ev = h.core.customer_excel_sync_due();
    assert!(ev.iter().all(|e| e.error.is_none()), "{ev:?}");
    ev.iter().map(|e| e.added).sum()
}

#[test]
fn a_new_file_has_no_sent_column() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let path = h.dir.path().join("ali.xlsx");
    h.core.customer_excel_create(c.id, &path.display().to_string(), false).unwrap();
    approve(&h, c.id, "100");
    assert_eq!(sync(&h), 1);
    assert_eq!(col_of(&path, stmt::SENT_HEADER), None);
    assert_eq!(col_of(&path, "مفتاح"), Some(stmt::C_KEY as usize));
    assert!(!formulas(&path).iter().any(|f| f.contains("تم الإرسال")));
    // SPEC §6.8.6 / §4.9: and no "غير مدفوع" / "عدد المدفوع" in the header.
    assert!(!rows(&path).iter().flatten().any(|c| s(c) == stmt::NOT_PAID || s(c) == stmt::PAID));
}

#[test]
fn an_old_file_with_the_column_keeps_it_up_to_date() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let path = h.dir.path().join("old.xlsx");
    h.core.debug_customer_excel_create_legacy(c.id, &path.display().to_string(), true).unwrap();
    assert_eq!(col_of(&path, stmt::SENT_HEADER), Some(stmt::C_METHOD as usize), "the 0.6.0 layout");
    assert!(formulas(&path).iter().any(|f| f.contains("تم الإرسال")), "0.6.0 counted from the column");
    let t1 = approve(&h, c.id, "100");
    approve(&h, c.id, "20");
    assert_eq!(sync(&h), 2);
    assert_eq!(cell(&path, "T:", stmt::SENT_HEADER), "لا");
    assert_eq!(cell(&path, "T:", "طريقة الدفع"), "", "later columns are where the file has them");
    let p = pay(&h, c.id, vec![t1]);
    assert_eq!(sync(&h), 1);
    assert_eq!(cell(&path, "T:", stmt::SENT_HEADER), "نعم — دفعة 1");
    assert_eq!(cell(&path, &format!("P:{p}"), stmt::SENT_HEADER), "تم الإرسال");
    assert_eq!(cell(&path, &format!("P:{p}"), "طريقة الدفع"), "USDT");
    // The two counts are values now, from the program.
    assert!(!formulas(&path).iter().any(|f| f.contains("تم الإرسال")));
    assert_eq!((figure(&path, stmt::NOT_PAID), figure(&path, stmt::PAID)), (Data::Float(1.0), Data::Float(1.0)));
    h.core.payout_cancel(p, "خطأ").unwrap();
    assert_eq!(sync(&h), 1);
    assert_eq!(cell(&path, &format!("P:{p}"), stmt::SENT_HEADER), "ملغاة");
    assert_eq!(cell(&path, "T:", stmt::SENT_HEADER), "لا");
    assert_eq!((figure(&path, stmt::NOT_PAID), figure(&path, stmt::PAID)), (Data::Float(2.0), Data::Float(0.0)));
}

#[test]
fn an_old_file_whose_column_was_deleted_keeps_working() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let path = h.dir.path().join("deleted.xlsx");
    h.core.debug_customer_excel_create_legacy(c.id, &path.display().to_string(), false).unwrap();
    assert_eq!(col_of(&path, stmt::SENT_HEADER), None);
    // Its header still has the 0.6.0 COUNTIFS on the deleted column.
    assert!(formulas(&path).iter().any(|f| f.contains("تم الإرسال")));
    let t1 = approve(&h, c.id, "100");
    assert_eq!(sync(&h), 1, "no layout error without the column");
    let p = pay(&h, c.id, vec![t1]);
    assert_eq!(sync(&h), 1);
    assert_eq!(cell(&path, &format!("P:{p}"), "طريقة الدفع"), "USDT");
    assert!(!formulas(&path).iter().any(|f| f.contains("تم الإرسال")), "the broken formulas are replaced");
    assert_eq!((figure(&path, stmt::NOT_PAID), figure(&path, stmt::PAID)), (Data::Float(0.0), Data::Float(1.0)));
    let send = h.core.customer_excel_send_unexported(c.id, None).unwrap();
    assert_eq!((send.added, send.still_pending), (0, 0));
}
