//! SPEC §6.8.2: layout of the customer's Excel statement and the surgical writer that appends
//! lines to it. One sheet per currency ("كشف USD") with a header block of formulas (the eight
//! figures of §4.8) above an Excel Table `Statement_USD` whose rows are transfers (له), payouts
//! (عليه) and other ledger lines, with a running-balance formula.
//!
//! The hidden key column identifies every line: `T:{PayPal id}` transfer, `P:{payout id}` linked
//! payout, `U:{entry}` payout without transfers, `R:{entry}` refund return, `X:{entry}` reversal
//! of a payout, `L:{entry}` any other entry. The prefixes let the header formulas tell the lines
//! apart; the file's key column is what decides duplicates.

use super::append::{
    append_rows, apply_sheet, extend_table, patch_workbook_xml, program_cell, remove_calc_chain, sheet_tables,
    AppendCtx, Fitter, NewRow, TableInfo,
};
use super::model::{self, Keep, MCell, RowB, SheetModel, St, TxnCells, V};
use super::xlsx::{
    self, add_sheet, col_name, layout, rels_of, resolve, shared_strings, workbook_info, CellValue, LResult, NewTable,
    Package, SheetDoc, StylesDoc,
};
use chrono::NaiveDate;
use std::collections::{BTreeMap, HashSet};

pub const HEADERS: [&str; 18] = [
    "#",
    "التاريخ",
    "البيان",
    "المبلغ الكامل من PayPal",
    "خصم PayPal",
    "الصافي من PayPal",
    "العمولة %",
    "قيمة العمولة",
    "له",
    "عليه",
    "الرصيد",
    "تم الإرسال؟",
    "طريقة الدفع",
    "المنصة/البنك",
    "الشبكة",
    "المرجع / رقم العملية",
    "ملاحظات",
    "مفتاح",
];
pub const C_SEQ: u16 = 0;
pub const C_DATE: u16 = 1;
pub const C_LABEL: u16 = 2;
pub const C_GROSS: u16 = 3;
pub const C_FEE: u16 = 4;
pub const C_NET: u16 = 5;
pub const C_PCT: u16 = 6;
pub const C_COMMISSION: u16 = 7;
pub const C_CREDIT: u16 = 8;
pub const C_DEBIT: u16 = 9;
pub const C_BALANCE: u16 = 10;
pub const C_SENT: u16 = 11;
pub const C_METHOD: u16 = 12;
pub const C_PLATFORM: u16 = 13;
pub const C_NETWORK: u16 = 14;
pub const C_REF: u16 = 15;
pub const C_NOTES: u16 = 16;
pub const C_KEY: u16 = 17;
const WIDTHS: [f64; 18] =
    [7.0, 12.0, 38.0, 14.0, 11.0, 14.0, 10.0, 12.0, 13.0, 13.0, 14.0, 16.0, 13.0, 14.0, 9.0, 22.0, 24.0, 12.0];
/// 0-based row of the table header; data starts on the next row.
pub const HEADER_ROW: u32 = 12;
/// Calm fill of payout rows.
pub const PAYOUT_FILL: u32 = 0xEAF3EA;
pub const LAST_UPDATED: &str = "آخر تحديث";

pub fn sheet_name(currency: &str) -> String {
    format!("كشف {currency}")
}

pub fn table_name(currency: &str) -> String {
    format!("Statement_{currency}")
}

/// One line of the statement, before it is placed on a row.
#[derive(Debug, Clone)]
pub struct Line {
    pub key: String,
    /// Keys an earlier version may have written for the same line (duplicate check only).
    pub alt_keys: Vec<String>,
    pub currency: String,
    pub date: NaiveDate,
    /// Statement order (SPEC 6.8.3): the ledger entry's date and id.
    pub order: (NaiveDate, i64),
    /// Program cells except the running balance (filled in when the row is known).
    pub cells: Vec<(u16, Option<V>, St)>,
    pub fill: bool,
    /// Cells of rows already in the sheet to bring up to date (a payout's transfers, its own
    /// details row, a cancelled payout).
    pub marks: Vec<Mark>,
}

/// One cell of an existing row, found by its key (exactly, or as `{key}:…` when `prefix`).
#[derive(Debug, Clone)]
pub struct Mark {
    pub key: String,
    pub prefix: bool,
    pub col: u16,
    pub value: V,
}

impl Mark {
    fn matches(&self, k: &str) -> bool {
        k == self.key || (self.prefix && k.starts_with(&format!("{}:", self.key)))
    }
}

/// The running balance of row `r` (1-based) with data starting at `first`.
fn balance_formula(cols: &[u32], first: u32, r: u32) -> String {
    let c = col_name(cols[C_CREDIT as usize]);
    let d = col_name(cols[C_DEBIT as usize]);
    format!("SUM({c}${first}:{c}{r})-SUM({d}${first}:{d}{r})")
}

/// The eight figures of SPEC 4.8 as formulas over the statement table. Reversal rows (keys
/// starting with "-") cancel the line they reverse; "X:" are payout reversals written by 0.5.0.
pub fn figures(currency: &str) -> Vec<(&'static str, String, St)> {
    let t = table_name(currency);
    let col = |name: &str| format!("{t}[{name}]");
    let money = St::money(currency, true);
    let (k, c, d, s) = (col("مفتاح"), col("له"), col("عليه"), col("تم الإرسال؟"));
    let sumifs = |what: &str, prefix: &str| format!("SUMIFS({what},{k},\"{prefix}*\")");
    let count = |prefix: &str| format!("COUNTIFS({k},\"{prefix}*\")");
    let txn_count = format!("({}-{})", count("T:"), count("-T:"));
    let paid = format!("COUNTIFS({k},\"T:*\",{s},\"نعم*\")");
    vec![
        (
            "الصافي المكتمل",
            format!("{}-{}-{}+{}", sumifs(&c, "T:"), sumifs(&d, "-T:"), sumifs(&d, "R:"), sumifs(&c, "-R:")),
            money,
        ),
        (
            "المُرسل",
            format!(
                "{}+{}-{}-{}-{}",
                sumifs(&d, "P:"),
                sumifs(&d, "U:"),
                sumifs(&c, "-P:"),
                sumifs(&c, "-U:"),
                sumifs(&c, "X:")
            ),
            money,
        ),
        ("المتبقي", format!("SUM({c})-SUM({d})"), money),
        ("غير مدفوع", format!("{txn_count}-{paid}"), St::Int),
        (
            "المبلغ قبل العمولة",
            format!("{}-{}", sumifs(&col("الصافي من PayPal"), "T:"), sumifs(&col("الصافي من PayPal"), "-T:")),
            money,
        ),
        (
            "إجمالي العمولة",
            format!("{}-{}", sumifs(&col("قيمة العمولة"), "T:"), sumifs(&col("قيمة العمولة"), "-T:")),
            money,
        ),
        ("عدد المعاملات", txn_count.clone(), St::Int),
        ("عدد المدفوع", paid, St::Int),
    ]
}

fn header_block(customer: &str, currency: &str, today: NaiveDate) -> Vec<RowB> {
    let figures = figures(currency);
    let mut rows = vec![];
    let mut title = RowB::default();
    title.str(0, &format!("كشف حساب — {customer}"), St::Bold);
    rows.push(title);
    let mut cur = RowB::default();
    cur.str(C_LABEL, "العملة", St::Bold).str(C_GROSS, currency, St::Bold);
    rows.push(cur);
    for (label, formula, st) in figures {
        let mut r = RowB::default();
        r.str(C_LABEL, label, St::Bold).formula(C_GROSS, &formula, st);
        rows.push(r);
    }
    let mut upd = RowB::default();
    upd.str(C_LABEL, LAST_UPDATED, St::Bold).date(C_GROSS, Some(today));
    rows.push(upd);
    rows.push(RowB::default());
    rows
}

/// A statement sheet as a model: header block, table header and `lines` from the first data row.
pub fn sheet_model(customer: &str, currency: &str, today: NaiveDate, lines: &[Line]) -> SheetModel {
    let mut m = SheetModel {
        name: sheet_name(currency),
        rows: vec![],
        header_row: HEADER_ROW,
        filter_last: HEADER_ROW,
        cols: HEADERS.len() as u16,
        widths: WIDTHS.to_vec(),
        table: Some(table_name(currency)),
        hidden: vec![C_KEY],
    };
    for r in header_block(customer, currency, today) {
        m.push_extra(r);
    }
    let mut head = RowB::default();
    for (i, h) in HEADERS.iter().enumerate() {
        head.str(i as u16, h, St::Header);
    }
    m.push_extra(head);
    let cols: Vec<u32> = (1..=HEADERS.len() as u32).collect();
    let first = HEADER_ROW + 2;
    for (k, line) in lines.iter().enumerate() {
        let r = first + k as u32;
        let mut row = RowB::default();
        for (c, v, st) in &line.cells {
            if let Some(v) = v {
                row.0.push(MCell { col: *c, v: v.clone(), st: *st, fill: None });
            }
        }
        row.formula(C_BALANCE, &balance_formula(&cols, first, r), St::money(currency, false));
        if line.fill {
            row.fill_all(PAYOUT_FILL, C_KEY);
        }
        m.push(row);
    }
    m
}

/// Keys and the last line's date (Excel serial) of an existing statement sheet.
pub struct Existing {
    pub keys: HashSet<String>,
    pub last_date: Option<f64>,
}

struct Found {
    sheet_path: String,
    doc: SheetDoc,
    table: TableInfo,
    cols: Vec<u32>,
    header_row: u32,
    last_key_row: u32,
}

fn find_statement(pkg: &mut Package, sst: &[String], currency: &str) -> LResult<Option<Found>> {
    let wb = workbook_info(pkg)?;
    let Some(sheet) = wb.sheets.iter().find(|s| s.name == sheet_name(currency)).cloned() else { return Ok(None) };
    let doc = SheetDoc::parse(pkg.read(&sheet.path)?.ok_or_else(|| layout("ورقة الكشف تالفة."))?)?;
    let tname = table_name(currency);
    let tables = sheet_tables(pkg, &sheet.path, &doc)?;
    let table = tables
        .into_iter()
        .find(|t| t.root.attr("name") == Some(tname.as_str()) || t.root.attr("displayName") == Some(tname.as_str()))
        .ok_or_else(|| {
            layout(format!(
                "لم أجد جدول «{tname}» في ورقة «{}». لا تحذف الجدول ولا تغيّر اسمه، أو أنشئ ملفاً جديداً للعميل.",
                sheet.name
            ))
        })?;
    if table.root.attr("totalsRowCount").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0) > 0 {
        return Err(layout("جدول الكشف فيه صف إجمالي (Total Row). أخفِه من «تصميم الجدول» ثم أعد المحاولة."));
    }
    let header_row = table.from.1;
    let header = doc.row(header_row).ok_or_else(|| layout("صف عناوين جدول الكشف مفقود."))?;
    let mut cols = vec![];
    for h in HEADERS {
        let c = header.cells.iter().find(|c| c.value(sst) == CellValue::Str(h.to_string())).map(|c| c.col).ok_or_else(
            || layout(format!("لم أجد عمود «{h}» في جدول الكشف في ورقة «{}». أعد العنوان كما كان.", sheet.name)),
        )?;
        cols.push(c);
    }
    let key_col = cols[C_KEY as usize];
    let last_key_row = doc
        .rows
        .iter()
        .filter(|r| r.r > header_row)
        .filter(|r| matches!(r.cell(key_col).map(|c| c.value(sst)), Some(CellValue::Str(s)) if !s.trim().is_empty()))
        .map(|r| r.r)
        .max()
        .unwrap_or(header_row);
    Ok(Some(Found { sheet_path: sheet.path, doc, table, cols, header_row, last_key_row }))
}

/// Keys already in each currency sheet of the file (for duplicates and the preview).
pub fn existing(bytes: Vec<u8>, currencies: &[String]) -> LResult<BTreeMap<String, Existing>> {
    let mut pkg = Package::open(bytes)?;
    let sst = shared_strings(&mut pkg)?;
    let mut out = BTreeMap::new();
    for cur in currencies {
        let mut e = Existing { keys: HashSet::new(), last_date: None };
        if let Some(f) = find_statement(&mut pkg, &sst, cur)? {
            let key_col = f.cols[C_KEY as usize];
            let date_col = f.cols[C_DATE as usize];
            for r in f.doc.rows.iter().filter(|r| r.r > f.header_row) {
                if let Some(CellValue::Str(k)) = r.cell(key_col).map(|c| c.value(&sst)) {
                    if !k.trim().is_empty() {
                        e.keys.insert(k.trim().to_string());
                    }
                }
            }
            e.last_date = f.doc.row(f.last_key_row).and_then(|r| r.cell(date_col)).and_then(|c| {
                if let CellValue::Num(n) = c.value(&sst) {
                    Some(n)
                } else {
                    None
                }
            });
        }
        out.insert(cur.clone(), e);
    }
    Ok(out)
}

/// Append `lines` (grouped by currency, already without duplicates) to the statement, create
/// missing currency sheets, mark covered transfers as sent, and stamp "آخر تحديث".
pub fn append_lines(
    bytes: Vec<u8>,
    customer: &str,
    today: NaiveDate,
    lines: &BTreeMap<String, Vec<Line>>,
    marks: &BTreeMap<String, Vec<Mark>>,
) -> LResult<(Vec<u8>, Vec<String>)> {
    let mut pkg = Package::open(bytes)?;
    let wb = workbook_info(&mut pkg)?;
    let sst = shared_strings(&mut pkg)?;
    let wb_rels = rels_of(&mut pkg, "xl/workbook.xml")?;
    let styles_path = wb_rels
        .iter()
        .find(|r| r.typ.ends_with("/styles"))
        .map(|r| resolve("xl/workbook.xml", &r.target))
        .ok_or_else(|| layout("ملف Excel بلا أنماط (styles)."))?;
    let mut styles = StylesDoc::parse(pkg.read(&styles_path)?.ok_or_else(|| layout("ملف Excel بلا أنماط."))?)?;
    let mut sheets = vec![];
    let existing_tables: Vec<String> = xlsx::table_names(&mut pkg)?.into_iter().map(|(_, n)| n).collect();
    let empty: Vec<Line> = vec![];
    let currencies: std::collections::BTreeSet<&String> = lines
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(c, _)| c)
        .chain(marks.iter().filter(|(_, v)| !v.is_empty()).map(|(c, _)| c))
        .collect();
    for currency in currencies {
        let batch = lines.get(currency).unwrap_or(&empty);
        let mut cur_marks: Vec<&Mark> = marks.get(currency).map(|m| m.iter().collect()).unwrap_or_default();
        cur_marks.extend(batch.iter().flat_map(|l| l.marks.iter()));
        match find_statement(&mut pkg, &sst, currency)? {
            None if batch.is_empty() => continue,
            Some(f) => {
                sheets.push(sheet_name(currency));
                let mut fitter = Fitter::new(&mut styles);
                let fill = if batch.iter().any(|l| l.fill) {
                    let fid = fitter.styles.solid_fill(&format!("FF{PAYOUT_FILL:06X}"));
                    Some(fid)
                } else {
                    None
                };
                let first_data = f.header_row + 1;
                let first_new = f.last_key_row + 1;
                let rows: Vec<NewRow> = batch
                    .iter()
                    .enumerate()
                    .map(|(k, l)| {
                        let r = first_new + k as u32;
                        let mut cells: TxnCells = l.cells.clone();
                        cells.push((
                            C_BALANCE,
                            Some(V::Formula(balance_formula(&f.cols, first_data, r))),
                            St::money(currency, false),
                        ));
                        if l.fill {
                            for c in 0..C_KEY {
                                if !cells.iter().any(|x| x.0 == c) {
                                    cells.push((c, Some(V::Blank), St::Text));
                                }
                            }
                        }
                        NewRow { cells, fill: if l.fill { fill } else { None } }
                    })
                    .collect();
                let what = format!("ورقة «{}»", sheet_name(currency));
                let ctx = AppendCtx {
                    doc: &f.doc,
                    cols: &f.cols,
                    header_row: f.header_row,
                    table: Some(&f.table),
                    date1904: wb.date1904,
                    what: &what,
                };
                let mut row_edits: BTreeMap<u32, BTreeMap<u32, String>> = BTreeMap::new();
                // Cells of rows already in the sheet (a payout's transfers, its own details, a
                // cancelled payout): only where the value differs.
                let key_col = f.cols[C_KEY as usize];
                for row in f.doc.rows.iter().filter(|r| r.r > f.header_row) {
                    let Some(CellValue::Str(k)) = row.cell(key_col).map(|c| c.value(&sst)) else { continue };
                    let k = k.trim();
                    for m in cur_marks.iter().filter(|m| m.matches(k)) {
                        let col = f.cols[m.col as usize];
                        let cell = row.cell(col);
                        let current = cell.map(|c| c.value(&sst)).unwrap_or(CellValue::Empty);
                        let differs = match &m.value {
                            V::Str(t) => current != CellValue::Str(t.clone()),
                            V::Blank => current != CellValue::Empty,
                            v => model::value_number(v, wb.date1904)
                                .is_none_or(|n| !matches!(current, CellValue::Num(x) if (x - n).abs() < 1e-9)),
                        };
                        if differs {
                            let x =
                                program_cell(col, row.r, cell.and_then(|c| c.s), &Some(m.value.clone()), wb.date1904);
                            row_edits.entry(row.r).or_default().insert(col, x);
                        }
                    }
                }
                // Header-block formulas, current definitions without a cached value, so every
                // spreadsheet program (not only Excel, which recalculates on open) shows them.
                let defs = figures(currency);
                for row in f.doc.rows.iter().filter(|r| r.r < f.header_row) {
                    for c in &row.cells {
                        let CellValue::Str(label) = c.value(&sst) else { continue };
                        if let Some((_, formula, _)) = defs.iter().find(|(l, _, _)| *l == label.trim()) {
                            let col = c.col + 1;
                            let s = row.cell(col).and_then(|x| x.s);
                            row_edits.entry(row.r).or_default().insert(col, xlsx::cell_formula(col, row.r, s, formula));
                        }
                    }
                }
                // "آخر تحديث" in the header block.
                for row in f.doc.rows.iter().filter(|r| r.r < f.header_row) {
                    if let Some(label) = row.cells.iter().find(|c| c.value(&sst) == CellValue::Str(LAST_UPDATED.into()))
                    {
                        let col = label.col + 1;
                        let s = row.cell(col).and_then(|c| c.s);
                        let s = fitter.fit(s, St::Date);
                        row_edits
                            .entry(row.r)
                            .or_default()
                            .insert(col, program_cell(col, row.r, s, &Some(V::Date(today)), wb.date1904));
                    }
                }
                let (new_rows, owner_cols, last_row) =
                    append_rows(&ctx, &mut fitter, f.last_key_row, &rows, &mut row_edits)?;
                drop(fitter);
                let (xml, _) = apply_sheet(&ctx, &row_edits, &new_rows, last_row, &owner_cols);
                pkg.put(&f.sheet_path, xml);
                extend_table(&mut pkg, &f.table, last_row);
            }
            None => {
                sheets.push(sheet_name(currency));
                let tname = table_name(currency);
                if existing_tables.contains(&tname) {
                    return Err(layout(format!("يوجد في الملف جدول آخر اسمه «{tname}». غيّر اسمه ثم أعد المحاولة.")));
                }
                let m = sheet_model(customer, currency, today, batch);
                let keep = Keep { sheet_pr: None, tab_selected: false, tail: vec![] };
                let xml = model::render_xml(&m, &mut styles, wb.date1904, &keep, Some("rId1"));
                let last = (m.filter_last.max(m.header_row + 1)) + 1;
                let table = NewTable {
                    name: tname,
                    range: format!("A{}:{}{last}", HEADER_ROW + 1, col_name(HEADERS.len() as u32)),
                    columns: HEADERS.iter().map(|h| h.to_string()).collect(),
                    style: "TableStyleLight9".into(),
                };
                add_sheet(&mut pkg, &m.name, xml, Some(&table))?;
            }
        }
    }
    let wb_xml = pkg.read("xl/workbook.xml")?.ok_or_else(|| layout("workbook.xml مفقود."))?;
    pkg.put("xl/workbook.xml", patch_workbook_xml(&wb_xml, &[])?);
    remove_calc_chain(&mut pkg)?;
    if styles.is_changed() {
        pkg.put(&styles_path, styles.serialize());
    }
    let bytes = pkg.finish().map_err(|e| layout(format!("تعذّر بناء الملف: {e}")))?;
    Ok((bytes, sheets))
}
