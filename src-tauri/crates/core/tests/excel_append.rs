//! SPEC §6.8.1: "append" mode keeps everything the owner wrote in the main Excel file.
//!
//! The owner's workbook is built here with an independent writer (rust_xlsxwriter, as Excel
//! would save it): an extra column inside the table with a formula, a fill, a note, conditional
//! formats (incl. an Excel 2010 data bar), data validation, a sparkline, the owner's own sheet with
//! a table, a chart and a named range. After the update every part PpFeez does not own must be
//! byte-identical.

mod common;

use calamine::{open_workbook, Data, Reader, Xlsx};
use common::{code, harness};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::excel::model::NOTE;
use ppfeez_core::settings::{ExcelMode, SettingsPatch};
use ppfeez_core::transactions::Transaction;
use rust_xlsxwriter::{
    Chart, ChartType, Color, ConditionalFormatCell, ConditionalFormatCellRule, ConditionalFormatDataBar,
    DataValidation, Format, Note, Sparkline, Table, TableColumn, Workbook,
};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

const HEADERS: [&str; 17] = [
    "التاريخ",
    "رقم PayPal",
    "النوع",
    "المرسل",
    "الإيميل",
    "ملاحظة المرسل",
    "العملة",
    "الأصلي",
    "الرسوم",
    "الصافي",
    "العميل",
    "العمولة %",
    "العمولة",
    "للعميل",
    "الحالة",
    "البريد",
    "ملاحظة المدير",
];

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

fn text(parts: &BTreeMap<String, Vec<u8>>, name: &str) -> String {
    String::from_utf8(parts[name].clone()).unwrap()
}

fn rows(path: &Path, sheet: &str) -> Vec<Vec<Data>> {
    let mut wb: Xlsx<_> = open_workbook(path).unwrap();
    wb.worksheet_range(sheet).unwrap().rows().map(|r| r.to_vec()).collect()
}

fn s(d: &Data) -> String {
    match d {
        Data::String(s) => s.clone(),
        Data::Empty => String::new(),
        other => format!("{other:?}"),
    }
}

fn row_of<'a>(rows: &'a [Vec<Data>], id: &str) -> &'a Vec<Data> {
    rows.iter().find(|r| r.iter().any(|c| s(c) == id)).unwrap_or_else(|| panic!("{id} not found"))
}

/// The owner's file: our layout plus their additions. `rows` = transactions already in it.
fn owner_workbook(path: &Path, txns: &[&Transaction]) {
    let mut wb = Workbook::new();
    let usd = Format::new().set_num_format("#,##0.00");
    let header = Format::new().set_bold();
    {
        let ws = wb.add_worksheet().set_name("الملخص").unwrap();
        ws.set_right_to_left(true);
        ws.write_string(0, 0, "قديم").unwrap();
    }
    {
        let ws = wb.add_worksheet().set_name("المعاملات").unwrap();
        ws.set_right_to_left(true);
        let mut cols: Vec<TableColumn> =
            HEADERS.iter().map(|h| TableColumn::new().set_header(*h).set_header_format(&header)).collect();
        cols.push(TableColumn::new().set_header("ملاحظاتي"));
        cols.push(TableColumn::new().set_header("ضعف").set_formula("[@الأصلي]*2"));
        for (r, t) in txns.iter().enumerate() {
            let r = r as u32 + 1;
            ws.write_string(r, 0, "2026-11-20").unwrap();
            ws.write_string(r, 1, &t.paypal_txn_id).unwrap();
            ws.write_string(r, 2, "دفعة").unwrap();
            ws.write_string(r, 6, &t.currency).unwrap();
            ws.write_number_with_format(r, 7, t.gross_minor as f64 / 100.0, &usd).unwrap();
            ws.write_string(r, 14, "قديمة").unwrap(); // out of date: PpFeez rewrites it
                                                      // An A1 formula column right of the table: filled down with shifted rows.
            ws.write_formula(r, 19, format!("=H{}*2", r + 1).as_str()).unwrap();
        }
        let yellow = Format::new().set_background_color(Color::Yellow);
        ws.write_string_with_format(1, 17, "اتصل به غداً", &yellow).unwrap();
        ws.write_string_with_format(2, 17, "", &yellow).unwrap();
        ws.insert_note(1, 1, &Note::new("دفع مبكراً")).unwrap();
        let last = txns.len() as u32;
        ws.add_table(0, 0, last, 18, &Table::new().set_name("Transactions").set_columns(&cols)).unwrap();
        ws.add_conditional_format(
            1,
            7,
            100,
            7,
            &ConditionalFormatCell::new()
                .set_rule(ConditionalFormatCellRule::GreaterThan(60))
                .set_format(Format::new().set_font_color(Color::Red)),
        )
        .unwrap();
        ws.add_conditional_format(1, 7, 100, 7, &ConditionalFormatDataBar::new()).unwrap();
        ws.add_data_validation(1, 17, 100, 17, &DataValidation::new().allow_list_strings(&["تم", "لاحقاً"]).unwrap())
            .unwrap();
        ws.add_sparkline(0, 25, &Sparkline::new().set_range(("المعاملات", 1, 7, 2, 7))).unwrap();
        ws.set_column_width(17, 30).unwrap();
        ws.set_freeze_panes(1, 0).unwrap();
    }
    for name in ["العملاء", "الدفتر"] {
        let ws = wb.add_worksheet().set_name(name).unwrap();
        ws.set_right_to_left(true);
        ws.write_string(0, 0, "قديم").unwrap();
    }
    {
        let ws = wb.add_worksheet().set_name("حساباتي").unwrap();
        ws.set_right_to_left(true);
        ws.write_string(0, 0, "مجموع").unwrap();
        ws.write_formula(0, 1, "=SUM(Transactions[الأصلي])").unwrap();
        ws.write_string(2, 0, "أ").unwrap();
        ws.write_number(2, 1, 5.0).unwrap();
        ws.write_string(3, 0, "ب").unwrap();
        ws.write_number(3, 1, 7.0).unwrap();
        ws.add_table(1, 0, 3, 1, &Table::new().set_name("Mine")).unwrap();
        let mut chart = Chart::new(ChartType::Column);
        chart.add_series().set_values("='حساباتي'!$B$3:$B$4");
        ws.insert_chart(6, 0, &chart).unwrap();
    }
    wb.define_name("مبالغي", "='حساباتي'!$B$3:$B$4").unwrap();
    wb.save(path).unwrap();
}

fn use_path(h: &common::Harness, path: &Path) {
    h.core
        .update_settings(SettingsPatch {
            excel_export_path: Some(Some(path.display().to_string())),
            ..Default::default()
        })
        .unwrap();
}

fn sheet_part(parts: &BTreeMap<String, Vec<u8>>, name: &str) -> String {
    let wb = text(parts, "xl/workbook.xml");
    let rels = text(parts, "xl/_rels/workbook.xml.rels");
    let at = wb.find(&format!("name=\"{name}\"")).unwrap();
    let rid_at = wb[at..].find("r:id=\"").unwrap() + at + 6;
    let rid = &wb[rid_at..rid_at + wb[rid_at..].find('"').unwrap()];
    let r = rels.find(&format!("Id=\"{rid}\"")).unwrap();
    let rel = &rels[rels[..r].rfind('<').unwrap()..r + rels[r..].find('>').unwrap()];
    let t = rel.find("Target=\"").unwrap() + 8;
    format!("xl/{}", rel[t..t + rel[t..].find('"').unwrap()].trim_start_matches("/xl/"))
}

#[test]
fn append_keeps_the_owner_edits_and_adds_only_new_transactions() {
    let h = harness();
    let c = h.customer("أحمد", 2500);
    let a = h.manual("USD", "100.00", Some("5.00"));
    h.core.txn_assign(a.id, c.id, None, true).unwrap();
    let b = h.manual("USD", "50.00", Some("0"));
    let new_usd = h.manual("USD", "12.00", Some("0"));
    let new_jpy = h.manual("JPY", "5000", Some("0"));
    let path = h.dir.path().join("owner.xlsx");
    owner_workbook(&path, &[&a, &b]);
    let before_bytes = std::fs::read(&path).unwrap();
    let before = parts(&path);
    use_path(&h, &path);

    let r = h.core.excel_update().unwrap();
    if let Ok(d) = std::env::var("DUMP_DIR") {
        std::fs::copy(&path, Path::new(&d).join("after.xlsx")).unwrap();
        std::fs::write(Path::new(&d).join("before.xlsx"), &before_bytes).unwrap();
    }
    assert_eq!((r.added, r.updated, r.created), (2, 2, false), "{r:?}");
    assert_eq!(r.sheets, 5);

    // .previous.xlsx is the file as it was.
    let prev = path.with_file_name("owner.previous.xlsx");
    assert_eq!(std::fs::read(&prev).unwrap(), before_bytes);

    // Every part PpFeez does not own is byte-identical; nothing disappeared.
    let after = parts(&path);
    let txn_sheet = sheet_part(&before, "المعاملات");
    let owned: Vec<String> = vec![
        txn_sheet.clone(),
        sheet_part(&before, "الملخص"),
        sheet_part(&before, "العملاء"),
        sheet_part(&before, "الدفتر"),
        "xl/workbook.xml".into(),
        "xl/styles.xml".into(),
        "xl/tables/table1.xml".into(),
    ];
    for (name, bytes) in &before {
        let Some(new) = after.get(name) else { panic!("part lost: {name}") };
        if !owned.contains(name) {
            assert_eq!(new, bytes, "untouched part changed: {name}");
        }
    }
    assert!(after.keys().all(|k| before.contains_key(k)), "no parts added");
    assert!(before.contains_key("xl/tables/table2.xml"), "the owner's table is kept");
    assert!(after.keys().any(|k| k.starts_with("xl/charts/")), "chart kept");
    assert!(after.keys().any(|k| k.starts_with("xl/comments")), "note kept");

    // RTL on every sheet, and the transactions sheet keeps its Excel 2010 extensions.
    for (name, b) in &after {
        if name.starts_with("xl/worksheets/sheet") {
            assert!(String::from_utf8_lossy(b).contains("rightToLeft=\"1\""), "{name} not RTL");
        }
    }
    let old_sheet = text(&before, &txn_sheet);
    let new_sheet = text(&after, &txn_sheet);
    assert!(old_sheet.matches("<x14:").count() > 0);
    assert_eq!(old_sheet.matches("<x14:").count(), new_sheet.matches("<x14:").count(), "sparkline / data bar kept");
    assert_eq!(
        old_sheet.matches("<conditionalFormatting").count(),
        new_sheet.matches("<conditionalFormatting").count()
    );
    assert!(new_sheet.contains("<dataValidations"));
    assert!(text(&after, "xl/workbook.xml").contains("fullCalcOnLoad=\"1\""));
    assert!(text(&after, "xl/workbook.xml").contains("مبالغي"), "defined name kept");

    // Values: updated program columns, owner's column untouched, new rows appended at the end.
    let tx = rows(&path, "المعاملات");
    assert_eq!(tx.len(), 5, "header + 2 old + 2 new");
    let ra = row_of(&tx, &a.paypal_txn_id);
    assert_eq!(s(&ra[14]), "معتمدة");
    assert_eq!(s(&ra[10]), "أحمد");
    assert_eq!(s(&ra[17]), "اتصل به غداً");
    assert_eq!(s(&row_of(&tx, &b.paypal_txn_id)[14]), "غير مخصّصة");
    assert_eq!(s(&tx[3][1]), new_usd.paypal_txn_id);
    assert_eq!(s(&tx[4][1]), new_jpy.paypal_txn_id);
    assert_eq!(tx[4][7], Data::Float(5000.0));

    // The table grew; its calculated column is filled down in the new rows.
    let table = text(&after, "xl/tables/table1.xml");
    assert!(table.contains("ref=\"A1:S5\""), "{table}");
    let mut wb: Xlsx<_> = open_workbook(&path).unwrap();
    let formulas = wb.worksheet_formula("المعاملات").unwrap();
    let f: Vec<String> = formulas.rows().flat_map(|r| r.iter().filter(|x| !x.is_empty()).cloned()).collect();
    assert_eq!(f.iter().filter(|x| x.contains("[#This Row]")).count(), 4, "{f:?}");
    assert!(new_sheet.contains("<c r=\"S5\"><f>"), "calculated column filled down in the last new row");
    assert!(new_sheet.contains("<c r=\"T4\"><f>H4*2</f>"), "A1 formula shifted to its row");
    assert!(new_sheet.contains("<c r=\"T5\"><f>H5*2</f>"));
    // The owner's fill continues on the new rows (same style as the last data row).
    let style_of = |xml: &str, cell: &str| -> Option<String> {
        let at = xml.find(&format!("<c r=\"{cell}\""))?;
        let tag = &xml[at..at + xml[at..].find('>')?];
        tag.find(" s=\"").map(|p| tag[p + 4..p + 4 + tag[p + 4..].find('"').unwrap()].to_string())
    };
    assert_eq!(style_of(&new_sheet, "R4"), style_of(&new_sheet, "R3"));
    // JPY gets a 0-decimal format although the template row is USD.
    let styles = text(&after, "xl/styles.xml");
    let xf = style_of(&new_sheet, "H5").unwrap().parse::<usize>().unwrap();
    let cell_xfs = &styles[styles.find("<cellXfs").unwrap()..];
    let nth = cell_xfs.match_indices("<xf ").nth(xf).unwrap().0;
    assert!(cell_xfs[nth..].starts_with("<xf numFmtId=\"3\"") || cell_xfs[nth..nth + 200].contains("numFmtId=\"3\""));

    // Program sheets regenerated with the note row.
    let summary = rows(&path, "الملخص");
    assert_eq!(s(&summary[0][0]), NOTE);
    assert_eq!(s(&summary[1][0]), "العملة");
    let mine = rows(&path, "حساباتي");
    assert_eq!(s(&mine[0][0]), "مجموع");

    // A second update with nothing new changes nothing.
    let r = h.core.excel_update().unwrap();
    assert_eq!((r.added, r.updated), (0, 0));
    let again = parts(&path);
    assert_eq!(again[&txn_sheet], after[&txn_sheet], "transactions sheet untouched");
    assert_eq!(again["xl/styles.xml"].len(), after["xl/styles.xml"].len(), "styles do not grow");
}

#[test]
fn removed_rows_stay_removed_and_deleted_transactions_are_marked() {
    let h = harness();
    let a = h.manual("USD", "10", Some("0"));
    let b = h.manual("USD", "20", Some("0"));
    let path = h.dir.path().join("main.xlsx");
    use_path(&h, &path);
    let r = h.core.excel_update().unwrap();
    assert_eq!((r.added, r.created), (2, true));

    // The owner deletes A's row from the file (row contents removed).
    let bytes = std::fs::read(&path).unwrap();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut data = vec![];
        f.read_to_end(&mut data).unwrap();
        if name == "xl/worksheets/sheet2.xml" {
            let xml = String::from_utf8(data).unwrap();
            let start = xml.find("<row r=\"2\"").unwrap();
            let end = start + xml[start..].find("</row>").unwrap() + 6;
            data = format!("{}{}", &xml[..start], &xml[end..]).into_bytes();
        }
        out.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut out, &data).unwrap();
    }
    std::fs::write(&path, out.finish().unwrap().into_inner()).unwrap();
    assert!(!rows(&path, "المعاملات").iter().any(|r| s(&r[1]) == a.paypal_txn_id));

    h.core.txn_delete(&[b.id], Some("test")).unwrap();
    let r = h.core.excel_update().unwrap();
    assert_eq!((r.added, r.updated), (0, 1), "{r:?}");
    let tx = rows(&path, "المعاملات");
    assert!(!tx.iter().any(|r| s(&r[1]) == a.paypal_txn_id), "a removed row is not added back");
    assert_eq!(s(&row_of(&tx, &b.paypal_txn_id)[14]), "محذوفة");
}

#[test]
fn renamed_header_is_a_layout_error_and_nothing_is_written() {
    let h = harness();
    let a = h.manual("USD", "10", Some("0"));
    let path = h.dir.path().join("owner.xlsx");
    owner_workbook(&path, &[&a]);
    // Rename "الحالة" in the shared strings / cells of the file.
    let bytes = std::fs::read(&path).unwrap();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut data = vec![];
        f.read_to_end(&mut data).unwrap();
        let data = String::from_utf8_lossy(&data).replace(">الحالة<", ">وضع<").into_bytes();
        out.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut out, &data).unwrap();
    }
    let edited = out.finish().unwrap().into_inner();
    std::fs::write(&path, &edited).unwrap();
    use_path(&h, &path);
    let err = h.core.excel_update().unwrap_err();
    assert_eq!(err.code, ErrorCode::ExcelLayout);
    assert!(err.message_ar.contains("«الحالة»"), "{}", err.message_ar);
    assert_eq!(std::fs::read(&path).unwrap(), edited, "file unchanged");
    assert!(!path.with_file_name("owner.previous.xlsx").exists());

    // Not an xlsx at all.
    std::fs::write(&path, b"not a zip").unwrap();
    assert_eq!(code(h.core.excel_update()), ErrorCode::ExcelLayout);
}

#[test]
fn rewrite_mode_writes_the_file_anew() {
    let h = harness();
    let a = h.manual("USD", "10", Some("0"));
    let path = h.dir.path().join("owner.xlsx");
    owner_workbook(&path, &[&a]);
    use_path(&h, &path);
    let s =
        h.core.update_settings(SettingsPatch { excel_mode: Some(ExcelMode::Rewrite), ..Default::default() }).unwrap();
    assert_eq!(s.excel_mode, ExcelMode::Rewrite);
    let r = h.core.excel_update().unwrap();
    assert_eq!((r.created, r.added, r.sheets), (false, 1, 4));
    let wb: Xlsx<_> = open_workbook(&path).unwrap();
    assert_eq!(wb.sheet_names(), vec!["الملخص", "المعاملات", "العملاء", "الدفتر"]);
    assert!(path.with_file_name("owner.previous.xlsx").exists());
    let default = ppfeez_core::settings::Settings::clone(&h.core.get_settings().unwrap());
    assert_eq!(default.excel_mode, ExcelMode::Rewrite);
    let json = serde_json::to_value(&default).unwrap();
    assert_eq!(json["excelMode"], "rewrite");
}

#[test]
fn new_file_has_the_transactions_table_and_text_below_it_blocks_appending() {
    let h = harness();
    let path = h.dir.path().join("fresh.xlsx");
    use_path(&h, &path);
    assert_eq!(h.core.get_settings().unwrap().excel_mode, ExcelMode::Append, "append is the default");
    let r = h.core.excel_update().unwrap();
    assert_eq!((r.created, r.added), (true, 0));
    let p = parts(&path);
    let table = text(&p, "xl/tables/table1.xml");
    assert!(table.contains("name=\"Transactions\"") && table.contains("ref=\"A1:Q2\""), "{table}");

    // First transactions fill the table's empty row, then grow it.
    let a = h.manual("USD", "10", Some("0"));
    let b = h.manual("EUR", "20", Some("0"));
    let r = h.core.excel_update().unwrap();
    assert_eq!(r.added, 2);
    let tx = rows(&path, "المعاملات");
    assert_eq!((s(&tx[1][1]), s(&tx[2][1])), (a.paypal_txn_id.clone(), b.paypal_txn_id.clone()));
    assert!(text(&parts(&path), "xl/tables/table1.xml").contains("ref=\"A1:Q3\""));

    // The owner writes right under the table: new rows would land there.
    let bytes = std::fs::read(&path).unwrap();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut data = vec![];
        f.read_to_end(&mut data).unwrap();
        if name == "xl/worksheets/sheet2.xml" {
            let xml = String::from_utf8(data).unwrap();
            data = xml
                .replace(
                    "</sheetData>",
                    r#"<row r="4"><c r="C4" t="inlineStr"><is><t>المجموع</t></is></c></row></sheetData>"#,
                )
                .into_bytes();
        }
        out.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut out, &data).unwrap();
    }
    let edited = out.finish().unwrap().into_inner();
    std::fs::write(&path, &edited).unwrap();
    h.manual("USD", "30", Some("0"));
    let err = h.core.excel_update().unwrap_err();
    assert_eq!(err.code, ErrorCode::ExcelLayout);
    assert!(err.message_ar.contains("C4"), "{}", err.message_ar);
    assert_eq!(std::fs::read(&path).unwrap(), edited);
}

#[test]
fn files_from_older_versions_with_a_plain_filter_are_extended() {
    let h = harness();
    let a = h.manual("USD", "10", Some("0"));
    let b = h.manual("USD", "20", Some("0"));
    let path = h.dir.path().join("old.xlsx");
    // Layout written by 0.2.x–0.3.x: no table, an autofilter over the transactions.
    let mut wb = Workbook::new();
    for name in ["الملخص", "المعاملات", "العملاء", "الدفتر"] {
        let ws = wb.add_worksheet().set_name(name).unwrap();
        ws.set_right_to_left(true);
        if name == "المعاملات" {
            for (i, hd) in HEADERS.iter().enumerate() {
                ws.write_string(0, i as u16, *hd).unwrap();
            }
            ws.write_string(1, 1, &a.paypal_txn_id).unwrap();
            ws.autofilter(0, 0, 1, 16).unwrap();
        } else {
            ws.write_string(0, 0, "قديم").unwrap();
            ws.autofilter(0, 0, 0, 0).unwrap();
        }
    }
    wb.save(&path).unwrap();
    use_path(&h, &path);
    let r = h.core.excel_update().unwrap();
    assert_eq!((r.added, r.updated), (1, 1));
    let p = parts(&path);
    let sheet = text(&p, "xl/worksheets/sheet2.xml");
    assert!(sheet.contains(r#"<autoFilter ref="A1:Q3"/>"#), "filter extended");
    let wbx = text(&p, "xl/workbook.xml");
    assert!(wbx.contains("'المعاملات'!$A$1:$Q$3"), "{wbx}");
    assert!(wbx.contains("'الدفتر'!$A$2:$K$2"), "program sheet filter names follow the note row");
    let tx = rows(&path, "المعاملات");
    assert_eq!(s(&tx[2][1]), b.paypal_txn_id);
}

#[test]
fn large_files_update_quickly() {
    let h = harness();
    let c = h.customer("كبير", 2500);
    let path = h.dir.path().join("big.xlsx");
    use_path(&h, &path);
    for i in 0..1500 {
        let t = h.manual("USD", &format!("{}.25", 10 + i), Some("1"));
        if i % 2 == 0 {
            h.core.txn_assign(t.id, c.id, None, true).unwrap();
        }
    }
    h.core.excel_update().unwrap();
    for i in 0..300 {
        h.manual("EUR", &format!("{}", 5 + i), Some("0"));
    }
    let started = std::time::Instant::now();
    let r = h.core.excel_update().unwrap();
    assert_eq!(r.added, 300);
    assert!(started.elapsed().as_secs() < 20, "took {:?}", started.elapsed());
    assert_eq!(rows(&path, "المعاملات").len(), 1801);
    assert_eq!(rows(&path, "الدفتر").len(), 752, "note + header + 750 credits");
}
