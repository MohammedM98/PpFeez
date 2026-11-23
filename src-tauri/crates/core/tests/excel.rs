mod common;

use calamine::{open_workbook, Data, Reader, Xlsx};
use common::{code, harness};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::excel::{is_lock_error, save_atomic_with};
use ppfeez_core::ledger::{PayoutInput, PayoutMethod};
use ppfeez_core::settings::SettingsPatch;
use ppfeez_core::transactions::{Period, SortDir, TxnFilter, TxnSort, TxnSortKey};
use std::io::Read;
use std::path::Path;

fn read(path: &Path) -> Xlsx<std::io::BufReader<std::fs::File>> {
    open_workbook(path).expect("readable xlsx")
}

fn rows(path: &Path, sheet: &str) -> Vec<Vec<Data>> {
    let mut wb = read(path);
    let range = wb.worksheet_range(sheet).unwrap_or_else(|e| panic!("{sheet}: {e}"));
    range.rows().map(|r| r.to_vec()).collect()
}

fn s(d: &Data) -> String {
    match d {
        Data::String(s) => s.clone(),
        other => format!("{other:?}"),
    }
}

fn f(d: &Data) -> f64 {
    match d {
        Data::Float(v) => *v,
        Data::Int(v) => *v as f64,
        other => panic!("expected a number, got {other:?}"),
    }
}

/// Every worksheet XML in the file declares right-to-left.
fn all_sheets_rtl(path: &Path) -> bool {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let names: Vec<String> = zip
        .file_names()
        .filter_map(|n| n.ok())
        .filter(|n| n.starts_with("xl/worksheets/sheet"))
        .map(|n| n.to_string())
        .collect();
    assert!(!names.is_empty());
    names.iter().all(|n| {
        let mut xml = String::new();
        zip.by_name(n).unwrap().read_to_string(&mut xml).unwrap();
        xml.contains("rightToLeft=\"1\"")
    })
}

fn setup(h: &common::Harness) -> (i64, i64) {
    let c = h.customer("أحمد", 2500);
    let t = h.manual("USD", "100.00", Some("5.00"));
    h.core.txn_assign(t.id, c.id, None, true).unwrap();
    let j = h.manual("JPY", "5,000", Some("0"));
    h.core.txn_assign(j.id, c.id, None, true).unwrap();
    (c.id, t.id)
}

#[test]
fn main_workbook_has_four_arabic_rtl_sheets_with_numeric_amounts() {
    let h = harness();
    let (cid, _) = setup(&h);
    h.manual("EUR", "10", None); // unassigned, needs fee
    let path = h.dir.path().join("PpFeez.xlsx");
    assert_eq!(code(h.core.excel_update()), ErrorCode::NoExportPath);
    h.core.excel_set_path(&path.display().to_string()).unwrap();
    let r = h.core.excel_update().unwrap();
    assert_eq!(r.sheets, 4);
    assert_eq!(r.path, path.display().to_string());
    assert_eq!(h.core.get_settings().unwrap().excel_last_exported_at.as_deref(), Some(r.exported_at.as_str()));

    assert_eq!(read(&path).sheet_names(), vec!["الملخص", "المعاملات", "العملاء", "الدفتر"]);
    assert!(all_sheets_rtl(&path));

    let tx = rows(&path, "المعاملات");
    assert_eq!(s(&tx[0][0]), "التاريخ");
    assert_eq!(s(&tx[0][7]), "الأصلي");
    let usd = tx.iter().find(|r| s(&r[6]) == "USD").unwrap();
    assert_eq!([f(&usd[7]), f(&usd[8]), f(&usd[9]), f(&usd[12]), f(&usd[13])], [100.00, 5.00, 95.00, 23.75, 71.25]);
    assert!((f(&usd[11]) - 0.25).abs() < 1e-12, "commission % as a number");
    assert_eq!(s(&usd[10]), "أحمد");
    assert_eq!(s(&usd[14]), "معتمدة");
    assert!(matches!(usd[0], Data::DateTime(_)), "real Excel date");
    let jpy = tx.iter().find(|r| s(&r[6]) == "JPY").unwrap();
    assert_eq!(f(&jpy[7]), 5000.0, "no decimals for JPY");
    let eur = tx.iter().find(|r| s(&r[6]) == "EUR").unwrap();
    assert_eq!(eur[8], Data::Empty, "unknown fee stays empty");

    let summary = rows(&path, "الملخص");
    assert_eq!(s(&summary[0][3]), "عمولتي");
    let usd = summary.iter().find(|r| s(&r[0]) == "USD").unwrap();
    assert_eq!([f(&usd[1]), f(&usd[2]), f(&usd[3]), f(&usd[4])], [100.0, 5.0, 23.75, 71.25]);
    let needs_fee = summary.iter().find(|r| s(&r[0]) == "تحتاج رسوم").unwrap();
    assert_eq!(f(&needs_fee[1]), 1.0);

    let cust = rows(&path, "العملاء");
    assert_eq!(s(&cust[0][4]), "الرصيد JPY");
    assert_eq!(s(&cust[0][5]), "الرصيد USD");
    assert_eq!(s(&cust[1][0]), "أحمد");
    assert_eq!((f(&cust[1][4]), f(&cust[1][5])), (3750.0, 71.25));

    let ledger = rows(&path, "الدفتر");
    assert_eq!(s(&ledger[0][7]), "الرصيد الجاري");
    assert_eq!(ledger.len(), 3);
    let _ = cid;
}

#[test]
fn update_twice_rewrites_the_same_path_with_new_data() {
    let h = harness();
    let (cid, _) = setup(&h);
    let path = h.dir.path().join("main.xlsx");
    h.core
        .update_settings(SettingsPatch {
            excel_export_path: Some(Some(path.display().to_string())),
            ..Default::default()
        })
        .unwrap();
    h.core.excel_update().unwrap();
    assert_eq!(rows(&path, "الدفتر").len(), 3);
    h.core
        .ledger_add_payout(
            cid,
            PayoutInput {
                currency: "USD".into(),
                amount_text: "20".into(),
                entry_date: "2026-11-23".into(),
                method: PayoutMethod::Usdt,
                reference: None,
                description: None,
                confirm_overdraw: None,
            },
        )
        .unwrap();
    h.core.excel_update().unwrap();
    let ledger = rows(&path, "الدفتر");
    assert_eq!(ledger.len(), 4);
    let last_usd = ledger.iter().rfind(|r| s(&r[1]) == "USD").unwrap();
    assert_eq!((f(&last_usd[6]), f(&last_usd[7])), (20.0, 51.25));
    assert_eq!(s(&last_usd[9]), "USDT");
    let leftovers: Vec<_> = std::fs::read_dir(h.dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "no temp files left behind");
}

#[test]
fn locked_file_reports_file_locked_and_keeps_the_old_file() {
    let h = harness();
    let dest = h.dir.path().join("locked.xlsx");
    std::fs::write(&dest, b"old content").unwrap();
    // Windows refuses to replace a file that Excel holds open (sharing violation 32).
    let err = save_atomic_with(b"new", &dest, |_, _| Err(std::io::Error::from_raw_os_error(32))).unwrap_err();
    assert_eq!(err.code, ErrorCode::FileLocked);
    assert_eq!(err.message_ar, "أغلق الملف في Excel ثم أعد المحاولة");
    assert_eq!(std::fs::read(&dest).unwrap(), b"old content");
    let temps = std::fs::read_dir(h.dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(temps, 0, "temp file removed");
    let err = save_atomic_with(b"new", &dest, |_, _| Err(std::io::ErrorKind::PermissionDenied.into())).unwrap_err();
    assert_eq!(err.code, ErrorCode::FileLocked);
    let err = save_atomic_with(b"new", &dest, |_, _| Err(std::io::ErrorKind::Other.into())).unwrap_err();
    assert_eq!(err.code, ErrorCode::ExportFailed);
    assert!(is_lock_error(&std::io::Error::from_raw_os_error(33)));
}

#[test]
fn path_validation() {
    let h = harness();
    assert_eq!(code(h.core.excel_set_path("C:/nowhere/file.csv")), ErrorCode::Validation);
    let missing_dir = h.dir.path().join("missing").join("x.xlsx");
    assert_eq!(code(h.core.excel_set_path(&missing_dir.display().to_string())), ErrorCode::Validation);
    let ok = h.dir.path().join("Report.XLSX");
    let s = h.core.excel_set_path(&ok.display().to_string()).unwrap();
    assert_eq!(s.excel_export_path, Some(ok.display().to_string()));
    let s = h.core.update_settings(SettingsPatch { excel_export_path: Some(None), ..Default::default() }).unwrap();
    assert_eq!(s.excel_export_path, None);
}

#[test]
fn update_on_close() {
    let h = harness();
    assert!(h.core.excel_on_close().unwrap().is_none(), "no path set");
    let path = h.dir.path().join("close.xlsx");
    h.core.excel_set_path(&path.display().to_string()).unwrap();
    assert!(h.core.get_settings().unwrap().excel_update_on_close);
    assert!(h.core.excel_on_close().unwrap().is_some());
    assert!(path.exists());
    h.core.update_settings(SettingsPatch { excel_update_on_close: Some(false), ..Default::default() }).unwrap();
    assert!(h.core.excel_on_close().unwrap().is_none());
}

#[test]
fn transactions_export_respects_filter_and_sort_with_totals() {
    let h = harness();
    setup(&h);
    h.manual("USD", "40", Some("1"));
    h.manual("USD", "10", None);
    let path = h.dir.path().join("tx.xlsx");
    let filter = TxnFilter { currency: Some("USD".into()), ..Default::default() };
    let r = h
        .core
        .excel_export_transactions(&filter, TxnSort { key: TxnSortKey::GrossMinor, dir: SortDir::Desc }, &path)
        .unwrap();
    assert_eq!((r.sheets, r.rows), (1, 3));
    let tx = rows(&path, "المعاملات");
    let gross: Vec<f64> = tx[1..4].iter().map(|r| f(&r[7])).collect();
    assert_eq!(gross, vec![100.0, 40.0, 10.0]);
    assert!(tx.iter().all(|r| s(&r[6]) != "JPY"));
    let total = tx.iter().find(|r| s(&r[0]).starts_with("الإجمالي")).unwrap();
    assert_eq!(s(&total[0]), "الإجمالي (\u{2066}3\u{2069})");
    assert_eq!((f(&total[7]), f(&total[8]), f(&total[9])), (150.0, 6.0, 134.0));
    assert!(all_sheets_rtl(&path));
}

#[test]
fn ledger_export_matches_running_balance() {
    let h = harness();
    let (cid, _) = setup(&h);
    h.core
        .ledger_add_payout(
            cid,
            PayoutInput {
                currency: "USD".into(),
                amount_text: "30".into(),
                entry_date: "2026-11-24".into(),
                method: PayoutMethod::Cash,
                reference: Some("R-9".into()),
                description: None,
                confirm_overdraw: None,
            },
        )
        .unwrap();
    // All currencies: one sheet each.
    let all = h.dir.path().join("all.xlsx");
    let r = h.core.excel_export_ledger(cid, None, None, &all).unwrap();
    assert_eq!(r.sheets, 2);
    assert_eq!(read(&all).sheet_names(), vec!["JPY", "USD"]);

    // One currency with a period: opening balance line.
    let path = h.dir.path().join("usd.xlsx");
    let period = Period { from: Some("2026-11-24".into()), to: None };
    h.core.excel_export_ledger(cid, Some("usd"), Some(&period), &path).unwrap();
    let sheet = rows(&path, "USD");
    assert_eq!(s(&sheet[0][0]), "كشف حساب: أحمد");
    assert!(s(&sheet[1][0]).starts_with("الفترة: \u{2066}2026-11-24\u{2069}"));
    // Generated descriptions keep their isolates in the Excel cells.
    let ledger = rows(&all, "USD");
    let credit = ledger.iter().find(|r| r.len() > 2 && s(&r[2]).starts_with("دفعة من")).unwrap();
    assert!(s(&credit[2]).contains("عمولة \u{2066}25.00%\u{2069}"));
    let opening = sheet.iter().find(|r| s(&r[2]) == "رصيد سابق").unwrap();
    assert_eq!(f(&opening[5]), 71.25);
    let entry = sheet.iter().find(|r| r.len() > 6 && s(&r[6]) == "R-9").unwrap();
    assert_eq!((f(&entry[4]), f(&entry[5])), (30.0, 41.25));
    let closing = sheet.iter().find(|r| s(&r[2]) == "الرصيد الختامي").unwrap();
    let view = h.core.ledger_entries(cid, "USD", Some(&period)).unwrap();
    assert_eq!(f(&closing[5]), view.closing_balance_minor as f64 / 100.0);
    assert!(all_sheets_rtl(&path));

    assert_eq!(code(h.core.excel_export_ledger(cid, None, None, &h.dir.path().join("x.txt"))), ErrorCode::Validation);
}
