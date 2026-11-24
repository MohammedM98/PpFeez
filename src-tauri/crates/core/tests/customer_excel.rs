//! SPEC §6.8.2: the Excel statement a customer receives.

mod common;

use calamine::{open_workbook, Data, Reader, Xlsx};
use common::{code, harness};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::excel::customer::{ItemKind, ItemRef};
use ppfeez_core::excel::statement::{self as stmt, HEADERS};
use ppfeez_core::ledger::{PayoutInput, PayoutMethod};
use ppfeez_core::payouts::{CreateStatus, PayoutCreateInput, PayoutDetails};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

fn parts(path: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut out = BTreeMap::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let mut b = vec![];
        f.read_to_end(&mut b).unwrap();
        out.insert(f.name().unwrap().to_string(), b);
    }
    out
}

fn rows(path: &Path, sheet: &str) -> Vec<Vec<Data>> {
    let mut wb: Xlsx<_> = open_workbook(path).unwrap();
    wb.worksheet_range(sheet).unwrap().rows().map(|r| r.to_vec()).collect()
}

fn formulas(path: &Path, sheet: &str) -> Vec<String> {
    let mut wb: Xlsx<_> = open_workbook(path).unwrap();
    let f = wb.worksheet_formula(sheet).unwrap();
    f.rows().flat_map(|r| r.iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>()).collect()
}

fn s(d: &Data) -> String {
    match d {
        Data::String(s) => s.clone(),
        Data::Empty => String::new(),
        o => format!("{o:?}"),
    }
}

fn data_rows(path: &Path, sheet: &str) -> Vec<Vec<Data>> {
    rows(path, sheet)
        .into_iter()
        .filter(|r| r.get(stmt::C_KEY as usize).is_some_and(|k| matches!(k, Data::String(x) if x.contains(':'))))
        .collect()
}

fn payout_input(amount: &str) -> PayoutInput {
    PayoutInput {
        currency: "USD".into(),
        amount_text: amount.into(),
        entry_date: "2026-11-24".into(),
        method: PayoutMethod::Usdt,
        platform: Some("Binance".into()),
        network: Some("TRC20".into()),
        destination: None,
        reference: Some("0xabc".into()),
        description: None,
        confirm_overdraw: None,
    }
}

fn item(kind: ItemKind, id: i64) -> ItemRef {
    ItemRef { kind, id }
}

#[test]
fn create_add_and_the_spec_example() {
    let h = harness();
    let c = h.customer("سامر", 2500);
    let t = h.manual("USD", "100", Some("5"));
    let t = h.core.txn_assign(t.id, c.id, None, true).unwrap();
    let path = h.dir.path().join("كشف حساب - سامر.xlsx");

    let created = h.core.customer_excel_create(c.id, &path.display().to_string(), false).unwrap();
    assert_eq!((created.added, created.sheets.clone()), (0, vec!["كشف USD".to_string()]));
    let link = h.core.customer_get(c.id).unwrap().excel.unwrap();
    assert!(link.exists && !link.add_to_excel_by_default);
    let header = rows(&path, "كشف USD");
    let head_row = header.iter().find(|r| r.iter().any(|c| s(c) == "مفتاح")).unwrap();
    assert_eq!(head_row.iter().map(s).collect::<Vec<_>>(), HEADERS.map(str::to_string).to_vec(), "column order");
    let f = formulas(&path, "كشف USD");
    assert!(f.iter().any(|x| x.contains("SUMIFS(Statement_USD[له],Statement_USD[مفتاح],\"T:*\")")), "{f:?}");
    assert!(f.iter().any(|x| x.contains(
        "COUNTIFS(Statement_USD[مفتاح],\"T:*\")-COUNTIFS(Statement_USD[مفتاح],\"T:*\",Statement_USD[تم الإرسال؟],\"نعم*\")"
    )));
    assert!(String::from_utf8_lossy(&parts(&path)["docProps/custom.xml"]).contains("PpFeezCustomerId"));

    // The transfer, then a payout of 50.00: running balance 71.25 → 21.25.
    let p = h.core.customer_excel_preview(c.id, &[item(ItemKind::Txn, t.id)]).unwrap();
    assert_eq!((p.to_add.len(), p.duplicates.len()), (1, 0));
    assert_eq!(p.to_add[0].amount_minor, 7125);
    let r = h.core.customer_excel_add(c.id, &[item(ItemKind::Txn, t.id)]).unwrap();
    assert_eq!((r.added, r.skipped_duplicates), (1, 0));
    let pay = h.core.ledger_add_payout(c.id, payout_input("50")).unwrap();
    h.core.customer_excel_add(c.id, &[item(ItemKind::Ledger, pay.id)]).unwrap();

    let d = data_rows(&path, "كشف USD");
    assert_eq!(d.len(), 2);
    let tr = &d[0];
    assert_eq!(tr[stmt::C_SEQ as usize], Data::Float(1.0));
    assert_eq!(
        [3, 4, 5, 7, 8].map(|i| tr[i].clone()),
        [Data::Float(100.0), Data::Float(5.0), Data::Float(95.0), Data::Float(23.75), Data::Float(71.25)]
    );
    assert_eq!(tr[stmt::C_PCT as usize], Data::Float(0.25));
    assert_eq!(s(&tr[stmt::C_SENT as usize]), "لا");
    assert_eq!(s(&tr[stmt::C_REF as usize]), t.paypal_txn_id);
    assert_eq!(s(&tr[stmt::C_KEY as usize]), format!("T:{}", t.paypal_txn_id));
    let pr = &d[1];
    assert_eq!(pr[stmt::C_DEBIT as usize], Data::Float(50.0));
    assert_eq!(s(&pr[stmt::C_METHOD as usize]), "USDT");
    assert_eq!(s(&pr[stmt::C_PLATFORM as usize]), "Binance");
    assert_eq!(s(&pr[stmt::C_KEY as usize]), format!("U:{}", pay.id));
    let f = formulas(&path, "كشف USD");
    assert!(f.contains(&"SUM(I$14:I14)-SUM(J$14:J14)".to_string()), "{f:?}");
    assert!(f.contains(&"SUM(I$14:I15)-SUM(J$14:J15)".to_string()), "{f:?}");
    let table = String::from_utf8(parts(&path)["xl/tables/table1.xml"].clone()).unwrap();
    assert!(table.contains("ref=\"A13:R15\""), "{table}");
    assert!(String::from_utf8_lossy(&parts(&path)["xl/workbook.xml"]).contains("fullCalcOnLoad=\"1\""));
    if let Ok(dir) = std::env::var("DUMP_DIR") {
        std::fs::copy(&path, Path::new(&dir).join("statement.xlsx")).unwrap();
    }

    // Flags.
    assert!(h.core.txn_get(t.id).unwrap().in_customer_excel);
    let entries = h.core.ledger_entries(c.id, "USD", None).unwrap().entries;
    assert!(entries.iter().find(|e| e.id == pay.id).unwrap().in_customer_excel);
    assert!(!entries.iter().find(|e| e.transaction_id == Some(t.id)).unwrap().in_customer_excel);
}

#[test]
fn duplicates_come_from_the_file() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100", Some("5"));
    h.core.txn_assign(t.id, c.id, None, true).unwrap();
    let path = h.dir.path().join("ali.xlsx");
    let created = h.core.customer_excel_create(c.id, &path.display().to_string(), true).unwrap();
    assert_eq!(created.added, 1, "existing approved transfer included");

    let items = [item(ItemKind::Txn, t.id)];
    let p = h.core.customer_excel_preview(c.id, &items).unwrap();
    assert_eq!((p.to_add.len(), p.duplicates.len()), (0, 1));
    let r = h.core.customer_excel_add(c.id, &items).unwrap();
    assert_eq!((r.added, r.skipped_duplicates), (0, 1));
    assert_eq!(data_rows(&path, "كشف USD").len(), 1, "never added twice");

    // Tracking wiped (database rebuilt): the key column still prevents duplicates.
    let conn = Connection::open(h.core.db_path()).unwrap();
    conn.execute("DELETE FROM customer_excel_items", []).unwrap();
    drop(conn);
    assert_eq!(h.core.customer_excel_preview(c.id, &items).unwrap().duplicates.len(), 1);

    // The owner deletes the row from the file: it can be added again.
    let bytes = std::fs::read(&path).unwrap();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut data = vec![];
        f.read_to_end(&mut data).unwrap();
        if name == "xl/worksheets/sheet1.xml" {
            let xml = String::from_utf8(data).unwrap();
            let start = xml.find("<row r=\"14\"").unwrap();
            let end = start + xml[start..].find("</row>").unwrap() + 6;
            data = format!("{}{}", &xml[..start], &xml[end..]).into_bytes();
        }
        out.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut out, &data).unwrap();
    }
    std::fs::write(&path, out.finish().unwrap().into_inner()).unwrap();
    assert_eq!(h.core.customer_excel_preview(c.id, &items).unwrap().to_add.len(), 1);
    assert_eq!(h.core.customer_excel_add(c.id, &items).unwrap().added, 1);
}

#[test]
fn not_allowed_items_and_changed_after_excel() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let other = h.customer("Omar", 2500);
    let pending = h.manual("USD", "10", Some("0"));
    h.core.txn_assign(pending.id, c.id, None, false).unwrap();
    let t = h.manual("USD", "100", Some("5"));
    h.core.txn_assign(t.id, c.id, None, true).unwrap();
    let o = h.manual("USD", "100", Some("5"));
    h.core.txn_assign(o.id, other.id, None, true).unwrap();
    let path = h.dir.path().join("ali.xlsx");
    h.core.customer_excel_create(c.id, &path.display().to_string(), false).unwrap();
    let credit = h.core.ledger_entries(c.id, "USD", None).unwrap().entries[0].id;
    let p = h
        .core
        .customer_excel_preview(
            c.id,
            &[
                item(ItemKind::Txn, pending.id),
                item(ItemKind::Txn, o.id),
                item(ItemKind::Ledger, credit),
                item(ItemKind::Txn, t.id),
            ],
        )
        .unwrap();
    assert_eq!(p.to_add.len(), 1);
    let reasons: Vec<&str> = p.not_allowed.iter().map(|n| n.reason_ar.as_str()).collect();
    assert!(reasons[0].contains("غير معتمدة"), "{reasons:?}");
    assert!(reasons[1].contains("ليست لهذا العميل"));
    assert!(reasons[2].contains("قيد اعتماد"));

    h.core.customer_excel_add(c.id, &[item(ItemKind::Txn, t.id)]).unwrap();
    h.core.txn_unapprove(t.id, "خطأ").unwrap();
    let back = h.core.txn_get(t.id).unwrap();
    assert!(!back.in_customer_excel && back.changed_after_excel);
    assert_eq!(code(h.core.customer_excel_add(c.id, &[item(ItemKind::Txn, pending.id)])), ErrorCode::Validation);
}

#[test]
fn payouts_mark_their_transfers_and_new_currencies_get_a_sheet() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t1 = h.manual("USD", "100", Some("5"));
    h.core.txn_assign(t1.id, c.id, None, true).unwrap();
    let t2 = h.manual("USD", "20", Some("0"));
    h.core.txn_assign(t2.id, c.id, None, true).unwrap();
    let path = h.dir.path().join("ali.xlsx");
    h.core.customer_excel_create(c.id, &path.display().to_string(), true).unwrap();
    let before = parts(&path);

    let p = h
        .core
        .payout_create(
            c.id,
            PayoutCreateInput {
                currency: "USD".into(),
                txn_ids: vec![t1.id, t2.id],
                returned_entry_ids: vec![],
                amount_text: None,
                difference_reason: None,
                date: "2026-11-24".into(),
                details: PayoutDetails {
                    method: PayoutMethod::Bank,
                    platform: Some("بنك فلسطين".into()),
                    network: None,
                    destination: None,
                    reference: Some("TRX-9".into()),
                    note: None,
                },
                status: CreateStatus::Sent,
                matched_confirmed: true,
            },
        )
        .unwrap();
    h.core.customer_excel_add(c.id, &[item(ItemKind::Payout, p.id)]).unwrap();
    let d = data_rows(&path, "كشف USD");
    assert_eq!(d.len(), 3);
    assert_eq!(s(&d[0][stmt::C_SENT as usize]), "نعم — دفعة 1", "transfer row updated");
    assert_eq!(s(&d[1][stmt::C_SENT as usize]), "نعم — دفعة 1");
    assert_eq!(s(&d[2][stmt::C_SEQ as usize]), "دفعة 1");
    assert_eq!(d[2][stmt::C_DEBIT as usize], Data::Float(86.25));
    assert_eq!(s(&d[2][stmt::C_KEY as usize]), format!("P:{}", p.id));
    assert!(h.core.payouts_list(c.id, "USD").unwrap()[0].in_customer_excel);

    // A EUR transfer: a new sheet with its own table in the same file.
    let e = h.manual("EUR", "50", Some("0"));
    h.core.txn_assign(e.id, c.id, None, true).unwrap();
    let r = h.core.customer_excel_add(c.id, &[item(ItemKind::Txn, e.id)]).unwrap();
    assert_eq!(r.sheets, vec!["كشف EUR".to_string()]);
    let wb: Xlsx<_> = open_workbook(&path).unwrap();
    assert_eq!(wb.sheet_names(), vec!["كشف USD", "كشف EUR"]);
    assert_eq!(data_rows(&path, "كشف EUR").len(), 1);
    let after = parts(&path);
    let ct = String::from_utf8_lossy(&after["[Content_Types].xml"]).to_string();
    assert!(ct.contains("/xl/worksheets/sheet2.xml") && ct.contains("/xl/tables/table2.xml"));
    assert!(String::from_utf8_lossy(&after["xl/tables/table2.xml"]).contains("name=\"Statement_EUR\""));
    assert!(String::from_utf8_lossy(&after["xl/worksheets/sheet2.xml"]).contains("rightToLeft=\"1\""));
    for (name, bytes) in &before {
        let owned = [
            "xl/worksheets/sheet1.xml",
            "xl/tables/table1.xml",
            "xl/workbook.xml",
            "xl/styles.xml",
            "xl/_rels/workbook.xml.rels",
            "[Content_Types].xml",
        ];
        if !owned.contains(&name.as_str()) {
            assert_eq!(after.get(name), Some(bytes), "untouched part changed: {name}");
        }
    }
    if let Ok(dir) = std::env::var("DUMP_DIR") {
        std::fs::copy(&path, Path::new(&dir).join("statement2.xlsx")).unwrap();
    }
}

#[test]
fn linking_checks_the_customer_and_delete_keeps_the_file() {
    let h = harness();
    let a = h.customer("Ali", 2500);
    let b = h.customer("Omar", 2500);
    let path = h.dir.path().join("ali.xlsx");
    h.core.customer_excel_create(a.id, &path.display().to_string(), false).unwrap();
    assert_eq!(code(h.core.customer_excel_link(b.id, &path.display().to_string())), ErrorCode::ExcelLayout);
    let plain = h.dir.path().join("plain.xlsx");
    let mut wb = rust_xlsxwriter::Workbook::new();
    wb.add_worksheet();
    wb.save(&plain).unwrap();
    assert_eq!(code(h.core.customer_excel_link(a.id, &plain.display().to_string())), ErrorCode::ExcelLayout);
    h.core.customer_excel_unlink(a.id).unwrap();
    assert!(h.core.customer_excel_get(a.id).unwrap().is_none());
    let linked = h.core.customer_excel_link(a.id, &path.display().to_string()).unwrap();
    assert_eq!(linked.path, path.display().to_string());
    assert!(h.core.customer_excel_set_default(a.id, true).unwrap().add_to_excel_by_default);
    assert_eq!(code(h.core.customer_excel_set_default(b.id, true)), ErrorCode::NoExportPath);
    assert_eq!(code(h.core.customer_excel_add(b.id, &[])), ErrorCode::NoExportPath);

    h.core.customer_delete(a.id, "Ali").unwrap();
    assert!(path.exists(), "the file is never deleted");
    let conn = Connection::open(h.core.db_path()).unwrap();
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM customer_excel", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}
