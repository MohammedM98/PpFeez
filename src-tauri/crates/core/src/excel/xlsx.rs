//! Minimal, surgical access to an existing `.xlsx` package (SPEC §6.8.1).
//!
//! Only the parts PpFeez owns are parsed and rewritten; every other part is copied into the new
//! archive byte for byte (`raw_copy_file`), so whatever the owner added in Excel (right-to-left
//! views, extensions, pivot tables, charts, images, their own sheets) survives by construction.
//! Parsing records byte offsets so edits replace exact spans of the original XML.

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read, Write};

/// An unexpected file structure: nothing is written; the message is shown to the owner.
#[derive(Debug, Clone)]
pub struct Layout(pub String);

pub type LResult<T> = Result<T, Layout>;

pub fn layout(msg: impl Into<String>) -> Layout {
    Layout(msg.into())
}

fn unexpected(part: &str) -> Layout {
    layout(format!("بنية ملف Excel غير متوقعة ({part}). اختر «إعادة كتابة كاملة» من الإعدادات أو اختر ملفاً جديداً."))
}

// ===== XML tokens =====

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Start,
    End,
    Empty,
}

/// A tag with its byte span in the source and its (unescaped) attributes.
#[derive(Debug, Clone)]
pub struct Tok {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
    pub name: String,
    pub attrs: Vec<(String, String)>,
}

impl Tok {
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

fn read_attrs(e: &BytesStart<'_>) -> Result<Vec<(String, String)>, String> {
    let mut out = vec![];
    for a in e.attributes() {
        let a = a.map_err(|e| e.to_string())?;
        let key = a.key.into_inner().to_string();
        let raw: &str = &a.value;
        let value = quick_xml::escape::unescape(raw).map_err(|e| e.to_string())?.to_string();
        out.push((key, value));
    }
    Ok(out)
}

/// All tags of a well-formed document (text, comments and declarations are skipped; their bytes
/// stay reachable through the spans).
pub fn tokens(xml: &str) -> Result<Vec<Tok>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut out = vec![];
    let mut depth: i64 = 0;
    loop {
        let start = reader.buffer_position() as usize;
        let ev = reader.read_event().map_err(|e| format!("{e} at {}", reader.error_position()))?;
        let end = reader.buffer_position() as usize;
        match ev {
            Event::Start(e) => {
                depth += 1;
                out.push(Tok {
                    kind: Kind::Start,
                    start,
                    end,
                    name: e.name().into_inner().to_string(),
                    attrs: read_attrs(&e)?,
                })
            }
            Event::Empty(e) => out.push(Tok {
                kind: Kind::Empty,
                start,
                end,
                name: e.name().into_inner().to_string(),
                attrs: read_attrs(&e)?,
            }),
            Event::End(e) => {
                depth -= 1;
                out.push(Tok { kind: Kind::End, start, end, name: e.name().into_inner().to_string(), attrs: vec![] })
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if depth != 0 {
        return Err("unclosed element".into());
    }
    Ok(out)
}

/// Well-formedness check used on every part before an archive is written.
pub fn check_well_formed(xml: &str) -> Result<(), String> {
    tokens(xml).map(|_| ())
}

/// Index of the token closing `toks[i]` (itself for an empty element).
pub fn matching_end(toks: &[Tok], i: usize) -> usize {
    if toks[i].kind == Kind::Empty {
        return i;
    }
    let mut depth = 0;
    for (j, t) in toks.iter().enumerate().skip(i) {
        match t.kind {
            Kind::Start => depth += 1,
            Kind::End => {
                depth -= 1;
                if depth == 0 {
                    return j;
                }
            }
            Kind::Empty => {}
        }
    }
    toks.len() - 1
}

/// Unescaped text between a start tag and its end tag.
pub fn inner_text(xml: &str, open: &Tok, close: &Tok) -> String {
    if open.kind == Kind::Empty {
        return String::new();
    }
    let raw = &xml[open.end..close.start];
    quick_xml::escape::unescape(raw).map(|c| c.to_string()).unwrap_or_else(|_| raw.to_string())
}

/// Escape element text (`<`, `>`, `&`; quotes stay readable).
pub fn esc(s: &str) -> String {
    quick_xml::escape::partial_escape(s).to_string()
}

/// Canonical form of an element (sorted attributes, `apply*` flags optional) used to find an
/// existing style equal to one PpFeez needs, whatever attribute order Excel saved.
pub fn canonical(raw: &str, ignore_apply: bool) -> String {
    let Ok(toks) = tokens(raw) else { return raw.to_string() };
    let mut out = String::new();
    for t in toks {
        match t.kind {
            Kind::End => {
                out.push_str("</");
                out.push_str(&t.name);
                out.push('>');
            }
            _ => {
                let mut attrs: Vec<&(String, String)> =
                    t.attrs.iter().filter(|(k, _)| !(ignore_apply && k.starts_with("apply"))).collect();
                attrs.sort();
                out.push('<');
                out.push_str(&t.name);
                for (k, v) in attrs {
                    out.push_str(&format!(" {k}=\"{v}\""));
                }
                out.push_str(if t.kind == Kind::Empty { "/>" } else { ">" });
            }
        }
    }
    out
}

/// Rebuild a start tag with one attribute set (added when missing) and others removed.
pub fn retag(tok: &Tok, set: &[(&str, String)], remove: &[&str]) -> String {
    let mut attrs: Vec<(String, String)> =
        tok.attrs.iter().filter(|(k, _)| !remove.contains(&k.as_str())).cloned().collect();
    for (k, v) in set {
        match attrs.iter_mut().find(|(a, _)| a == k) {
            Some(a) => a.1 = v.clone(),
            None => attrs.push((k.to_string(), v.clone())),
        }
    }
    let mut s = format!("<{}", tok.name);
    for (k, v) in attrs {
        s.push_str(&format!(" {k}=\"{}\"", esc_attr(&v)));
    }
    s.push_str(if tok.kind == Kind::Empty { "/>" } else { ">" });
    s
}

pub fn esc_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Apply non-overlapping `(start, end, replacement)` edits to `src`.
pub fn apply_edits(src: &str, mut edits: Vec<(usize, usize, String)>) -> String {
    edits.sort_by_key(|e| (e.0, e.1));
    let mut out = String::with_capacity(src.len() + edits.iter().map(|e| e.2.len()).sum::<usize>());
    let mut pos = 0;
    for (s, e, text) in edits {
        out.push_str(&src[pos..s]);
        out.push_str(&text);
        pos = e;
    }
    out.push_str(&src[pos..]);
    out
}

// ===== Cell references =====

pub fn col_name(mut col: u32) -> String {
    let mut s = Vec::new();
    while col > 0 {
        let r = ((col - 1) % 26) as u8;
        s.push((b'A' + r) as char);
        col = (col - 1) / 26;
    }
    s.iter().rev().collect()
}

/// "AB12" → (28, 12); "$A$1" accepted.
pub fn parse_ref(r: &str) -> Option<(u32, u32)> {
    let r = r.replace('$', "");
    let split = r.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = r.split_at(split);
    if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let col = letters.to_ascii_uppercase().bytes().fold(0u32, |a, b| a * 26 + (b - b'A' + 1) as u32);
    Some((col, digits.parse().ok()?))
}

/// "A1:Q20" → ((1,1),(17,20)); a single cell is a 1×1 range.
pub fn parse_range(r: &str) -> Option<((u32, u32), (u32, u32))> {
    let mut it = r.split(':');
    let a = parse_ref(it.next()?)?;
    let b = match it.next() {
        Some(x) => parse_ref(x)?,
        None => a,
    };
    Some(((a.0.min(b.0), a.1.min(b.1)), (a.0.max(b.0), a.1.max(b.1))))
}

pub fn range_str(a: (u32, u32), b: (u32, u32)) -> String {
    format!("{}{}:{}{}", col_name(a.0), a.1, col_name(b.0), b.1)
}

/// Move relative row references of an A1 formula by `delta` rows (fill-down). String literals,
/// structured references (`[...]`), absolute rows (`$5`) and function names are left alone.
pub fn shift_formula_rows(f: &str, delta: i64) -> String {
    let chars: Vec<char> = f.chars().collect();
    let mut out = String::with_capacity(f.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            let start = i;
            i += 1;
            while i < chars.len() {
                if chars[i] == '"' {
                    if i + 1 < chars.len() && chars[i + 1] == '"' {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i = (i + 1).min(chars.len());
            out.extend(&chars[start..i]);
            continue;
        }
        if c == '\'' {
            let start = i;
            i += 1;
            while i < chars.len() && chars[i] != '\'' {
                i += 1;
            }
            i = (i + 1).min(chars.len());
            out.extend(&chars[start..i]);
            continue;
        }
        if c == '[' {
            let start = i;
            let mut depth = 0;
            while i < chars.len() {
                if chars[i] == '[' {
                    depth += 1;
                } else if chars[i] == ']' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                i += 1;
            }
            i = (i + 1).min(chars.len());
            out.extend(&chars[start..i]);
            continue;
        }
        let prev_ok = i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '_' || chars[i - 1] == '.');
        if prev_ok && (c == '$' || c.is_ascii_alphabetic()) {
            // [$]LETTERS[$]DIGITS not followed by a name character or "("
            let mut j = i;
            if chars[j] == '$' {
                j += 1;
            }
            let ls = j;
            while j < chars.len() && chars[j].is_ascii_alphabetic() {
                j += 1;
            }
            let letters = j - ls;
            let abs_row = j < chars.len() && chars[j] == '$';
            if abs_row {
                j += 1;
            }
            let ds = j;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            let digits = j - ds;
            let next_ok = j >= chars.len() || !(chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '(');
            if (1..=3).contains(&letters) && digits > 0 && next_ok {
                let row: i64 = chars[ds..j].iter().collect::<String>().parse().unwrap_or(0);
                out.extend(&chars[i..ds]);
                if abs_row {
                    out.push_str(&row.to_string());
                } else {
                    out.push_str(&(row + delta).max(1).to_string());
                }
                i = j;
                continue;
            }
            // Not a reference: copy the whole name so its digits are not mistaken for one.
            let mut k = i + 1;
            while k < chars.len() && (chars[k].is_alphanumeric() || chars[k] == '_' || chars[k] == '.') {
                k += 1;
            }
            out.extend(&chars[i..k]);
            i = k;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

// ===== Package =====

pub struct Package {
    archive: zip::ZipArchive<Cursor<Vec<u8>>>,
    names: Vec<String>,
    changed: BTreeMap<String, String>,
    removed: BTreeSet<String>,
}

impl Package {
    pub fn open(bytes: Vec<u8>) -> LResult<Package> {
        let archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|_| layout("الملف ليس ملف Excel صالحاً (‎.xlsx). اختر ملفاً آخر أو «إعادة كتابة كاملة»."))?;
        let names = archive.file_names().filter_map(|n| n.ok()).map(|n| n.to_string()).collect();
        Ok(Package { archive, names, changed: BTreeMap::new(), removed: BTreeSet::new() })
    }

    pub fn has(&self, name: &str) -> bool {
        !self.removed.contains(name) && (self.changed.contains_key(name) || self.names.iter().any(|n| n == name))
    }

    pub fn read(&mut self, name: &str) -> LResult<Option<String>> {
        if self.removed.contains(name) {
            return Ok(None);
        }
        if let Some(s) = self.changed.get(name) {
            return Ok(Some(s.clone()));
        }
        if !self.names.iter().any(|n| n == name) {
            return Ok(None);
        }
        let mut f = self.archive.by_name(name).map_err(|_| unexpected(name))?;
        let mut bytes = vec![];
        f.read_to_end(&mut bytes).map_err(|_| unexpected(name))?;
        let s = String::from_utf8(bytes).map_err(|_| unexpected(name))?;
        Ok(Some(s.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(s)))
    }

    pub fn put(&mut self, name: &str, xml: String) {
        self.removed.remove(name);
        self.changed.insert(name.to_string(), xml);
    }

    pub fn remove(&mut self, name: &str) {
        self.changed.remove(name);
        self.removed.insert(name.to_string());
    }

    pub fn changed_parts(&self) -> Vec<String> {
        self.changed.keys().cloned().collect()
    }

    /// Write the new archive: changed parts are recompressed, everything else is copied raw.
    pub fn finish(mut self) -> Result<Vec<u8>, String> {
        for (name, xml) in &self.changed {
            check_well_formed(xml).map_err(|e| format!("{name}: {e}"))?;
        }
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut written = BTreeSet::new();
        for i in 0..self.archive.len() {
            let name = self.names.get(i).cloned().unwrap_or_default();
            if self.removed.contains(&name) {
                continue;
            }
            if let Some(xml) = self.changed.get(&name) {
                w.start_file(name.clone(), opts).map_err(|e| e.to_string())?;
                w.write_all(xml.as_bytes()).map_err(|e| e.to_string())?;
            } else {
                let f = self.archive.by_index_raw(i).map_err(|e| e.to_string())?;
                w.raw_copy_file(f).map_err(|e| e.to_string())?;
            }
            written.insert(name);
        }
        for (name, xml) in &self.changed {
            if !written.contains(name) {
                w.start_file(name.clone(), opts).map_err(|e| e.to_string())?;
                w.write_all(xml.as_bytes()).map_err(|e| e.to_string())?;
            }
        }
        Ok(w.finish().map_err(|e| e.to_string())?.into_inner())
    }
}

// ===== Relationships and workbook =====

#[derive(Debug, Clone)]
pub struct Rel {
    pub id: String,
    pub typ: String,
    pub target: String,
    pub external: bool,
}

pub fn rels_path(part: &str) -> String {
    match part.rfind('/') {
        Some(p) => format!("{}/_rels/{}.rels", &part[..p], &part[p + 1..]),
        None => format!("_rels/{part}.rels"),
    }
}

/// Resolve a relationship target relative to the part that owns the relationship.
pub fn resolve(part: &str, target: &str) -> String {
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_string();
    }
    let mut segs: Vec<&str> = match part.rfind('/') {
        Some(p) => part[..p].split('/').collect(),
        None => vec![],
    };
    for s in target.split('/') {
        match s {
            ".." => {
                segs.pop();
            }
            "." | "" => {}
            s => segs.push(s),
        }
    }
    segs.join("/")
}

pub fn parse_rels(xml: &str) -> LResult<Vec<Rel>> {
    let toks = tokens(xml).map_err(|_| unexpected("rels"))?;
    Ok(toks
        .iter()
        .filter(|t| t.kind != Kind::End && t.name == "Relationship")
        .map(|t| Rel {
            id: t.attr("Id").unwrap_or_default().to_string(),
            typ: t.attr("Type").unwrap_or_default().to_string(),
            target: t.attr("Target").unwrap_or_default().to_string(),
            external: t.attr("TargetMode") == Some("External"),
        })
        .collect())
}

pub fn rels_of(pkg: &mut Package, part: &str) -> LResult<Vec<Rel>> {
    match pkg.read(&rels_path(part))? {
        Some(x) => parse_rels(&x),
        None => Ok(vec![]),
    }
}

#[derive(Debug, Clone)]
pub struct WbSheet {
    pub name: String,
    pub rid: String,
    /// Position among the workbook's sheets (`localSheetId` of defined names).
    pub index: usize,
    pub path: String,
}

pub struct WorkbookInfo {
    pub sheets: Vec<WbSheet>,
    pub date1904: bool,
}

pub fn workbook_info(pkg: &mut Package) -> LResult<WorkbookInfo> {
    let xml = pkg.read("xl/workbook.xml")?.ok_or_else(|| unexpected("workbook"))?;
    let toks = tokens(&xml).map_err(|_| unexpected("workbook"))?;
    if toks.first().map(|t| t.name.as_str()) != Some("workbook") {
        return Err(unexpected("workbook"));
    }
    let rels = rels_of(pkg, "xl/workbook.xml")?;
    let mut sheets = vec![];
    let mut date1904 = false;
    for t in &toks {
        if t.kind == Kind::End {
            continue;
        }
        if t.name == "workbookPr" {
            date1904 = matches!(t.attr("date1904"), Some("1") | Some("true"));
        }
        if t.name == "sheet" {
            let rid = t.attr("r:id").unwrap_or_default().to_string();
            let path = rels
                .iter()
                .find(|r| r.id == rid)
                .map(|r| resolve("xl/workbook.xml", &r.target))
                .ok_or_else(|| unexpected("workbook rels"))?;
            sheets.push(WbSheet {
                name: t.attr("name").unwrap_or_default().to_string(),
                rid,
                index: sheets.len(),
                path,
            });
        }
    }
    Ok(WorkbookInfo { sheets, date1904 })
}

/// Shared strings (`<si>` text, phonetic runs excluded).
pub fn shared_strings(pkg: &mut Package) -> LResult<Vec<String>> {
    let rels = rels_of(pkg, "xl/workbook.xml")?;
    let Some(rel) = rels.iter().find(|r| r.typ.ends_with("/sharedStrings")) else { return Ok(vec![]) };
    let path = resolve("xl/workbook.xml", &rel.target);
    let Some(xml) = pkg.read(&path)? else { return Ok(vec![]) };
    let toks = tokens(&xml).map_err(|_| unexpected("sharedStrings"))?;
    let mut out = vec![];
    let mut i = 0;
    while i < toks.len() {
        if toks[i].name == "si" && toks[i].kind != Kind::End {
            let end = matching_end(&toks, i);
            let mut s = String::new();
            let mut j = i + 1;
            while j < end {
                if toks[j].name == "rPh" && toks[j].kind == Kind::Start {
                    j = matching_end(&toks, j) + 1;
                    continue;
                }
                if toks[j].name == "t" && toks[j].kind == Kind::Start {
                    let close = matching_end(&toks, j);
                    s.push_str(&inner_text(&xml, &toks[j], &toks[close]));
                    j = close + 1;
                    continue;
                }
                j += 1;
            }
            out.push(s);
            i = end + 1;
        } else {
            i += 1;
        }
    }
    Ok(out)
}

// ===== Styles =====

struct Sec {
    open: usize,
    open_end: usize,
    close: usize,
    tok: Tok,
    items: Vec<String>,
    added: Vec<String>,
}

impl Sec {
    fn len(&self) -> usize {
        self.items.len() + self.added.len()
    }

    fn get(&self, i: usize) -> Option<&String> {
        if i < self.items.len() {
            self.items.get(i)
        } else {
            self.added.get(i - self.items.len())
        }
    }

    fn find_or_add(&mut self, raw: String, ignore_apply: bool) -> usize {
        let c = canonical(&raw, ignore_apply);
        if let Some(i) = self.items.iter().chain(self.added.iter()).position(|x| canonical(x, ignore_apply) == c) {
            return i;
        }
        self.added.push(raw);
        self.len() - 1
    }
}

/// `styles.xml` with append-only additions (existing indexes never move).
pub struct StylesDoc {
    xml: String,
    root_open_end: usize,
    numfmts: Option<Sec>,
    custom_fmts: Vec<(u32, String)>,
    new_fmts: Vec<(u32, String)>,
    fonts: Sec,
    fills: Sec,
    xfs: Sec,
}

/// Built-in number formats PpFeez uses or recognises.
fn builtin_fmt(id: u32) -> Option<&'static str> {
    Some(match id {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        14 => "m/d/yyyy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yyyy h:mm",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mm:ss.0",
        _ => return None,
    })
}

impl StylesDoc {
    pub fn parse(xml: String) -> LResult<StylesDoc> {
        let toks = tokens(&xml).map_err(|_| unexpected("styles"))?;
        let root = toks.first().ok_or_else(|| unexpected("styles"))?;
        if root.name != "styleSheet" || root.kind != Kind::Start {
            return Err(unexpected("styles"));
        }
        let root_open_end = root.end;
        let mut secs: BTreeMap<String, Sec> = BTreeMap::new();
        let mut depth = 0;
        let mut i = 0;
        while i < toks.len() {
            let t = &toks[i];
            if depth == 1 && t.kind != Kind::End && ["numFmts", "fonts", "fills", "cellXfs"].contains(&t.name.as_str())
            {
                if t.kind == Kind::Empty {
                    if t.name == "numFmts" {
                        i += 1;
                        continue;
                    }
                    return Err(unexpected("styles"));
                }
                let end = matching_end(&toks, i);
                let mut items = vec![];
                let mut j = i + 1;
                while j < end {
                    let close = matching_end(&toks, j);
                    items.push(xml[toks[j].start..toks[close].end].to_string());
                    j = close + 1;
                }
                secs.insert(
                    t.name.clone(),
                    Sec {
                        open: t.start,
                        open_end: t.end,
                        close: toks[end].start,
                        tok: t.clone(),
                        items,
                        added: vec![],
                    },
                );
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
        let numfmts = secs.remove("numFmts");
        let custom_fmts = numfmts
            .as_ref()
            .map(|s| {
                s.items
                    .iter()
                    .filter_map(|raw| {
                        let t = tokens(raw).ok()?.into_iter().next()?;
                        Some((t.attr("numFmtId")?.parse().ok()?, t.attr("formatCode")?.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let take = |secs: &mut BTreeMap<String, Sec>, k: &str| secs.remove(k).ok_or_else(|| unexpected("styles"));
        let fonts = take(&mut secs, "fonts")?;
        let fills = take(&mut secs, "fills")?;
        let xfs = take(&mut secs, "cellXfs")?;
        if fonts.items.is_empty() || xfs.items.is_empty() {
            return Err(unexpected("styles"));
        }
        Ok(StylesDoc { xml, root_open_end, numfmts, custom_fmts, new_fmts: vec![], fonts, fills, xfs })
    }

    pub fn fmt_code(&self, id: u32) -> Option<String> {
        self.custom_fmts
            .iter()
            .chain(self.new_fmts.iter())
            .find(|(i, _)| *i == id)
            .map(|(_, c)| c.clone())
            .or_else(|| builtin_fmt(id).map(str::to_string))
    }

    /// Id of a number format with this code, added when missing.
    pub fn num_fmt(&mut self, code: &str) -> u32 {
        for id in [0u32, 1, 2, 3, 4, 9, 10] {
            if builtin_fmt(id) == Some(code) {
                return id;
            }
        }
        if let Some((id, _)) = self.custom_fmts.iter().chain(self.new_fmts.iter()).find(|(_, c)| c == code) {
            return *id;
        }
        let id = self.custom_fmts.iter().chain(self.new_fmts.iter()).map(|(i, _)| *i).max().unwrap_or(163).max(163) + 1;
        self.new_fmts.push((id, code.to_string()));
        id
    }

    fn xf_tok(&self, xf: usize) -> Option<Tok> {
        self.xfs.get(xf).and_then(|raw| tokens(raw).ok()).and_then(|t| t.into_iter().next())
    }

    /// Number format id of a cell style.
    pub fn xf_num_fmt(&self, xf: usize) -> u32 {
        self.xf_tok(xf).and_then(|t| t.attr("numFmtId").and_then(|v| v.parse().ok())).unwrap_or(0)
    }

    /// The same cell style with another number format (found or appended).
    pub fn derive_xf(&mut self, base: usize, num_fmt: u32) -> usize {
        let Some(raw) = self.xfs.get(base).cloned() else { return self.plain_xf(num_fmt) };
        let Ok(toks) = tokens(&raw) else { return self.plain_xf(num_fmt) };
        let head = retag(&toks[0], &[("numFmtId", num_fmt.to_string()), ("applyNumberFormat", "1".into())], &[]);
        let new = format!("{head}{}", &raw[toks[0].end..]);
        self.xfs.find_or_add(new, true)
    }

    fn plain_xf(&mut self, num_fmt: u32) -> usize {
        self.xfs.find_or_add(
            format!(r#"<xf numFmtId="{num_fmt}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>"#),
            true,
        )
    }

    /// A font based on the workbook's default font (index 0).
    pub fn font(&mut self, bold: bool, strike: bool, color_rgb: Option<&str>) -> usize {
        if !bold && !strike && color_rgb.is_none() {
            return 0;
        }
        let base = self.fonts.items[0].clone();
        let toks = tokens(&base).unwrap_or_default();
        let mut children: BTreeMap<String, String> = BTreeMap::new();
        for t in toks.iter().skip(1) {
            if t.kind == Kind::Empty {
                children.insert(t.name.clone(), base[t.start..t.end].to_string());
            }
        }
        if bold {
            children.insert("b".into(), "<b/>".into());
        }
        if strike {
            children.insert("strike".into(), "<strike/>".into());
        }
        if let Some(rgb) = color_rgb {
            children.insert("color".into(), format!(r#"<color rgb="{rgb}"/>"#));
        }
        let order = [
            "b",
            "i",
            "strike",
            "condense",
            "extend",
            "outline",
            "shadow",
            "u",
            "vertAlign",
            "sz",
            "color",
            "name",
            "family",
            "charset",
            "scheme",
        ];
        let mut raw = String::from("<font>");
        for k in order {
            if let Some(c) = children.get(k) {
                raw.push_str(c);
            }
        }
        raw.push_str("</font>");
        self.fonts.find_or_add(raw, false)
    }

    pub fn solid_fill(&mut self, rgb: &str) -> usize {
        self.fills.find_or_add(
            format!(r#"<fill><patternFill patternType="solid"><fgColor rgb="{rgb}"/><bgColor indexed="64"/></patternFill></fill>"#),
            false,
        )
    }

    pub fn xf(&mut self, num_fmt: u32, font: usize, fill: usize, center: bool) -> usize {
        let mut raw = format!(r#"<xf numFmtId="{num_fmt}" fontId="{font}" fillId="{fill}" borderId="0" xfId="0""#);
        if num_fmt != 0 {
            raw.push_str(r#" applyNumberFormat="1""#);
        }
        if font != 0 {
            raw.push_str(r#" applyFont="1""#);
        }
        if fill != 0 {
            raw.push_str(r#" applyFill="1""#);
        }
        if center {
            raw.push_str(r#" applyAlignment="1"><alignment horizontal="center"/></xf>"#);
        } else {
            raw.push_str("/>");
        }
        self.xfs.find_or_add(raw, true)
    }

    pub fn is_changed(&self) -> bool {
        !self.new_fmts.is_empty()
            || !self.fonts.added.is_empty()
            || !self.fills.added.is_empty()
            || !self.xfs.added.is_empty()
    }

    pub fn serialize(self) -> String {
        let mut edits: Vec<(usize, usize, String)> = vec![];
        for sec in [&self.fonts, &self.fills, &self.xfs] {
            if !sec.added.is_empty() {
                edits.push((sec.open, sec.open_end, retag(&sec.tok, &[("count", sec.len().to_string())], &[])));
                edits.push((sec.close, sec.close, sec.added.concat()));
            }
        }
        if !self.new_fmts.is_empty() {
            let new: String = self
                .new_fmts
                .iter()
                .map(|(id, code)| format!(r#"<numFmt numFmtId="{id}" formatCode="{}"/>"#, esc_attr(code)))
                .collect();
            match &self.numfmts {
                Some(sec) => {
                    let count = sec.items.len() + self.new_fmts.len();
                    edits.push((sec.open, sec.open_end, retag(&sec.tok, &[("count", count.to_string())], &[])));
                    edits.push((sec.close, sec.close, new));
                }
                None => {
                    // Absent or `<numFmts/>`: a new section right after the root tag (first child).
                    let empty = tokens(&self.xml)
                        .ok()
                        .and_then(|t| t.into_iter().find(|t| t.name == "numFmts" && t.kind == Kind::Empty));
                    let section = format!(r#"<numFmts count="{}">{new}</numFmts>"#, self.new_fmts.len());
                    match empty {
                        Some(t) => edits.push((t.start, t.end, section)),
                        None => edits.push((self.root_open_end, self.root_open_end, section)),
                    }
                }
            }
        }
        apply_edits(&self.xml, edits)
    }
}

/// Decimals shown by a number format code ("#,##0.00 [$USD]" → 2); None when not numeric.
pub fn fmt_decimals(code: &str) -> Option<usize> {
    let first = code.split(';').next().unwrap_or("");
    let cleaned = strip_quoted(first);
    if !cleaned.contains('0') && !cleaned.contains('#') {
        return None;
    }
    Some(match cleaned.find('.') {
        Some(p) => cleaned[p + 1..].chars().take_while(|c| *c == '0' || *c == '#').count(),
        None => 0,
    })
}

fn strip_quoted(code: &str) -> String {
    let mut out = String::new();
    let mut in_q = false;
    let mut in_b = false;
    for c in code.chars() {
        match c {
            '"' => in_q = !in_q,
            '[' if !in_q => in_b = true,
            ']' if !in_q => in_b = false,
            _ if in_q || in_b => {}
            _ => out.push(c),
        }
    }
    out
}

/// Whether a number format shows a date or time.
pub fn fmt_is_date(code: &str) -> bool {
    let s = strip_quoted(code).to_ascii_lowercase();
    s.contains('y') || s.contains('d') || s.contains('h') || (s.contains('m') && !s.contains('0'))
}

// ===== Worksheets =====

#[derive(Debug, Clone)]
pub struct Formula {
    pub text: String,
    pub t: Option<String>,
    pub si: Option<String>,
    pub reference: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Cell {
    pub col: u32,
    pub start: usize,
    pub end: usize,
    pub s: Option<u32>,
    pub t: Option<String>,
    pub v: Option<String>,
    pub inline: Option<String>,
    pub f: Option<Formula>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Empty,
    Str(String),
    Num(f64),
    Other(String),
}

impl Cell {
    pub fn value(&self, sst: &[String]) -> CellValue {
        match self.t.as_deref() {
            Some("s") => self
                .v
                .as_deref()
                .and_then(|v| v.trim().parse::<usize>().ok())
                .and_then(|i| sst.get(i))
                .map(|s| CellValue::Str(s.clone()))
                .unwrap_or(CellValue::Empty),
            Some("inlineStr") => CellValue::Str(self.inline.clone().unwrap_or_default()),
            Some("str") => CellValue::Str(self.v.clone().unwrap_or_default()),
            Some("b") | Some("e") | Some("d") => self.v.clone().map(CellValue::Other).unwrap_or(CellValue::Empty),
            _ => match self.v.as_deref().map(str::trim) {
                None | Some("") => CellValue::Empty,
                Some(v) => v.parse::<f64>().map(CellValue::Num).unwrap_or(CellValue::Other(v.to_string())),
            },
        }
    }

    /// A literal value the owner typed (formulas and empty styled cells do not count).
    pub fn has_literal(&self) -> bool {
        self.f.is_none() && (self.v.as_deref().map(|v| !v.is_empty()).unwrap_or(false) || self.inline.is_some())
    }
}

#[derive(Debug, Clone)]
pub struct Row {
    pub r: u32,
    pub start: usize,
    pub end: usize,
    pub tok: Tok,
    pub cells: Vec<Cell>,
}

impl Row {
    pub fn cell(&self, col: u32) -> Option<&Cell> {
        self.cells.iter().find(|c| c.col == col)
    }
}

pub struct SheetDoc {
    pub xml: String,
    pub rows: Vec<Row>,
    /// Where new rows go when no later row exists: `</sheetData>` (or the `<sheetData/>` span).
    pub data_close: usize,
    pub data_empty: Option<(usize, usize)>,
    pub dimension: Option<(usize, usize, String)>,
    pub auto_filter: Option<(usize, usize, Tok)>,
    pub merges: Vec<String>,
    pub table_rids: Vec<String>,
    pub sheet_pr: Option<String>,
    pub tab_selected: bool,
    /// Elements that point at relationships (drawings, comments' VML, pictures, controls).
    pub keep_tail: Vec<String>,
}

impl SheetDoc {
    pub fn parse(xml: String) -> LResult<SheetDoc> {
        let toks = tokens(&xml).map_err(|_| unexpected("worksheet"))?;
        let root = toks.first().ok_or_else(|| unexpected("worksheet"))?;
        if root.name != "worksheet" {
            return Err(unexpected("worksheet"));
        }
        let mut doc = SheetDoc {
            xml: String::new(),
            rows: vec![],
            data_close: 0,
            data_empty: None,
            dimension: None,
            auto_filter: None,
            merges: vec![],
            table_rids: vec![],
            sheet_pr: None,
            tab_selected: false,
            keep_tail: vec![],
        };
        let mut found_data = false;
        let mut i = 1;
        while i < toks.len() {
            let t = &toks[i];
            if t.kind == Kind::End {
                i += 1;
                continue;
            }
            let end = matching_end(&toks, i);
            match t.name.as_str() {
                "sheetPr" => doc.sheet_pr = Some(xml[t.start..toks[end].end].to_string()),
                "dimension" => doc.dimension = Some((t.start, toks[end].end, t.attr("ref").unwrap_or_default().into())),
                "sheetViews" => {
                    doc.tab_selected = toks[i..=end]
                        .iter()
                        .any(|v| v.name == "sheetView" && matches!(v.attr("tabSelected"), Some("1") | Some("true")));
                }
                "sheetData" => {
                    found_data = true;
                    if t.kind == Kind::Empty {
                        doc.data_empty = Some((t.start, t.end));
                        doc.data_close = t.start;
                    } else {
                        doc.data_close = toks[end].start;
                        doc.rows = parse_rows(&xml, &toks[i + 1..end])?;
                    }
                }
                "autoFilter" => doc.auto_filter = Some((t.start, toks[end].end, t.clone())),
                "mergeCells" => {
                    for m in &toks[i..=end] {
                        if m.name == "mergeCell" && m.kind != Kind::End {
                            doc.merges.push(m.attr("ref").unwrap_or_default().to_string());
                        }
                    }
                }
                "tableParts" => {
                    for p in &toks[i..=end] {
                        if p.name == "tablePart" && p.kind != Kind::End {
                            doc.table_rids.push(p.attr("r:id").unwrap_or_default().to_string());
                        }
                    }
                }
                "drawing" | "legacyDrawing" | "legacyDrawingHF" | "picture" | "oleObjects" | "controls" => {
                    doc.keep_tail.push(xml[t.start..toks[end].end].to_string());
                }
                _ => {}
            }
            i = end + 1;
        }
        if !found_data {
            return Err(unexpected("worksheet"));
        }
        doc.xml = xml;
        Ok(doc)
    }

    pub fn row(&self, r: u32) -> Option<&Row> {
        self.rows.iter().find(|x| x.r == r)
    }
}

fn parse_rows(xml: &str, toks: &[Tok]) -> LResult<Vec<Row>> {
    let mut rows = vec![];
    let mut i = 0;
    let mut last_r = 0;
    while i < toks.len() {
        let t = &toks[i];
        if t.name != "row" || t.kind == Kind::End {
            return Err(unexpected("sheetData"));
        }
        let end = matching_end(toks, i);
        let r = t.attr("r").and_then(|v| v.parse().ok()).unwrap_or(last_r + 1);
        if r <= last_r {
            return Err(unexpected("sheetData"));
        }
        last_r = r;
        let mut cells = vec![];
        let mut j = i + 1;
        let mut last_c = 0;
        while j < end {
            let c = &toks[j];
            let cend = matching_end(toks, j);
            if c.name == "c" {
                let col = match c.attr("r") {
                    Some(rf) => parse_ref(rf).map(|x| x.0).ok_or_else(|| unexpected("cell"))?,
                    None => last_c + 1,
                };
                last_c = col;
                let mut cell = Cell {
                    col,
                    start: c.start,
                    end: toks[cend].end,
                    s: c.attr("s").and_then(|v| v.parse().ok()),
                    t: c.attr("t").map(str::to_string),
                    v: None,
                    inline: None,
                    f: None,
                };
                let mut k = j + 1;
                while k < cend {
                    let e = &toks[k];
                    let kend = matching_end(toks, k);
                    match e.name.as_str() {
                        "v" => cell.v = Some(inner_text(xml, e, &toks[kend])),
                        "f" => {
                            cell.f = Some(Formula {
                                text: inner_text(xml, e, &toks[kend]),
                                t: e.attr("t").map(str::to_string),
                                si: e.attr("si").map(str::to_string),
                                reference: e.attr("ref").map(str::to_string),
                            })
                        }
                        "is" => {
                            let mut s = String::new();
                            let mut m = k + 1;
                            while m < kend {
                                if toks[m].name == "rPh" && toks[m].kind == Kind::Start {
                                    m = matching_end(toks, m) + 1;
                                    continue;
                                }
                                if toks[m].name == "t" && toks[m].kind == Kind::Start {
                                    let close = matching_end(toks, m);
                                    s.push_str(&inner_text(xml, &toks[m], &toks[close]));
                                    m = close + 1;
                                    continue;
                                }
                                m += 1;
                            }
                            cell.inline = Some(s);
                        }
                        _ => {}
                    }
                    k = kend + 1;
                }
                cells.push(cell);
            }
            j = cend + 1;
        }
        rows.push(Row { r, start: t.start, end: toks[end].end, tok: t.clone(), cells });
        i = end + 1;
    }
    Ok(rows)
}

// ===== Cell XML =====

pub fn cell_ref(col: u32, row: u32) -> String {
    format!("{}{row}", col_name(col))
}

fn s_attr(s: Option<u32>) -> String {
    s.map(|s| format!(r#" s="{s}""#)).unwrap_or_default()
}

pub fn cell_str(col: u32, row: u32, s: Option<u32>, text: &str) -> String {
    format!(
        r#"<c r="{}"{} t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
        cell_ref(col, row),
        s_attr(s),
        esc(text)
    )
}

pub fn num_text(v: f64) -> String {
    if v.is_finite() {
        format!("{v}")
    } else {
        "0".into()
    }
}

pub fn cell_num(col: u32, row: u32, s: Option<u32>, v: f64) -> String {
    format!(r#"<c r="{}"{}><v>{}</v></c>"#, cell_ref(col, row), s_attr(s), num_text(v))
}

pub fn cell_empty(col: u32, row: u32, s: Option<u32>) -> String {
    format!(r#"<c r="{}"{}/>"#, cell_ref(col, row), s_attr(s))
}

pub fn cell_formula(col: u32, row: u32, s: Option<u32>, f: &str) -> String {
    format!(r#"<c r="{}"{}><f>{}</f></c>"#, cell_ref(col, row), s_attr(s), esc(f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_and_formula_shift() {
        assert_eq!(col_name(1), "A");
        assert_eq!(col_name(28), "AB");
        assert_eq!(parse_ref("$AB$12"), Some((28, 12)));
        assert_eq!(parse_range("A1:Q20"), Some(((1, 1), (17, 20))));
        assert_eq!(shift_formula_rows("H2*2+$C$1+C$3+SUM(A2:B2)", 3), "H5*2+$C$1+C$3+SUM(A5:B5)");
        assert_eq!(
            shift_formula_rows(r#"IF(A2="B2",LOG10(A2),'ورقة 2'!C2)"#, 1),
            r#"IF(A3="B2",LOG10(A3),'ورقة 2'!C3)"#
        );
        assert_eq!(shift_formula_rows("Transactions[[#This Row],[Q1]]*2", 4), "Transactions[[#This Row],[Q1]]*2");
        assert_eq!(fmt_decimals("#,##0.00 [$USD]"), Some(2));
        assert_eq!(fmt_decimals("#,##0"), Some(0));
        assert!(fmt_is_date("yyyy-mm-dd hh:mm"));
        assert!(!fmt_is_date("#,##0.00"));
        assert_eq!(resolve("xl/workbook.xml", "worksheets/sheet1.xml"), "xl/worksheets/sheet1.xml");
        assert_eq!(resolve("xl/worksheets/sheet1.xml", "../tables/table1.xml"), "xl/tables/table1.xml");
        assert_eq!(resolve("xl/workbook.xml", "/xl/worksheets/sheet2.xml"), "xl/worksheets/sheet2.xml");
        assert_eq!(rels_path("xl/worksheets/sheet1.xml"), "xl/worksheets/_rels/sheet1.xml.rels");
    }
}
