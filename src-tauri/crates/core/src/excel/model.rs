//! Program sheets as data (values + semantic styles), rendered either with `rust_xlsxwriter`
//! (new file) or as raw worksheet XML inside the owner's file (SPEC §6.8.1).

use super::xlsx::{col_name, esc, esc_attr, num_text, StylesDoc};
use chrono::{NaiveDate, NaiveDateTime, Timelike};
use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook, XlsxError};

/// First row of every sheet PpFeez rewrites on each update.
pub const NOTE: &str = "هذه الورقة يكتبها البرنامج عند كل تحديث — لا تكتب فيها";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum St {
    Header,
    Note,
    Text,
    Bold,
    DateTime,
    Date,
    Pct,
    Int,
    Money { dec0: bool, bold: bool },
    Struck,
}

impl St {
    pub fn money(currency: &str, bold: bool) -> St {
        St::Money { dec0: crate::money::decimals(currency) == 0, bold }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum V {
    Str(String),
    Num(f64),
    DateTime(NaiveDateTime),
    Date(NaiveDate),
}

/// The 17 program columns of a transaction: (column, value or empty, style).
pub type TxnCells = Vec<(u16, Option<V>, St)>;

#[derive(Debug, Clone)]
pub struct MCell {
    pub col: u16,
    pub v: V,
    pub st: St,
}

pub struct SheetModel {
    pub name: String,
    pub rows: Vec<Vec<MCell>>,
    pub header_row: u32,
    /// Last row (0-based) covered by the autofilter.
    pub filter_last: u32,
    pub cols: u16,
    pub widths: Vec<f64>,
}

/// One row being built.
#[derive(Default)]
pub struct RowB(pub Vec<MCell>);

impl RowB {
    pub fn str(&mut self, col: u16, v: &str, st: St) -> &mut Self {
        if !v.is_empty() {
            self.0.push(MCell { col, v: V::Str(v.to_string()), st });
        }
        self
    }
    pub fn opt(&mut self, col: u16, v: Option<&str>, st: St) -> &mut Self {
        self.str(col, v.unwrap_or(""), st)
    }
    pub fn num(&mut self, col: u16, v: f64, st: St) -> &mut Self {
        self.0.push(MCell { col, v: V::Num(v), st });
        self
    }
    pub fn money(&mut self, col: u16, minor: Option<i64>, currency: &str, bold: bool) -> &mut Self {
        if let Some(m) = minor {
            self.0.push(MCell { col, v: V::Num(super::to_number(m, currency)), st: St::money(currency, bold) });
        }
        self
    }
    pub fn dt(&mut self, col: u16, v: Option<NaiveDateTime>) -> &mut Self {
        if let Some(d) = v {
            self.0.push(MCell { col, v: V::DateTime(d), st: St::DateTime });
        }
        self
    }
    pub fn date(&mut self, col: u16, v: Option<NaiveDate>) -> &mut Self {
        if let Some(d) = v {
            self.0.push(MCell { col, v: V::Date(d), st: St::Date });
        }
        self
    }
}

impl SheetModel {
    /// A program sheet: the "do not edit" note, then the header row.
    pub fn program(name: &str, headers: &[&str], widths: &[f64]) -> SheetModel {
        let mut note = RowB::default();
        note.str(0, NOTE, St::Note);
        let mut head = RowB::default();
        for (i, h) in headers.iter().enumerate() {
            head.str(i as u16, h, St::Header);
        }
        SheetModel {
            name: name.to_string(),
            rows: vec![note.0, head.0],
            header_row: 1,
            filter_last: 1,
            cols: headers.len() as u16,
            widths: widths.to_vec(),
        }
    }

    /// A data row inside the filtered table.
    pub fn push(&mut self, row: RowB) {
        self.rows.push(row.0);
        self.filter_last = self.rows.len() as u32 - 1;
    }

    /// A row after the table (not filtered).
    pub fn push_extra(&mut self, row: RowB) {
        self.rows.push(row.0);
    }
}

// ===== rust_xlsxwriter =====

pub struct Formats {
    header: Format,
    note: Format,
    text: Format,
    bold: Format,
    datetime: Format,
    date: Format,
    pct: Format,
    int: Format,
    money2: Format,
    money0: Format,
    money2_bold: Format,
    money0_bold: Format,
    struck: Format,
}

pub const HEADER_RGB: u32 = 0x1F4E79;
pub const NOTE_RGB: u32 = 0x9C0006;
pub const DATETIME_FMT: &str = "yyyy-mm-dd hh:mm";
pub const DATE_FMT: &str = "yyyy-mm-dd";

impl Default for Formats {
    fn default() -> Self {
        Self::new()
    }
}

impl Formats {
    pub fn new() -> Formats {
        Formats {
            header: Format::new()
                .set_bold()
                .set_background_color(Color::RGB(HEADER_RGB))
                .set_font_color(Color::White)
                .set_align(FormatAlign::Center),
            note: Format::new().set_bold().set_font_color(Color::RGB(NOTE_RGB)),
            text: Format::new(),
            bold: Format::new().set_bold(),
            datetime: Format::new().set_num_format(DATETIME_FMT),
            date: Format::new().set_num_format(DATE_FMT),
            pct: Format::new().set_num_format("0.00%"),
            int: Format::new().set_num_format("0"),
            money2: Format::new().set_num_format("#,##0.00"),
            money0: Format::new().set_num_format("#,##0"),
            money2_bold: Format::new().set_num_format("#,##0.00").set_bold(),
            money0_bold: Format::new().set_num_format("#,##0").set_bold(),
            struck: Format::new().set_font_strikethrough(),
        }
    }

    pub fn get(&self, st: St) -> &Format {
        match st {
            St::Header => &self.header,
            St::Note => &self.note,
            St::Text => &self.text,
            St::Bold => &self.bold,
            St::DateTime => &self.datetime,
            St::Date => &self.date,
            St::Pct => &self.pct,
            St::Int => &self.int,
            St::Money { dec0: false, bold: false } => &self.money2,
            St::Money { dec0: true, bold: false } => &self.money0,
            St::Money { dec0: false, bold: true } => &self.money2_bold,
            St::Money { dec0: true, bold: true } => &self.money0_bold,
            St::Struck => &self.struck,
        }
    }
}

pub fn write_cell(ws: &mut rust_xlsxwriter::Worksheet, f: &Formats, row: u32, c: &MCell) -> Result<(), XlsxError> {
    let fmt = f.get(c.st);
    match &c.v {
        V::Str(s) => {
            ws.write_string_with_format(row, c.col, s, fmt)?;
        }
        V::Num(n) => {
            ws.write_number_with_format(row, c.col, *n, fmt)?;
        }
        V::DateTime(d) => {
            ws.write_datetime_with_format(row, c.col, super::excel_dt(*d)?, fmt)?;
        }
        V::Date(d) => {
            ws.write_datetime_with_format(row, c.col, super::excel_date(*d)?, fmt)?;
        }
    }
    Ok(())
}

pub fn render(wb: &mut Workbook, f: &Formats, m: &SheetModel) -> Result<(), XlsxError> {
    let ws = wb.add_worksheet();
    ws.set_name(&m.name)?;
    ws.set_right_to_left(true);
    for (r, row) in m.rows.iter().enumerate() {
        for c in row {
            write_cell(ws, f, r as u32, c)?;
        }
    }
    if m.cols > 0 {
        ws.set_freeze_panes(m.header_row + 1, 0)?;
        ws.autofilter(m.header_row, 0, m.filter_last.max(m.header_row), m.cols - 1)?;
    }
    for (i, w) in m.widths.iter().enumerate() {
        ws.set_column_width(i as u16, *w)?;
    }
    Ok(())
}

// ===== Raw XML inside the owner's file =====

/// Excel serial number of a local date-time (1900 or 1904 date system).
pub fn serial(dt: NaiveDateTime, date1904: bool) -> f64 {
    let base = if date1904 {
        NaiveDate::from_ymd_opt(1904, 1, 1).unwrap()
    } else {
        NaiveDate::from_ymd_opt(1899, 12, 30).unwrap()
    };
    let days = (dt.date() - base).num_days() as f64;
    days + dt.time().num_seconds_from_midnight() as f64 / 86_400.0
}

pub fn value_number(v: &V, date1904: bool) -> Option<f64> {
    match v {
        V::Num(n) => Some(*n),
        V::DateTime(d) => Some(serial(*d, date1904)),
        V::Date(d) => Some(serial(d.and_hms_opt(0, 0, 0).unwrap(), date1904)),
        V::Str(_) => None,
    }
}

/// Style index in the owner's styles.xml for a semantic style (found or appended).
pub fn xf_for(styles: &mut StylesDoc, st: St) -> u32 {
    let header_rgb = format!("FF{HEADER_RGB:06X}");
    let note_rgb = format!("FF{NOTE_RGB:06X}");
    (match st {
        St::Header => {
            let font = styles.font(true, false, Some("FFFFFFFF"));
            let fill = styles.solid_fill(&header_rgb);
            styles.xf(0, font, fill, true)
        }
        St::Note => {
            let font = styles.font(true, false, Some(&note_rgb));
            styles.xf(0, font, 0, false)
        }
        St::Text => styles.xf(0, 0, 0, false),
        St::Bold => {
            let font = styles.font(true, false, None);
            styles.xf(0, font, 0, false)
        }
        St::DateTime => {
            let id = styles.num_fmt(DATETIME_FMT);
            styles.xf(id, 0, 0, false)
        }
        St::Date => {
            let id = styles.num_fmt(DATE_FMT);
            styles.xf(id, 0, 0, false)
        }
        St::Pct => styles.xf(10, 0, 0, false),
        St::Int => styles.xf(1, 0, 0, false),
        St::Money { dec0, bold } => {
            let id = if dec0 { 3 } else { 4 };
            let font = styles.font(bold, false, None);
            styles.xf(id, font, 0, false)
        }
        St::Struck => {
            let font = styles.font(false, true, None);
            styles.xf(0, font, 0, false)
        }
    }) as u32
}

/// What survives from the sheet being replaced.
pub struct Keep {
    pub sheet_pr: Option<String>,
    pub tab_selected: bool,
    pub tail: Vec<String>,
}

/// The whole worksheet XML of a program sheet.
pub fn render_xml(m: &SheetModel, styles: &mut StylesDoc, date1904: bool, keep: &Keep) -> String {
    let max_row = m.rows.len().max(1) as u32;
    let max_col = m.cols.max(1) as u32;
    let mut x = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    x.push('\n');
    x.push_str(r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#);
    if let Some(pr) = &keep.sheet_pr {
        x.push_str(pr);
    }
    x.push_str(&format!(r#"<dimension ref="A1:{}{max_row}"/>"#, col_name(max_col)));
    let top = m.header_row + 2;
    x.push_str(&format!(
        r#"<sheetViews><sheetView rightToLeft="1"{} workbookViewId="0"><pane ySplit="{}" topLeftCell="A{top}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A{top}" sqref="A{top}"/></sheetView></sheetViews>"#,
        if keep.tab_selected { r#" tabSelected="1""# } else { "" },
        m.header_row + 1
    ));
    x.push_str(r#"<sheetFormatPr defaultRowHeight="15"/>"#);
    if !m.widths.is_empty() {
        x.push_str("<cols>");
        for (i, w) in m.widths.iter().enumerate() {
            x.push_str(&format!(r#"<col min="{0}" max="{0}" width="{1}" customWidth="1"/>"#, i + 1, w + 0.7109375));
        }
        x.push_str("</cols>");
    }
    x.push_str("<sheetData>");
    let mut xfs: std::collections::HashMap<St, u32> = std::collections::HashMap::new();
    for (r, row) in m.rows.iter().enumerate() {
        let rn = r as u32 + 1;
        if row.is_empty() {
            continue;
        }
        let mut cells = row.clone();
        cells.sort_by_key(|c| c.col);
        x.push_str(&format!(r#"<row r="{rn}">"#));
        for c in &cells {
            let s = *xfs.entry(c.st).or_insert_with(|| xf_for(styles, c.st));
            let r = format!("{}{rn}", col_name(c.col as u32 + 1));
            let sa = if s == 0 { String::new() } else { format!(r#" s="{s}""#) };
            match &c.v {
                V::Str(t) => x.push_str(&format!(
                    r#"<c r="{r}"{sa} t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
                    esc(t)
                )),
                v => {
                    let n = value_number(v, date1904).unwrap_or(0.0);
                    x.push_str(&format!(r#"<c r="{r}"{sa}><v>{}</v></c>"#, num_text(n)));
                }
            }
        }
        x.push_str("</row>");
    }
    x.push_str("</sheetData>");
    if m.cols > 0 {
        x.push_str(&format!(r#"<autoFilter ref="{}"/>"#, esc_attr(&filter_ref(m))));
    }
    x.push_str(r#"<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>"#);
    for t in &keep.tail {
        x.push_str(t);
    }
    x.push_str("</worksheet>");
    x
}

/// "A2:K9" of the program sheet's autofilter.
pub fn filter_ref(m: &SheetModel) -> String {
    format!("A{}:{}{}", m.header_row + 1, col_name(m.cols.max(1) as u32), m.filter_last.max(m.header_row) + 1)
}
