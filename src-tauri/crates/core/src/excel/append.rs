//! SPEC §6.8.1 "append" mode: update the owner's main workbook without losing anything they
//! wrote in it.
//!
//! - Transactions sheet: program columns are found by header name; rows are matched by PayPal
//!   id; only changed program cells are rewritten (keeping each cell's style); new transactions
//!   are appended after the last one, styled like the last data row (the owner's columns too,
//!   their formulas filled down); the table / filter range grows to cover them.
//! - Summary, customers and ledger sheets are regenerated in place.
//! - Every other part of the package is copied byte for byte.

use super::model::{self, value_number, Keep, SheetModel, St, TxnCells, DATETIME_FMT, DATE_FMT, V};
use super::xlsx::{
    self, apply_edits, cell_empty, cell_formula, cell_num, cell_str, col_name, esc, fmt_decimals, fmt_is_date, layout,
    matching_end, parse_range, range_str, rels_of, resolve, retag, shared_strings, shift_formula_rows, tokens,
    workbook_info, Cell, CellValue, Kind, LResult, Package, Row, SheetDoc, StylesDoc, Tok, WbSheet,
};
use super::{
    is_lock_error, keep_previous, save_atomic, ExcelExportResult, SHEET_CUSTOMERS, SHEET_LEDGER, SHEET_SUMMARY,
    SHEET_TRANSACTIONS, TXN_HEADERS,
};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::Core;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// Status written on a row whose transaction was deleted from PpFeez.
pub const STATUS_DELETED: &str = "محذوفة";
const COL_ID: usize = 1;
const COL_STATUS: usize = 14;

pub struct AppendInput<'a> {
    /// (PayPal id, the 17 program cells) in the order new rows are appended.
    pub txns: Vec<(String, TxnCells)>,
    /// Ids already written to this file earlier.
    pub exported: &'a HashSet<String>,
    /// Summary, customers, ledger.
    pub programs: Vec<SheetModel>,
}

pub struct Plan {
    pub bytes: Vec<u8>,
    pub added_ids: Vec<String>,
    /// Ids of PpFeez transactions found in the sheet (already exported).
    pub present_ids: Vec<String>,
    pub updated: i64,
    pub sheets: i64,
}

fn layout_err(e: xlsx::Layout) -> AppError {
    AppError::new(ErrorCode::ExcelLayout, e.0)
}

impl Core {
    pub(crate) fn excel_append(&self, path: &Path, path_key: &str) -> AppResult<ExcelExportResult> {
        let bytes = std::fs::read(path).map_err(|e| {
            if is_lock_error(&e) {
                AppError::new(ErrorCode::FileLocked, "أغلق الملف في Excel ثم أعد المحاولة")
            } else {
                super::export_failed(e)
            }
        })?;
        let (now, items, customers) = self.main_data()?;
        let exported: HashSet<String> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT paypal_txn_id FROM excel_exported WHERE file_path = ?1")?;
            let rows = stmt.query_map([path_key], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let (summary, n_summary) = self.model_summary(now)?;
        let customers_model = self.model_customers(&customers);
        let (ledger, n_ledger) = self.model_ledger()?;
        let input = AppendInput {
            txns: items.iter().map(|t| (t.paypal_txn_id.clone(), self.txn_cells(t))).collect(),
            exported: &exported,
            programs: vec![summary, customers_model, ledger],
        };
        let plan = patch_workbook(bytes, &input).map_err(layout_err)?;
        self_check(&plan).map_err(super::export_failed)?;
        keep_previous(path)?;
        save_atomic(&plan.bytes, path)?;
        let mut ids = plan.added_ids.clone();
        ids.extend(plan.present_ids.iter().cloned());
        self.record_exported(path_key, &ids, false)?;
        let rows = items.len() as i64 + customers.len() as i64 + n_summary + n_ledger;
        Ok(ExcelExportResult {
            added: plan.added_ids.len() as i64,
            updated: plan.updated,
            created: false,
            ..self.finish_result(path, plan.sheets, rows)
        })
    }
}

/// Re-read the new file with an independent reader before it replaces the old one.
fn self_check(plan: &Plan) -> Result<(), String> {
    use calamine::{Data, Reader, Xlsx};
    let mut wb: Xlsx<_> = Xlsx::new(std::io::Cursor::new(plan.bytes.clone())).map_err(|e| e.to_string())?;
    for name in [SHEET_SUMMARY, SHEET_TRANSACTIONS, SHEET_CUSTOMERS, SHEET_LEDGER] {
        wb.worksheet_range(name).map_err(|e| format!("{name}: {e}"))?;
    }
    let range = wb.worksheet_range(SHEET_TRANSACTIONS).map_err(|e| e.to_string())?;
    let found: HashSet<String> = range
        .rows()
        .flat_map(|r| r.iter())
        .filter_map(|c| match c {
            Data::String(s) => Some(s.trim().to_string()),
            _ => None,
        })
        .collect();
    if let Some(missing) = plan.added_ids.iter().find(|id| !found.contains(*id)) {
        return Err(format!("self-check: {missing} not found after writing"));
    }
    Ok(())
}

fn find_sheet<'a>(sheets: &'a [WbSheet], name: &str) -> LResult<&'a WbSheet> {
    sheets.iter().find(|s| s.name == name).ok_or_else(|| {
        layout(format!("لم أجد ورقة «{name}» في الملف. أعد اسمها كما كان أو اختر «إعادة كتابة كاملة» من الإعدادات."))
    })
}

fn same(cur: &CellValue, v: &Option<V>, date1904: bool) -> bool {
    match v {
        None | Some(V::Blank) => matches!(cur, CellValue::Empty) || *cur == CellValue::Str(String::new()),
        Some(V::Str(s)) => *cur == CellValue::Str(s.clone()),
        Some(V::Formula(_)) => false,
        Some(v) => {
            let n = value_number(v, date1904).unwrap_or(0.0);
            let tol = if matches!(v, V::DateTime(_) | V::Date(_)) { 5e-6 } else { 1e-9 * n.abs().max(1.0) };
            matches!(cur, CellValue::Num(x) if (x - n).abs() <= tol)
        }
    }
}

/// Style for a program cell: the existing / template style, with a number format added only
/// when the template's format does not fit the value (e.g. a JPY row after a USD row).
pub(crate) struct Fitter<'a> {
    pub styles: &'a mut StylesDoc,
    pub cache: HashMap<(Option<u32>, St), Option<u32>>,
}

impl Fitter<'_> {
    pub(crate) fn new(styles: &mut StylesDoc) -> Fitter<'_> {
        Fitter { styles, cache: HashMap::new() }
    }

    /// `fit`, then the row's fill when given.
    pub(crate) fn fit_fill(&mut self, base: Option<u32>, st: St, fill: Option<usize>) -> Option<u32> {
        let s = self.fit(base, st);
        match fill {
            Some(f) => Some(self.styles.with_fill(s.unwrap_or(0) as usize, f) as u32),
            None => s,
        }
    }

    pub(crate) fn fit(&mut self, base: Option<u32>, st: St) -> Option<u32> {
        if let Some(r) = self.cache.get(&(base, st)) {
            return *r;
        }
        let b = base.unwrap_or(0) as usize;
        let code = self.styles.fmt_code(self.styles.xf_num_fmt(b)).unwrap_or_else(|| "General".into());
        let derived = match st {
            St::DateTime | St::Date => {
                if fmt_is_date(&code) {
                    None
                } else {
                    Some(self.styles.num_fmt(if st == St::DateTime { DATETIME_FMT } else { DATE_FMT }))
                }
            }
            St::Pct => (!code.contains('%')).then_some(10),
            St::Money { dec0, .. } => {
                let want = if dec0 { 0 } else { 2 };
                let fits = fmt_decimals(&code) == Some(want) && !fmt_is_date(&code) && !code.contains('%');
                (!fits).then_some(if dec0 { 3 } else { 4 })
            }
            _ => None,
        };
        let r = match derived {
            Some(fmt) => Some(self.styles.derive_xf(b, fmt) as u32),
            None => base,
        };
        self.cache.insert((base, st), r);
        r
    }
}

pub(crate) fn program_cell(col: u32, row: u32, s: Option<u32>, v: &Option<V>, date1904: bool) -> String {
    match v {
        None => cell_empty(col, row, s),
        Some(V::Str(t)) => cell_str(col, row, s, t),
        Some(V::Formula(f)) => cell_formula(col, row, s, f),
        Some(V::Blank) => cell_empty(col, row, s),
        Some(v) => cell_num(col, row, s, value_number(v, date1904).unwrap_or(0.0)),
    }
}

/// `<row ...>` + cells (existing raw XML, replaced where given) + `</row>`; `spans` is dropped
/// because cells may be added outside it.
pub(crate) fn rebuild_row(xml: &str, row: &Row, replace: &BTreeMap<u32, String>) -> String {
    let mut tok = row.tok.clone();
    tok.kind = Kind::Start;
    let mut cells: BTreeMap<u32, String> = row.cells.iter().map(|c| (c.col, xml[c.start..c.end].to_string())).collect();
    for (col, x) in replace {
        cells.insert(*col, x.clone());
    }
    format!("{}{}</row>", retag(&tok, &[], &["spans"]), cells.into_values().collect::<String>())
}

/// Formula text of a cell, resolving a shared formula to its master's text and row.
pub(crate) fn formula_of(doc: &SheetDoc, cell: &Cell, row: u32) -> Option<(String, u32)> {
    let f = cell.f.as_ref()?;
    match f.t.as_deref() {
        Some("array") | Some("dataTable") => None,
        Some("shared") if f.text.is_empty() => {
            let si = f.si.as_deref()?;
            doc.rows.iter().find_map(|r| {
                r.cells.iter().find_map(|c| {
                    let m = c.f.as_ref()?;
                    (m.t.as_deref() == Some("shared") && m.si.as_deref() == Some(si) && !m.text.is_empty())
                        .then(|| (m.text.clone(), r.r))
                })
            })
        }
        _ if f.text.is_empty() => None,
        _ => Some((f.text.clone(), row)),
    }
}

pub(crate) struct TableInfo {
    pub path: String,
    pub xml: String,
    pub root: Tok,
    pub filter: Option<Tok>,
    pub from: (u32, u32),
    pub to: (u32, u32),
}

pub(crate) fn sheet_tables(pkg: &mut Package, sheet_path: &str, doc: &SheetDoc) -> LResult<Vec<TableInfo>> {
    let rels = rels_of(pkg, sheet_path)?;
    let mut out = vec![];
    for rid in &doc.table_rids {
        let Some(rel) = rels.iter().find(|r| &r.id == rid) else { continue };
        let path = resolve(sheet_path, &rel.target);
        let Some(xml) = pkg.read(&path)? else { continue };
        let toks = tokens(&xml).map_err(|_| layout("جدول Excel في ورقة المعاملات تالف."))?;
        let root = toks.first().cloned().ok_or_else(|| layout("جدول Excel في ورقة المعاملات تالف."))?;
        let Some((from, to)) = root.attr("ref").and_then(parse_range) else { continue };
        let filter = toks.iter().find(|t| t.name == "autoFilter" && t.kind != Kind::End).cloned();
        out.push(TableInfo { path, xml, root, filter, from, to });
    }
    Ok(out)
}

/// Update `_xlnm._FilterDatabase` names and force recalculation on open.
pub(crate) fn patch_workbook_xml(xml: &str, filters: &[(usize, String, String)]) -> LResult<String> {
    let toks = tokens(xml).map_err(|_| layout("workbook.xml تالف."))?;
    let mut edits = vec![];
    let mut insert_after: Option<usize> = None;
    let mut calc: Option<&Tok> = None;
    let mut depth = 0;
    let mut i = 0;
    while i < toks.len() {
        let t = &toks[i];
        if depth == 1 && t.kind != Kind::End {
            let end = matching_end(&toks, i);
            match t.name.as_str() {
                "sheets" | "functionGroups" | "externalReferences" | "definedNames" => {
                    insert_after = Some(toks[end].end)
                }
                "calcPr" => calc = Some(t),
                _ => {}
            }
            if t.name == "definedNames" {
                for j in i + 1..end {
                    let d = &toks[j];
                    if d.name == "definedName"
                        && d.kind == Kind::Start
                        && d.attr("name") == Some("_xlnm._FilterDatabase")
                    {
                        let local: Option<usize> = d.attr("localSheetId").and_then(|v| v.parse().ok());
                        if let Some((_, sheet, range)) = filters.iter().find(|f| Some(f.0) == local) {
                            let close = matching_end(&toks, j);
                            let ((c1, r1), (c2, r2)) = parse_range(range).unwrap_or(((1, 1), (1, 1)));
                            let text = format!(
                                "'{}'!${}${}:${}${}",
                                sheet.replace('\'', "''"),
                                col_name(c1),
                                r1,
                                col_name(c2),
                                r2
                            );
                            edits.push((d.end, toks[close].start, esc(&text)));
                        }
                    }
                }
            }
            i = end + 1;
            continue;
        }
        match t.kind {
            Kind::Start => depth += 1,
            Kind::End => depth -= 1,
            Kind::Empty => {}
        }
        i += 1;
    }
    match calc {
        Some(t) => edits.push((t.start, t.end, retag(t, &[("fullCalcOnLoad", "1".into())], &[]))),
        None => {
            let at = insert_after.ok_or_else(|| layout("workbook.xml تالف."))?;
            edits.push((at, at, r#"<calcPr fullCalcOnLoad="1"/>"#.into()));
        }
    }
    Ok(apply_edits(xml, edits))
}

/// Drop calcChain (Excel rebuilds it): its part, relationship and content-type override.
pub(crate) fn remove_calc_chain(pkg: &mut Package) -> LResult<()> {
    let rels_path = xlsx::rels_path("xl/workbook.xml");
    let Some(rels_xml) = pkg.read(&rels_path)? else { return Ok(()) };
    let toks = tokens(&rels_xml).map_err(|_| layout("workbook rels تالف."))?;
    let Some(t) =
        toks.iter().find(|t| t.name == "Relationship" && t.attr("Type").is_some_and(|v| v.ends_with("/calcChain")))
    else {
        return Ok(());
    };
    let part = resolve("xl/workbook.xml", t.attr("Target").unwrap_or_default());
    let i = toks.iter().position(|x| x.start == t.start).unwrap_or(0);
    let end = toks[matching_end(&toks, i)].end;
    pkg.put(&rels_path, apply_edits(&rels_xml, vec![(t.start, end, String::new())]));
    pkg.remove(&part);
    if let Some(ct) = pkg.read("[Content_Types].xml")? {
        let ctoks = tokens(&ct).map_err(|_| layout("[Content_Types].xml تالف."))?;
        let target = format!("/{part}");
        let edits: Vec<(usize, usize, String)> = ctoks
            .iter()
            .enumerate()
            .filter(|(_, x)| x.name == "Override" && x.kind != Kind::End && x.attr("PartName") == Some(target.as_str()))
            .map(|(k, x)| (x.start, ctoks[matching_end(&ctoks, k)].end, String::new()))
            .collect();
        if !edits.is_empty() {
            pkg.put("[Content_Types].xml", apply_edits(&ct, edits));
        }
    }
    Ok(())
}

/// One row to append: program cells (by program column index) and an optional fill (style
/// index of a `<fill>`) applied to every program cell of the row.
pub(crate) struct NewRow {
    pub cells: TxnCells,
    pub fill: Option<usize>,
}

/// The sheet and table rows are appended to.
pub(crate) struct AppendCtx<'a> {
    pub doc: &'a SheetDoc,
    /// Sheet column (1-based) of each program column index.
    pub cols: &'a [u32],
    pub header_row: u32,
    pub table: Option<&'a TableInfo>,
    pub date1904: bool,
    /// "ورقة المعاملات", "ورقة «كشف USD»": for messages.
    pub what: &'a str,
}

/// Build the rows appended after `last_data_row`: reused (empty) existing rows go to
/// `row_edits`; new `<row>` elements are returned with the owner's columns and the last row.
/// Each cell takes the style of the last data row in its column (format fitted to the value);
/// the owner's formulas are filled down.
pub(crate) fn append_rows(
    ctx: &AppendCtx<'_>,
    fitter: &mut Fitter<'_>,
    last_data_row: u32,
    rows: &[NewRow],
    row_edits: &mut BTreeMap<u32, BTreeMap<u32, String>>,
) -> LResult<(BTreeMap<u32, String>, Vec<u32>, u32)> {
    let doc = ctx.doc;
    let hr = ctx.header_row;
    let template: Option<&Row> = doc.row(last_data_row).filter(|r| r.r > hr).or_else(|| doc.row(hr + 1));
    let program_cols: HashSet<u32> = ctx.cols.iter().copied().collect();
    let mut owner_cols: Vec<u32> = template
        .map(|t| t.cells.iter().map(|c| c.col).filter(|c| !program_cols.contains(c)).collect())
        .unwrap_or_default();
    if let Some(t) = ctx.table {
        owner_cols.extend((t.from.0..=t.to.0).filter(|c| !program_cols.contains(c)));
    }
    owner_cols.sort_unstable();
    owner_cols.dedup();
    let mut new_rows: BTreeMap<u32, String> = BTreeMap::new();
    if rows.is_empty() {
        return Ok((new_rows, owner_cols, last_data_row));
    }
    let first_new = last_data_row + 1;
    let last_new = first_new + rows.len() as u32 - 1;
    for m in &doc.merges {
        if let Some(((_, r1), (_, r2))) = parse_range(m) {
            if r1 <= last_new && first_new <= r2 {
                return Err(layout(format!(
                    "في الصفوف {first_new}–{last_new} من {} خلايا مدمجة. ألغِ الدمج ثم أعد المحاولة.",
                    ctx.what
                )));
            }
        }
    }
    for (k, new_row) in rows.iter().enumerate() {
        let r = first_new + k as u32;
        let existing = doc.row(r);
        if let Some(row) = existing {
            if let Some(c) = row.cells.iter().find(|c| c.has_literal()) {
                return Err(layout(format!(
                    "الخلية {}{} في {} فيها كتابة أسفل آخر سطر في الجدول، والأسطر الجديدة تُضاف هناك. انقل ما كتبته إلى عمود جانبي أو إلى ورقة أخرى ثم أعد المحاولة.",
                    col_name(c.col),
                    r,
                    ctx.what
                )));
            }
        }
        let mut row_cells: BTreeMap<u32, String> = BTreeMap::new();
        for (i, v, st) in new_row.cells.iter() {
            let col = ctx.cols[*i as usize];
            let base = existing
                .and_then(|e| e.cell(col))
                .and_then(|c| c.s)
                .or_else(|| template.and_then(|t| t.cell(col)).and_then(|c| c.s));
            let s = fitter.fit_fill(base, *st, new_row.fill);
            row_cells.insert(col, program_cell(col, r, s, v, ctx.date1904));
        }
        for &col in &owner_cols {
            if existing.and_then(|e| e.cell(col)).is_some() {
                continue;
            }
            let Some(tc) = template.and_then(|t| t.cell(col)) else {
                continue;
            };
            let formula = template.and_then(|t| formula_of(doc, tc, t.r));
            match formula {
                Some((text, from_row)) => {
                    let shifted = shift_formula_rows(&text, r as i64 - from_row as i64);
                    row_cells.insert(col, cell_formula(col, r, tc.s, &shifted));
                }
                None if tc.s.is_some() => {
                    row_cells.insert(col, cell_empty(col, r, tc.s));
                }
                None => {}
            }
        }
        match existing {
            Some(_) => {
                row_edits.entry(r).or_default().extend(row_cells);
            }
            None => {
                let mut attrs = String::new();
                if let Some(t) = template {
                    for key in ["s", "customFormat", "ht", "customHeight"] {
                        if let Some(v) = t.tok.attr(key) {
                            attrs.push_str(&format!(" {key}=\"{}\"", xlsx::esc_attr(v)));
                        }
                    }
                }
                new_rows
                    .insert(r, format!(r#"<row r="{r}"{attrs}>{}</row>"#, row_cells.into_values().collect::<String>()));
            }
        }
    }
    Ok((new_rows, owner_cols, last_new))
}

/// The sheet XML with the row edits and new rows applied, the dimension grown, and (without a
/// table) the sheet's autofilter extended; returns the new filter range when it changed.
pub(crate) fn apply_sheet(
    ctx: &AppendCtx<'_>,
    row_edits: &BTreeMap<u32, BTreeMap<u32, String>>,
    new_rows: &BTreeMap<u32, String>,
    last_row: u32,
    owner_cols: &[u32],
) -> (String, Option<String>) {
    let doc = ctx.doc;
    let xml = doc.xml.as_str();
    let mut edits: Vec<(usize, usize, String)> = vec![];
    for (r, changes) in row_edits {
        let row = doc.row(*r).expect("edited rows exist");
        edits.push((row.start, row.end, rebuild_row(xml, row, changes)));
    }
    let mut inserts: BTreeMap<usize, String> = BTreeMap::new();
    for (r, text) in new_rows {
        let pos = doc.rows.iter().find(|x| x.r > *r).map(|x| x.start).unwrap_or(doc.data_close);
        inserts.entry(pos).or_default().push_str(text);
    }
    if let Some((s, e)) = doc.data_empty {
        let all: String = inserts.values().cloned().collect();
        edits.push((s, e, format!("<sheetData>{all}</sheetData>")));
    } else {
        for (pos, text) in inserts {
            edits.push((pos, pos, text));
        }
    }
    let max_col = doc
        .rows
        .iter()
        .flat_map(|r| r.cells.iter().map(|c| c.col))
        .chain(ctx.cols.iter().copied())
        .chain(owner_cols.iter().copied())
        .max()
        .unwrap_or(1);
    let max_row = doc.rows.last().map(|r| r.r).unwrap_or(1).max(last_row);
    if let Some((s, e, _)) = &doc.dimension {
        edits.push((*s, *e, format!(r#"<dimension ref="A1:{}{max_row}"/>"#, col_name(max_col))));
    }
    let mut filter = None;
    if ctx.table.is_none() {
        if let Some((_, _, tok)) = &doc.auto_filter {
            if let Some((a, b)) = tok.attr("ref").and_then(parse_range) {
                if a.1 == ctx.header_row && b.1 < last_row {
                    let new_ref = range_str(a, (b.0, last_row));
                    edits.push((tok.start, tok.end, retag(tok, &[("ref", new_ref.clone())], &[])));
                    filter = Some(new_ref);
                }
            }
        }
    }
    (apply_edits(xml, edits), filter)
}

/// Grow a table (and its autofilter) down to `last_row`.
pub(crate) fn extend_table(pkg: &mut Package, t: &TableInfo, last_row: u32) {
    if t.to.1 < last_row {
        let new_ref = range_str(t.from, (t.to.0, last_row));
        let mut tedits = vec![(t.root.start, t.root.end, retag(&t.root, &[("ref", new_ref.clone())], &[]))];
        if let Some(f) = &t.filter {
            tedits.push((f.start, f.end, retag(f, &[("ref", new_ref)], &[])));
        }
        pkg.put(&t.path, apply_edits(&t.xml, tedits));
    }
}

pub fn patch_workbook(bytes: Vec<u8>, input: &AppendInput<'_>) -> LResult<Plan> {
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
    let txn_sheet = find_sheet(&wb.sheets, SHEET_TRANSACTIONS)?.clone();
    let program_sheets: Vec<WbSheet> =
        input.programs.iter().map(|m| find_sheet(&wb.sheets, &m.name).cloned()).collect::<LResult<_>>()?;
    let doc = SheetDoc::parse(pkg.read(&txn_sheet.path)?.ok_or_else(|| layout("ورقة المعاملات فارغة."))?)?;

    // --- Header row and program columns (by name) ---
    let header_row = doc
        .rows
        .iter()
        .take_while(|r| r.r <= 50)
        .find(|r| r.cells.iter().any(|c| c.value(&sst) == CellValue::Str(TXN_HEADERS[COL_ID].into())))
        .ok_or_else(|| missing_header(TXN_HEADERS[COL_ID]))?;
    let mut cols = [0u32; 17];
    for (i, h) in TXN_HEADERS.iter().enumerate() {
        cols[i] = header_row
            .cells
            .iter()
            .find(|c| c.value(&sst) == CellValue::Str(h.to_string()))
            .map(|c| c.col)
            .ok_or_else(|| missing_header(h))?;
    }
    let hr = header_row.r;
    for m in &doc.merges {
        if let Some(((_, r1), (_, r2))) = parse_range(m) {
            if r1 <= hr && hr <= r2 {
                return Err(layout("في صف عناوين ورقة المعاملات خلايا مدمجة. ألغِ الدمج ثم أعد المحاولة."));
            }
        }
    }
    let id_col = cols[COL_ID];
    let tables = sheet_tables(&mut pkg, &txn_sheet.path, &doc)?;
    let table = tables.iter().find(|t| t.from.1 == hr && t.from.0 <= id_col && id_col <= t.to.0);
    if let Some(t) = table {
        if t.root.attr("totalsRowCount").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0) > 0 {
            return Err(layout("جدول المعاملات فيه صف إجمالي (Total Row). أخفِه من «تصميم الجدول» ثم أعد المحاولة."));
        }
    }

    // --- Existing rows ---
    let txn_by_id: HashMap<&str, &TxnCells> = input.txns.iter().map(|(id, cells)| (id.as_str(), cells)).collect();
    let mut in_sheet: HashSet<String> = HashSet::new();
    let mut last_id_row = hr;
    let mut fitter = Fitter::new(&mut styles);
    let mut row_edits: BTreeMap<u32, BTreeMap<u32, String>> = BTreeMap::new();
    let mut updated = 0;
    let mut present_ids = vec![];
    for row in doc.rows.iter().filter(|r| r.r > hr) {
        let id = match row.cell(id_col).map(|c| c.value(&sst)) {
            Some(CellValue::Str(s)) => s.trim().to_string(),
            _ => continue,
        };
        if id.is_empty() {
            continue;
        }
        last_id_row = row.r;
        if !in_sheet.insert(id.clone()) {
            continue; // a duplicate row the owner made: left alone
        }
        let mut changes = BTreeMap::new();
        match txn_by_id.get(id.as_str()) {
            Some(cells) => {
                present_ids.push(id.clone());
                for (i, v, st) in cells.iter() {
                    let col = cols[*i as usize];
                    let cell = row.cell(col);
                    let cur = cell.map(|c| c.value(&sst)).unwrap_or(CellValue::Empty);
                    if !same(&cur, v, wb.date1904) {
                        let s = fitter.fit(cell.and_then(|c| c.s), *st);
                        changes.insert(col, program_cell(col, row.r, s, v, wb.date1904));
                    }
                }
            }
            None if input.exported.contains(&id) => {
                let col = cols[COL_STATUS];
                let cell = row.cell(col);
                let deleted = Some(V::Str(STATUS_DELETED.into()));
                if !same(&cell.map(|c| c.value(&sst)).unwrap_or(CellValue::Empty), &deleted, wb.date1904) {
                    changes.insert(col, program_cell(col, row.r, cell.and_then(|c| c.s), &deleted, wb.date1904));
                }
            }
            None => {}
        }
        if !changes.is_empty() {
            updated += 1;
            row_edits.insert(row.r, changes);
        }
    }

    // --- New transactions ---
    let new: Vec<&(String, TxnCells)> =
        input.txns.iter().filter(|(id, _)| !input.exported.contains(id) && !in_sheet.contains(id)).collect();
    let ctx = AppendCtx {
        doc: &doc, cols: &cols, header_row: hr, table, date1904: wb.date1904, what: "ورقة المعاملات"
    };
    let rows: Vec<NewRow> = new.iter().map(|(_, cells)| NewRow { cells: cells.clone(), fill: None }).collect();
    let (new_rows, owner_cols, last_row) = append_rows(&ctx, &mut fitter, last_id_row, &rows, &mut row_edits)?;
    drop(fitter);

    // --- Sheet edits ---
    let (sheet_xml, filter_ref) = apply_sheet(&ctx, &row_edits, &new_rows, last_row, &owner_cols);
    let mut filters: Vec<(usize, String, String)> = vec![];
    if let Some(r) = filter_ref {
        filters.push((txn_sheet.index, txn_sheet.name.clone(), r));
    }
    pkg.put(&txn_sheet.path, sheet_xml);
    if let Some(t) = table {
        extend_table(&mut pkg, t, last_row);
    }

    // --- Program sheets ---
    for (m, sheet) in input.programs.iter().zip(program_sheets.iter()) {
        let old = SheetDoc::parse(pkg.read(&sheet.path)?.ok_or_else(|| layout(format!("ورقة «{}» تالفة.", m.name)))?)?;
        if !old.table_rids.is_empty() {
            return Err(layout(format!(
                "ورقة «{}» يكتبها البرنامج عند كل تحديث، وفيها جدول أضفته. انقل الجدول إلى ورقة أخرى أو اختر «إعادة كتابة كاملة».",
                m.name
            )));
        }
        let keep = Keep { sheet_pr: old.sheet_pr.clone(), tab_selected: old.tab_selected, tail: old.keep_tail.clone() };
        pkg.put(&sheet.path, model::render_xml(m, &mut styles, wb.date1904, &keep, None));
        filters.push((sheet.index, sheet.name.clone(), model::filter_ref(m)));
    }

    // --- Workbook-level parts ---
    let wb_xml = pkg.read("xl/workbook.xml")?.ok_or_else(|| layout("workbook.xml مفقود."))?;
    pkg.put("xl/workbook.xml", patch_workbook_xml(&wb_xml, &filters)?);
    remove_calc_chain(&mut pkg)?;
    if styles.is_changed() {
        pkg.put(&styles_path, styles.serialize());
    }
    let sheets = wb.sheets.len() as i64;
    let bytes = pkg.finish().map_err(|e| layout(format!("تعذّر بناء الملف: {e}")))?;
    Ok(Plan { bytes, added_ids: new.iter().map(|(id, _)| id.clone()).collect(), present_ids, updated, sheets })
}

fn missing_header(name: &str) -> xlsx::Layout {
    layout(format!("لم أجد عمود «{name}» في ورقة المعاملات. أعد العنوان كما كان أو اختر «إعادة كتابة كاملة»."))
}
