//! Find money amounts inside PayPal email text: `$1,234.56 USD`, `1.234,56 EUR`, `€50,00`,
//! `100.00 USD`, `USD 25.00`, `¥5,000 JPY`, `₪1,234.56 ILS`, `1.234,56 ₺`, `US$10.00`, `250 ש"ח`,
//! `100 TL`. Conversion goes through [`crate::money::parse_amount`].

use crate::money::{currency_from_symbol, parse_amount};
use regex::Regex;
use std::sync::OnceLock;

/// Currencies PayPal accepts (plus a few common regional ones).
const CODES: [&str; 32] = [
    "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS", "JPY", "MYR", "MXN", "TWD", "NZD", "NOK",
    "PHP", "PLN", "GBP", "SGD", "SEK", "CHF", "THB", "USD", "TRY", "RUB", "INR", "SAR", "AED", "KWD", "QAR", "EGP",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundMoney {
    pub minor: i64,
    pub currency: String,
    pub negative: bool,
}

fn re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?x)
            (?P<neg>[-−–]\s*)?
            (?:(?P<pre>[A-Z]{3})\s?)?
            (?:US)?(?P<sym>[$€£¥₺₪])?\s?
            (?P<neg2>[-−–]\s*)?
            (?P<num>\d{1,3}(?:[.,\x20\u{a0}\u{202f}]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)
            (?:\s?(?P<sym2>[$€£¥₺₪]))?
            (?:\s?(?P<code>[A-Z]{3})\b)?",
        )
        .expect("valid regex")
    })
}

/// All amounts in `text` that carry a currency (code or symbol), in order of appearance.
/// Local currency words → ISO codes, before matching (`NIS`, `ש"ח`, `TL`).
fn normalize(text: &str) -> String {
    let t = crate::paypal::strip_bidi(text).replace("ש\"ח", "ILS").replace("ש״ח", "ILS").replace("שקלים", "ILS");
    let t = word_re().replace_all(&t, |c: &regex::Captures<'_>| match &c[1] {
        "NIS" => "ILS".to_string(),
        "TL" => "TRY".to_string(),
        other => other.to_string(),
    });
    t.into_owned()
}

fn word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(NIS|TL)\b").unwrap())
}

pub fn find_all(text: &str) -> Vec<FoundMoney> {
    let text = normalize(text);
    let text = text.as_str();
    let mut out = vec![];
    for c in re().captures_iter(text) {
        let code = c
            .name("code")
            .map(|m| m.as_str())
            .filter(|s| CODES.contains(s))
            .or_else(|| c.name("pre").map(|m| m.as_str()).filter(|s| CODES.contains(s)));
        let sym = c.name("sym").or_else(|| c.name("sym2")).map(|m| m.as_str());
        let currency = match (code, sym) {
            (Some(code), _) => code.to_string(),
            (None, Some(s)) => match currency_from_symbol(s) {
                Some(cur) => cur.to_string(),
                None => continue,
            },
            (None, None) => continue,
        };
        let num = c.name("num").unwrap().as_str();
        let Some(minor) = parse_amount(num, &currency) else { continue };
        out.push(FoundMoney { minor, currency, negative: c.name("neg").is_some() || c.name("neg2").is_some() });
    }
    out
}

pub fn find_first(text: &str) -> Option<FoundMoney> {
    find_all(text).into_iter().next()
}
