//! Excel export (SPEC §6.8). One direction only: PpFeez → Excel.
//!
//! - The main workbook (summary, transactions, customers, ledger) is created once with
//!   `rust_xlsxwriter` (the transactions sheet is an Excel Table). Later updates use "append"
//!   mode by default (SPEC §6.8.1, `append.rs`): the owner's own edits in the file are kept and
//!   only the parts PpFeez owns are patched (`xlsx.rs`); "rewrite" mode writes the file anew.
//!   Either way the old file is copied to `{name}.previous.xlsx`, the new one is written to a
//!   temporary file in the same folder and renamed over the old one, so a failure never damages
//!   it. A file open in Excel is locked by Windows and reported as `file_locked`.
//! - Quick exports (filtered transactions, a customer statement) always create a new file.
//!
//! Amounts are written as numbers (so Excel can sum them) with a format matching the
//! currency's decimals. The integer → Excel number conversion happens only here, at write
//! time. Dates are real Excel dates in the device's time zone.

use crate::clock::{parse_date, parse_iso};
use crate::customers::Customer;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::ledger::{LedgerType, PayoutMethod};
use crate::money::{decimals, ltr};
use crate::settings::{self, ExcelMode, Settings, K_EXCEL_EXPORT_PATH, K_EXCEL_LAST_EXPORTED_AT};
use crate::transactions::{Period, SortDir, Transaction, TxnFilter, TxnSort, TxnSortKey, TxnStatus, TxnType};
use crate::Core;
use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};
use model::{Formats, MCell, RowB, SheetModel, St, V};
use rust_xlsxwriter::{
    Color, ExcelDateTime, Format, FormatAlign, Table, TableColumn, TableStyle, Workbook, Worksheet, XlsxError,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

mod append;
pub mod model;
pub mod xlsx;

pub const SHEET_SUMMARY: &str = "الملخص";
pub const SHEET_TRANSACTIONS: &str = "المعاملات";
pub const SHEET_CUSTOMERS: &str = "العملاء";
pub const SHEET_LEDGER: &str = "الدفتر";
/// Name of the Excel Table on the transactions sheet (used in the owner's structured references).
pub const TXN_TABLE: &str = "Transactions";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelExportResult {
    pub path: String,
    pub sheets: i64,
    /// Data rows written across all sheets (headers excluded).
    pub rows: i64,
    pub exported_at: String,
    /// Append mode: transactions added to / rows updated in the transactions sheet.
    pub added: i64,
    pub updated: i64,
    /// The file did not exist and was created.
    pub created: bool,
}

fn export_failed(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::ExportFailed, format!("فشل التصدير إلى Excel: {e}"))
}

fn file_locked() -> AppError {
    AppError::new(ErrorCode::FileLocked, "أغلق الملف في Excel ثم أعد المحاولة")
}

impl From<XlsxError> for AppError {
    fn from(e: XlsxError) -> Self {
        export_failed(e)
    }
}

/// Windows reports a file held open by Excel as "access denied" (5), a sharing violation
/// (32) or a lock violation (33).
pub fn is_lock_error(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// Paths must end in `.xlsx` (case-insensitive) and their folder must exist.
pub fn validate_xlsx_path(p: &str) -> AppResult<String> {
    let path = PathBuf::from(p.trim());
    let ok_ext = path.extension().map(|e| e.eq_ignore_ascii_case("xlsx")).unwrap_or(false);
    if !ok_ext {
        return Err(AppError::validation("path", "يجب أن يكون الملف بامتداد ‎.xlsx"));
    }
    match path.parent() {
        Some(dir) if dir.as_os_str().is_empty() || dir.is_dir() => Ok(path.display().to_string()),
        _ => Err(AppError::validation("path", "المجلد غير موجود")),
    }
}

/// Write `bytes` to a temp file next to `dest`, then move it over `dest` with `replace`.
/// The previous file stays untouched when anything fails.
pub fn save_atomic_with(
    bytes: &[u8],
    dest: &Path,
    replace: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> AppResult<()> {
    let dir = dest.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "ppfeez.xlsx".into());
    let tmp = dir.join(format!(".~{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(export_failed(e));
    }
    match replace(&tmp, dest) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            if is_lock_error(&e) {
                Err(file_locked())
            } else {
                Err(export_failed(e))
            }
        }
    }
}

pub fn save_atomic(bytes: &[u8], dest: &Path) -> AppResult<()> {
    save_atomic_with(bytes, dest, |from, to| std::fs::rename(from, to))
}

/// Keep the file as it was before this update next to it: `{name}.previous.xlsx` (one copy).
pub fn previous_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "PpFeez".into());
    path.with_file_name(format!("{stem}.previous.xlsx"))
}

fn keep_previous(path: &Path) -> AppResult<()> {
    match std::fs::copy(path, previous_path(path)) {
        Ok(_) => Ok(()),
        Err(e) if is_lock_error(&e) => Err(file_locked()),
        Err(e) => Err(export_failed(e)),
    }
}

/// Save a new file (quick exports).
fn save_new(bytes: &[u8], dest: &Path) -> AppResult<()> {
    match std::fs::write(dest, bytes) {
        Ok(()) => Ok(()),
        Err(e) if is_lock_error(&e) => Err(file_locked()),
        Err(e) => Err(export_failed(e)),
    }
}

// ===== Formatting =====

struct Styles {
    header: Format,
    title: Format,
    text: Format,
    bold: Format,
    date: Format,
    money2: Format,
    money0: Format,
    money2_bold: Format,
    money0_bold: Format,
    struck: Format,
}

impl Styles {
    fn new() -> Self {
        let header = Format::new()
            .set_bold()
            .set_background_color(Color::RGB(0x1F4E79))
            .set_font_color(Color::White)
            .set_align(FormatAlign::Center);
        Styles {
            header,
            title: Format::new().set_bold().set_font_size(14),
            text: Format::new(),
            bold: Format::new().set_bold(),
            date: Format::new().set_num_format("yyyy-mm-dd"),
            money2: Format::new().set_num_format("#,##0.00"),
            money0: Format::new().set_num_format("#,##0"),
            money2_bold: Format::new().set_num_format("#,##0.00").set_bold(),
            money0_bold: Format::new().set_num_format("#,##0").set_bold(),
            struck: Format::new().set_font_strikethrough(),
        }
    }

    fn money(&self, currency: &str, bold: bool) -> &Format {
        match (decimals(currency), bold) {
            (0, false) => &self.money0,
            (0, true) => &self.money0_bold,
            (_, false) => &self.money2,
            (_, true) => &self.money2_bold,
        }
    }
}

/// Minor units → Excel number. The only place integers become floating point.
pub(crate) fn to_number(minor: i64, currency: &str) -> f64 {
    minor as f64 / 10f64.powi(decimals(currency) as i32)
}

pub(crate) fn excel_dt(dt: NaiveDateTime) -> Result<ExcelDateTime, XlsxError> {
    ExcelDateTime::from_ymd(dt.year() as u16, dt.month() as u8, dt.day() as u8)?.and_hms(
        dt.hour() as u16,
        dt.minute() as u8,
        dt.second() as f64,
    )
}

pub(crate) fn excel_date(d: NaiveDate) -> Result<ExcelDateTime, XlsxError> {
    ExcelDateTime::from_ymd(d.year() as u16, d.month() as u8, d.day() as u8)
}

pub(crate) fn status_ar(s: TxnStatus) -> &'static str {
    match s {
        TxnStatus::Unassigned => "غير مخصّصة",
        TxnStatus::PendingApproval => "بانتظار الموافقة",
        TxnStatus::Approved => "معتمدة",
        TxnStatus::Excluded => "مستبعدة",
    }
}

fn type_ar(t: TxnType) -> &'static str {
    match t {
        TxnType::Payment => "دفعة",
        TxnType::Refund => "استرداد",
        TxnType::Reversal => "عكس/نزاع",
    }
}

/// A sheet with RTL direction, bold header row, frozen header and autofilter.
struct Sheet<'a> {
    ws: &'a mut Worksheet,
    cols: u16,
    header_row: u32,
    row: u32,
}

impl<'a> Sheet<'a> {
    fn new(wb: &'a mut Workbook, name: &str) -> Result<Self, XlsxError> {
        let ws = wb.add_worksheet();
        ws.set_name(name)?;
        ws.set_right_to_left(true);
        Ok(Sheet { ws, cols: 0, header_row: 0, row: 0 })
    }

    fn headers(&mut self, st: &Styles, headers: &[&str]) -> Result<(), XlsxError> {
        self.header_row = self.row;
        for (i, h) in headers.iter().enumerate() {
            self.ws.write_string_with_format(self.row, i as u16, *h, &st.header)?;
        }
        self.cols = headers.len() as u16;
        self.row += 1;
        Ok(())
    }

    fn str(&mut self, col: u16, v: &str, f: &Format) -> Result<(), XlsxError> {
        if !v.is_empty() {
            self.ws.write_string_with_format(self.row, col, v, f)?;
        }
        Ok(())
    }

    fn opt(&mut self, col: u16, v: Option<&str>, f: &Format) -> Result<(), XlsxError> {
        self.str(col, v.unwrap_or(""), f)
    }

    fn money(
        &mut self,
        st: &Styles,
        col: u16,
        minor: Option<i64>,
        currency: &str,
        bold: bool,
    ) -> Result<(), XlsxError> {
        if let Some(m) = minor {
            self.ws.write_number_with_format(self.row, col, to_number(m, currency), st.money(currency, bold))?;
        }
        Ok(())
    }

    fn next(&mut self) {
        self.row += 1;
    }

    /// Freeze the header, add an autofilter over the table and size the columns.
    fn finish(self, widths: &[f64]) -> Result<(), XlsxError> {
        if self.cols > 0 {
            self.ws.set_freeze_panes(self.header_row + 1, 0)?;
            let last = self.row.saturating_sub(1).max(self.header_row);
            self.ws.autofilter(self.header_row, 0, last, self.cols - 1)?;
        }
        for (i, w) in widths.iter().enumerate() {
            self.ws.set_column_width(i as u16, *w)?;
        }
        Ok(())
    }
}

// ===== Sheets =====

pub(crate) const TXN_HEADERS: [&str; 17] = [
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
const TXN_WIDTHS: [f64; 17] =
    [17.0, 22.0, 10.0, 22.0, 26.0, 28.0, 8.0, 13.0, 11.0, 13.0, 18.0, 10.0, 11.0, 13.0, 16.0, 18.0, 28.0];

impl Core {
    fn local_dt(&self, iso_s: &str) -> Option<NaiveDateTime> {
        parse_iso(iso_s).map(|d| self.clock.utc_to_local(d))
    }

    /// The 17 program columns of a transaction: value (None = empty cell) and style.
    pub(crate) fn txn_cells(&self, t: &Transaction) -> model::TxnCells {
        let s = |v: Option<&str>| v.filter(|x| !x.is_empty()).map(|x| V::Str(x.to_string()));
        let m = |minor: Option<i64>| minor.map(|v| V::Num(to_number(v, &t.currency)));
        let money = St::money(&t.currency, false);
        vec![
            (0, self.local_dt(&t.occurred_at).map(V::DateTime), St::DateTime),
            (1, s(Some(&t.paypal_txn_id)), St::Text),
            (2, s(Some(type_ar(t.kind))), St::Text),
            (3, s(t.payer_name.as_deref()), St::Text),
            (4, s(t.payer_email.as_deref()), St::Text),
            (5, s(t.payer_note.as_deref()), St::Text),
            (6, s(Some(&t.currency)), St::Text),
            (7, m(Some(t.gross_minor)), money),
            (8, m(t.fee_minor), money),
            (9, m(t.net_minor), money),
            (10, s(t.customer.as_ref().map(|c| c.name.as_str())), St::Text),
            (11, t.commission_bps.map(|b| V::Num(b as f64 / 10_000.0)), St::Pct),
            (12, m(t.commission_minor), money),
            (13, m(t.customer_amount_minor), money),
            (14, s(Some(status_ar(t.status))), St::Text),
            (15, s(t.mailbox.as_ref().map(|m| m.label.as_str())), St::Text),
            (16, s(t.note.as_deref()), St::Text),
        ]
    }

    fn write_txn_rows(&self, s: &mut Sheet<'_>, items: &[Transaction]) -> Result<(), XlsxError> {
        let f = Formats::new();
        for t in items {
            for (col, v, st) in self.txn_cells(t) {
                if let Some(v) = v {
                    model::write_cell(s.ws, &f, s.row, &MCell { col, v, st })?;
                }
            }
            s.next();
        }
        Ok(())
    }

    pub(crate) fn model_summary(&self, now: NaiveDateTime) -> AppResult<(SheetModel, i64)> {
        let d = self.dashboard_summary(&Period::default())?;
        let mut m = SheetModel::program(
            SHEET_SUMMARY,
            &["العملة", "الوارد", "الرسوم", "عمولتي", "المستحق للعملاء", "المدفوع"],
            &[22.0, 15.0, 13.0, 13.0, 17.0, 13.0],
        );
        for c in &d.by_currency {
            let mut r = RowB::default();
            r.str(0, &c.currency, St::Bold)
                .money(1, Some(c.gross_minor), &c.currency, false)
                .money(2, Some(c.fee_minor), &c.currency, false)
                .money(3, Some(c.commission_minor), &c.currency, false)
                .money(4, Some(c.owed_to_customers_minor), &c.currency, false)
                .money(5, Some(c.paid_out_minor), &c.currency, false);
            m.push(r);
        }
        m.push_extra(RowB::default());
        for (label, n) in [
            ("غير مخصّصة", d.counts.unassigned),
            ("تحتاج رسوم", d.counts.needs_fee),
            ("بانتظار الموافقة", d.counts.pending_approval),
            ("تنبيهات استرداد", d.counts.refund_alerts),
        ] {
            let mut r = RowB::default();
            r.str(0, label, St::Bold).num(1, n as f64, St::Int);
            m.push_extra(r);
        }
        let mut r = RowB::default();
        r.str(0, "وقت التصدير", St::Bold).dt(1, Some(now));
        m.push_extra(r);
        Ok((m, d.by_currency.len() as i64))
    }

    pub(crate) fn model_customers(&self, customers: &[Customer]) -> SheetModel {
        let currencies: BTreeSet<String> =
            customers.iter().flat_map(|c| c.balances.iter().map(|b| b.currency.clone())).collect();
        let mut headers: Vec<String> =
            vec!["الاسم".into(), "الهاتف".into(), "العمولة الافتراضية".into(), "الحالة".into()];
        headers.extend(currencies.iter().map(|c| format!("الرصيد {c}")));
        let refs: Vec<&str> = headers.iter().map(String::as_str).collect();
        let mut widths = vec![22.0, 16.0, 16.0, 10.0];
        widths.extend(currencies.iter().map(|_| 15.0));
        let mut m = SheetModel::program(SHEET_CUSTOMERS, &refs, &widths);
        for c in customers {
            let mut r = RowB::default();
            r.str(0, &c.name, St::Text)
                .opt(1, c.phone.as_deref(), St::Text)
                .num(2, c.default_commission_bps as f64 / 10_000.0, St::Pct)
                .str(3, if c.is_active { "نشط" } else { "معطّل" }, St::Text);
            for (i, cur) in currencies.iter().enumerate() {
                let bal = c.balances.iter().find(|b| &b.currency == cur).map(|b| b.minor).unwrap_or(0);
                r.money(4 + i as u16, Some(bal), cur, false);
            }
            m.push(r);
        }
        m
    }

    pub(crate) fn model_ledger(&self) -> AppResult<(SheetModel, i64)> {
        struct Row {
            customer_id: i64,
            customer: String,
            currency: String,
            date: String,
            kind: LedgerType,
            description: String,
            amount: i64,
            reference: Option<String>,
            method: Option<String>,
            reversed: bool,
        }
        let rows: Vec<Row> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT e.customer_id, c.name, e.currency, e.entry_date, e.type, e.description, e.amount_minor,
                        e.reference, e.payout_method,
                        EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = e.id)
                 FROM ledger_entries e JOIN customers c ON c.id = e.customer_id
                 ORDER BY c.name COLLATE NOCASE, c.id, e.currency, e.entry_date, e.id",
            )?;
            let it = stmt.query_map([], |r| {
                Ok(Row {
                    customer_id: r.get(0)?,
                    customer: r.get(1)?,
                    currency: r.get(2)?,
                    date: r.get(3)?,
                    kind: LedgerType::parse(&r.get::<_, String>(4)?),
                    description: r.get(5)?,
                    amount: r.get(6)?,
                    reference: r.get(7)?,
                    method: r.get(8)?,
                    reversed: r.get(9)?,
                })
            })?;
            it.collect::<Result<_, _>>()?
        };
        let mut m = SheetModel::program(
            SHEET_LEDGER,
            &[
                "العميل",
                "العملة",
                "التاريخ",
                "النوع",
                "الوصف",
                "له",
                "عليه",
                "الرصيد الجاري",
                "المرجع",
                "الطريقة",
                "معكوس؟",
            ],
            &[20.0, 8.0, 12.0, 12.0, 50.0, 13.0, 13.0, 15.0, 16.0, 12.0, 9.0],
        );
        let mut running: BTreeMap<(i64, String), i64> = BTreeMap::new();
        for e in &rows {
            let bal = running.entry((e.customer_id, e.currency.clone())).or_default();
            *bal += e.amount;
            let mut r = RowB::default();
            r.str(0, &e.customer, St::Text)
                .str(1, &e.currency, St::Text)
                .date(2, parse_date(&e.date))
                .str(3, e.kind.label_ar(), St::Text)
                .str(4, &e.description, if e.reversed { St::Struck } else { St::Text });
            if e.amount >= 0 {
                r.money(5, Some(e.amount), &e.currency, false);
            } else {
                r.money(6, Some(-e.amount), &e.currency, false);
            }
            r.money(7, Some(*bal), &e.currency, false)
                .opt(8, e.reference.as_deref(), St::Text)
                .opt(9, e.method.as_deref().and_then(PayoutMethod::parse).map(|m| m.label_ar()), St::Text)
                .str(10, if e.reversed { "نعم" } else { "" }, St::Text);
            m.push(r);
        }
        Ok((m, rows.len() as i64))
    }

    /// The transactions sheet of a new main workbook: an Excel Table, so formula columns the
    /// owner adds inside it extend to new rows by themselves.
    fn render_transactions(&self, wb: &mut Workbook, f: &Formats, items: &[Transaction]) -> AppResult<()> {
        let ws = wb.add_worksheet();
        ws.set_name(SHEET_TRANSACTIONS)?;
        ws.set_right_to_left(true);
        for (r, t) in items.iter().enumerate() {
            for (col, v, st) in self.txn_cells(t) {
                if let Some(v) = v {
                    model::write_cell(ws, f, r as u32 + 1, &MCell { col, v, st })?;
                }
            }
        }
        let columns: Vec<TableColumn> = TXN_HEADERS
            .iter()
            .map(|h| TableColumn::new().set_header(*h).set_header_format(f.get(St::Header)))
            .collect();
        let table = Table::new().set_name(TXN_TABLE).set_style(TableStyle::Medium2).set_columns(&columns);
        // A table needs at least one data row: an empty one when there are no transactions yet.
        let last = items.len().max(1) as u32;
        ws.add_table(0, 0, last, TXN_HEADERS.len() as u16 - 1, &table)?;
        ws.set_freeze_panes(1, 0)?;
        for (i, w) in TXN_WIDTHS.iter().enumerate() {
            ws.set_column_width(i as u16, *w)?;
        }
        Ok(())
    }

    fn finish_result(&self, path: &Path, sheets: i64, rows: i64) -> ExcelExportResult {
        ExcelExportResult {
            path: path.display().to_string(),
            sheets,
            rows,
            exported_at: self.now_iso(),
            added: 0,
            updated: 0,
            created: true,
        }
    }

    fn main_data(&self) -> AppResult<(NaiveDateTime, Vec<Transaction>, Vec<Customer>)> {
        let now = self.clock.utc_to_local(self.clock.now());
        let items =
            self.txn_list_all(&TxnFilter::default(), TxnSort { key: TxnSortKey::OccurredAt, dir: SortDir::Asc })?.items;
        let customers = self.customers_list(None, None)?;
        Ok((now, items, customers))
    }

    /// A complete new main workbook (first creation and "rewrite" mode): bytes, data rows, and
    /// the PayPal ids written.
    pub fn excel_main_workbook(&self) -> AppResult<(Vec<u8>, i64, Vec<String>)> {
        let f = Formats::new();
        let (now, items, customers) = self.main_data()?;
        let mut wb = Workbook::new();
        let (summary, mut rows) = self.model_summary(now)?;
        model::render(&mut wb, &f, &summary)?;
        self.render_transactions(&mut wb, &f, &items)?;
        rows += items.len() as i64;
        model::render(&mut wb, &f, &self.model_customers(&customers))?;
        rows += customers.len() as i64;
        let (ledger, n) = self.model_ledger()?;
        model::render(&mut wb, &f, &ledger)?;
        rows += n;
        Ok((wb.save_to_buffer()?, rows, items.iter().map(|t| t.paypal_txn_id.clone()).collect()))
    }

    pub fn excel_set_path(&self, path: &str) -> AppResult<Settings> {
        let p = validate_xlsx_path(path)?;
        settings::set_raw(&self.conn(), K_EXCEL_EXPORT_PATH, &p)?;
        self.get_settings()
    }

    /// Update the main workbook at the saved path (SPEC §6.8.1): "append" keeps everything the
    /// owner wrote in the file; "rewrite" (or a missing file) writes it anew.
    pub fn excel_update(&self) -> AppResult<ExcelExportResult> {
        let s = self.get_settings()?;
        let path_s = s
            .excel_export_path
            .ok_or_else(|| AppError::new(ErrorCode::NoExportPath, "اختر مسار ملف Excel أولاً من الإعدادات"))?;
        let path = PathBuf::from(&path_s);
        let existed = path.exists();
        let result = if existed && s.excel_mode == ExcelMode::Append {
            self.excel_append(&path, &path_s)?
        } else {
            let (bytes, rows, ids) = self.excel_main_workbook()?;
            if existed {
                keep_previous(&path)?;
            }
            save_atomic(&bytes, &path)?;
            self.record_exported(&path_s, &ids, true)?;
            ExcelExportResult { added: ids.len() as i64, created: !existed, ..self.finish_result(&path, 4, rows) }
        };
        settings::set_raw(&self.conn(), K_EXCEL_LAST_EXPORTED_AT, &result.exported_at)?;
        Ok(result)
    }

    /// Remember which PayPal ids this file has received (rows the owner deletes are not re-added).
    pub(crate) fn record_exported(&self, path: &str, ids: &[String], replace: bool) -> AppResult<()> {
        let now = self.now_iso();
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        if replace {
            tx.execute("DELETE FROM excel_exported WHERE file_path = ?1", [path])?;
        }
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO excel_exported (file_path, paypal_txn_id, exported_at) VALUES (?1, ?2, ?3)",
            )?;
            for id in ids {
                stmt.execute(rusqlite::params![path, id, now])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Called when the app closes: refresh the main workbook if enabled and a path is set.
    pub fn excel_on_close(&self) -> AppResult<Option<ExcelExportResult>> {
        let s = self.get_settings()?;
        if !s.excel_update_on_close || s.excel_export_path.is_none() {
            return Ok(None);
        }
        self.excel_update().map(Some)
    }

    /// The transactions shown with the current filter and sort (all pages) + totals per currency.
    pub fn excel_export_transactions(
        &self,
        filter: &TxnFilter,
        sort: TxnSort,
        path: &Path,
    ) -> AppResult<ExcelExportResult> {
        let path = PathBuf::from(validate_xlsx_path(&path.display().to_string())?);
        let list = self.txn_list_all(filter, sort)?;
        let st = Styles::new();
        let mut wb = Workbook::new();
        {
            let mut s = Sheet::new(&mut wb, "المعاملات")?;
            s.headers(&st, &TXN_HEADERS)?;
            self.write_txn_rows(&mut s, &list.items)?;
            let table_end = s.row;
            s.row += 1;
            for t in &list.totals {
                s.str(0, &format!("الإجمالي ({})", ltr(&t.count.to_string())), &st.bold)?;
                s.str(6, &t.currency, &st.bold)?;
                s.money(&st, 7, Some(t.gross_minor), &t.currency, true)?;
                s.money(&st, 8, Some(t.fee_minor), &t.currency, true)?;
                s.money(&st, 9, Some(t.net_minor), &t.currency, true)?;
                s.money(&st, 13, Some(t.customer_amount_minor), &t.currency, true)?;
                s.next();
            }
            s.row = table_end;
            s.finish(&TXN_WIDTHS)?;
        }
        save_new(&wb.save_to_buffer()?, &path)?;
        Ok(self.finish_result(&path, 1, list.items.len() as i64))
    }

    /// Customer statement: one sheet per currency (or only `currency`).
    pub fn excel_export_ledger(
        &self,
        customer_id: i64,
        currency: Option<&str>,
        period: Option<&Period>,
        path: &Path,
    ) -> AppResult<ExcelExportResult> {
        let path = PathBuf::from(validate_xlsx_path(&path.display().to_string())?);
        let customer = self.customer_get(customer_id)?;
        let currencies: Vec<String> = match currency.filter(|c| !c.trim().is_empty()) {
            Some(c) => vec![crate::money::normalize_currency(c)?],
            None => customer.balances.iter().map(|b| b.currency.clone()).collect(),
        };
        let period_label = match period {
            Some(p) if p.from.is_some() || p.to.is_some() => format!(
                "الفترة: {} — {}",
                p.from.as_deref().map(ltr).unwrap_or_else(|| "البداية".into()),
                p.to.as_deref().map(ltr).unwrap_or_else(|| "اليوم".into())
            ),
            _ => "الفترة: كل الفترات".into(),
        };
        let st = Styles::new();
        let mut wb = Workbook::new();
        let mut rows = 0;
        if currencies.is_empty() {
            let mut s = Sheet::new(&mut wb, "كشف الحساب")?;
            s.str(0, &format!("كشف حساب: {}", customer.name), &st.title)?;
            s.next();
            s.str(0, "لا توجد قيود", &st.text)?;
            s.finish(&[40.0])?;
        }
        for cur in &currencies {
            let view = self.ledger_entries(customer_id, cur, period)?;
            let mut s = Sheet::new(&mut wb, cur)?;
            s.str(0, &format!("كشف حساب: {}", customer.name), &st.title)?;
            s.next();
            s.str(0, &period_label, &st.text)?;
            s.str(3, &format!("العملة: {cur}"), &st.text)?;
            s.next();
            s.next();
            s.headers(&st, &["التاريخ", "النوع", "الوصف", "له", "عليه", "الرصيد", "المرجع"])?;
            s.str(2, "رصيد سابق", &st.bold)?;
            s.money(&st, 5, Some(view.opening_balance_minor), cur, true)?;
            s.next();
            for e in &view.entries {
                if let Some(d) = parse_date(&e.entry_date) {
                    s.ws.write_datetime_with_format(s.row, 0, excel_date(d)?, &st.date)?;
                }
                s.str(1, e.kind.label_ar(), &st.text)?;
                let f = if e.reversed_by_entry_id.is_some() { &st.struck } else { &st.text };
                s.str(2, &e.description, f)?;
                if e.amount_minor >= 0 {
                    s.money(&st, 3, Some(e.amount_minor), cur, false)?;
                } else {
                    s.money(&st, 4, Some(-e.amount_minor), cur, false)?;
                }
                s.money(&st, 5, Some(e.running_balance_minor), cur, false)?;
                s.opt(6, e.reference.as_deref(), &st.text)?;
                s.next();
            }
            s.str(2, "الرصيد الختامي", &st.bold)?;
            s.money(&st, 5, Some(view.closing_balance_minor), cur, true)?;
            s.next();
            rows += view.entries.len() as i64;
            s.finish(&[12.0, 12.0, 55.0, 13.0, 13.0, 15.0, 16.0])?;
        }
        save_new(&wb.save_to_buffer()?, &path)?;
        Ok(self.finish_result(&path, currencies.len().max(1) as i64, rows))
    }
}
