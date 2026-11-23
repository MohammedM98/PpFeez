//! Money in integer minor units. The only two conversion functions are
//! [`parse_amount`] and [`format_amount`] (SPEC §2). No floating point anywhere.

use crate::error::{AppError, AppResult};

/// Currencies without a fractional part.
const ZERO_DECIMAL: [&str; 3] = ["JPY", "HUF", "TWD"];

pub fn decimals(currency: &str) -> u32 {
    if ZERO_DECIMAL.contains(&currency.to_ascii_uppercase().as_str()) {
        0
    } else {
        2
    }
}

/// Validate and normalize an ISO-4217 code (three ASCII letters).
pub fn normalize_currency(code: &str) -> AppResult<String> {
    let c = code.trim().to_ascii_uppercase();
    if c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()) {
        Ok(c)
    } else {
        Err(AppError::validation("currency", "رمز العملة يجب أن يكون 3 أحرف لاتينية مثل USD"))
    }
}

fn symbol_currency(sym: char) -> Option<&'static str> {
    match sym {
        '$' => Some("USD"),
        '€' => Some("EUR"),
        '£' => Some("GBP"),
        '¥' => Some("JPY"),
        '₺' => Some("TRY"),
        _ => None,
    }
}

/// Parse a human-written amount into minor units of `currency`.
///
/// Accepts `1,234.56`, `1.234,56`, `50,00`, `$1,234.56 USD`, `€50,00`, a leading `-`/`−`,
/// and Arabic-Indic digits. The currency symbol or code inside the text is ignored (the
/// caller decides the currency). When both `,` and `.` appear, the last one is the decimal
/// separator; when only one kind appears, it is a decimal separator if followed by 1–2
/// digits once (for 2-decimal currencies), otherwise a thousands separator.
pub fn parse_amount(text: &str, currency: &str) -> Option<i64> {
    let dec = decimals(currency);
    let mut negative = false;
    let mut s = String::new();
    for ch in text.trim().chars() {
        match ch {
            '0'..='9' | ',' | '.' => s.push(ch),
            '\u{0660}'..='\u{0669}' => s.push(char::from(b'0' + (ch as u32 - 0x0660) as u8)),
            '\u{06F0}'..='\u{06F9}' => s.push(char::from(b'0' + (ch as u32 - 0x06F0) as u8)),
            '٫' => s.push('.'),
            '٬' => s.push(','),
            '-' | '−' | '–' => {
                if !s.is_empty() || negative {
                    return None;
                }
                negative = true;
            }
            c if c.is_whitespace() || c == '\u{a0}' || c == '\u{202f}' || c == '\'' => {}
            // Currency codes and symbols are ignored; the caller decides the currency.
            c if c.is_ascii_alphabetic() || symbol_currency(c).is_some() || c == '+' => {}
            _ => return None,
        }
    }
    if s.is_empty() || !s.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    // Determine the decimal separator.
    let last_comma = s.rfind(',');
    let last_dot = s.rfind('.');
    let dec_sep: Option<char> = match (last_comma, last_dot) {
        (Some(c), Some(d)) => Some(if c > d { ',' } else { '.' }),
        (Some(_), None) | (None, Some(_)) => {
            let sep = if last_comma.is_some() { ',' } else { '.' };
            let count = s.matches(sep).count();
            let after = s.len() - s.rfind(sep).unwrap() - 1;
            // A single separator not followed by exactly three digits is decimal;
            // otherwise ("1,234", "1.234.567") it groups thousands.
            if count == 1 && after != 3 {
                Some(sep)
            } else {
                None
            }
        }
        (None, None) => None,
    };
    let (int_part, frac_part) = match dec_sep {
        Some(sep) => {
            let idx = s.rfind(sep).unwrap();
            (&s[..idx], &s[idx + 1..])
        }
        None => (s.as_str(), ""),
    };
    // Validate thousands grouping in the integer part.
    let group_sep = match dec_sep {
        Some(',') => '.',
        Some(_) => ',',
        None => {
            if int_part.contains(',') {
                ','
            } else {
                '.'
            }
        }
    };
    if int_part.contains(if group_sep == ',' { '.' } else { ',' }) {
        return None;
    }
    let groups: Vec<&str> = int_part.split(group_sep).collect();
    if groups.len() > 1
        && (groups[0].is_empty() || groups[0].len() > 3 || groups[0] == "0" || groups[1..].iter().any(|g| g.len() != 3))
    {
        return None;
    }
    let int_digits: String = groups.concat();
    if int_digits.is_empty() && frac_part.is_empty() {
        return None;
    }
    if !int_digits.chars().all(|c| c.is_ascii_digit()) || !frac_part.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut frac = frac_part.to_string();
    if frac.len() > dec as usize {
        // Extra fractional digits are allowed only if they are zeros ("100.00 JPY").
        if frac[dec as usize..].chars().any(|c| c != '0') {
            return None;
        }
        frac.truncate(dec as usize);
    }
    while frac.len() < dec as usize {
        frac.push('0');
    }
    let int_val: i64 = if int_digits.is_empty() { 0 } else { int_digits.parse().ok()? };
    let frac_val: i64 = if frac.is_empty() { 0 } else { frac.parse().ok()? };
    let scale = 10i64.pow(dec);
    let v = int_val.checked_mul(scale)?.checked_add(frac_val)?;
    Some(if negative { -v } else { v })
}

/// Parse user input that must be a positive amount.
pub fn parse_positive(text: &str, currency: &str, field: &str) -> AppResult<i64> {
    match parse_amount(text, currency) {
        Some(v) if v > 0 => Ok(v),
        _ => Err(AppError::invalid_amount(field)),
    }
}

/// Parse user input that must be zero or positive.
pub fn parse_non_negative(text: &str, currency: &str, field: &str) -> AppResult<i64> {
    match parse_amount(text, currency) {
        Some(v) if v >= 0 => Ok(v),
        _ => Err(AppError::invalid_amount(field)),
    }
}

/// Format minor units as `1,250.00 USD` (Latin digits, `,` thousands, `.` decimals).
pub fn format_amount(minor: i64, currency: &str) -> String {
    format!("{} {}", format_number(minor, currency), currency.to_ascii_uppercase())
}

/// Format minor units without the currency code: `1,250.00`.
pub fn format_number(minor: i64, currency: &str) -> String {
    let dec = decimals(currency);
    let scale = 10i64.pow(dec) as u64;
    let neg = minor < 0;
    let abs = minor.unsigned_abs();
    let int = abs / scale;
    let frac = abs % scale;
    let int_s = int.to_string();
    let mut grouped = String::new();
    for (i, ch) in int_s.chars().enumerate() {
        if i > 0 && (int_s.len() - i).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(&grouped);
    if dec > 0 {
        out.push('.');
        out.push_str(&format!("{:0width$}", frac, width = dec as usize));
    }
    out
}

/// Plain decimal without grouping, for CSV: `-1250.00`.
pub fn format_plain(minor: i64, currency: &str) -> String {
    format_number(minor, currency).replace(',', "")
}

/// Format basis points as a percentage with two decimals: `2500` → `25.00%`.
pub fn format_bps(bps: i64) -> String {
    format!("{}.{:02}%", bps / 100, (bps % 100).abs())
}

/// Integer half-up rounding of `value × num / den` for non-negative operands.
pub fn mul_div_half_up(value: i64, num: i64, den: i64) -> i64 {
    debug_assert!(den > 0);
    let p = value as i128 * num as i128;
    let half = den as i128 / 2;
    let r = if p >= 0 { (p + half) / den as i128 } else { -((-p + half) / den as i128) };
    r as i64
}

/// Currency detected from a symbol inside text (`$` → USD, `€` → EUR, ...).
pub fn currency_from_symbol(text: &str) -> Option<&'static str> {
    text.chars().find_map(symbol_currency)
}
