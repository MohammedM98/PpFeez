//! Keyword tables per language (SPEC §5.3). Logic lives in `paypal/parsers`; adding a language
//! means adding a table here (and fixtures). Subject phrases are matched lowercase, as
//! substrings; labels are matched at the start of a text line.
//!
//! The English tables follow PayPal's known emails. The Hebrew, Arabic and Turkish tables are
//! best knowledge until real emails are available; the generic parser catches what they miss.

pub mod ar;
pub mod en;
pub mod he;
pub mod tr;

pub struct Lang {
    pub code: &'static str,
    // ----- subjects (lowercase substrings) -----
    /// Money received: friends & family, goods & services, request/invoice paid, subscription,
    /// mass payment.
    pub payment_subjects: &'static [&'static str],
    /// Money *sent* by the owner and other phrases that look like payments but are not income.
    pub not_income_subjects: &'static [&'static str],
    pub echeck_words: &'static [&'static str],
    pub pending_words: &'static [&'static str],
    pub cleared_words: &'static [&'static str],
    pub on_hold_subjects: &'static [&'static str],
    pub refund_subjects: &'static [&'static str],
    /// A refund the owner *received* (a purchase refunded to them): not customer money.
    pub refund_received_subjects: &'static [&'static str],
    pub reversal_subjects: &'static [&'static str],
    pub non_transactional: &'static [&'static str],
    /// Words that suggest money moved (an unknown email with them is a failure, not noise).
    pub money_cues: &'static [&'static str],
    // ----- labels (start of a line) -----
    pub txn_id: &'static [&'static str],
    pub gross: &'static [&'static str],
    pub fee: &'static [&'static str],
    pub net: &'static [&'static str],
    pub date: &'static [&'static str],
    pub payer_name: &'static [&'static str],
    pub payer_email: &'static [&'static str],
    /// Notes; labels ending with a "from" word take the text after the next `:`.
    pub note: &'static [&'static str],
    pub original_id: &'static [&'static str],
    pub refund_id: &'static [&'static str],
    pub refund_amount: &'static [&'static str],
    pub refund_to: &'static [&'static str],
    pub case_id: &'static [&'static str],
    pub reversal_id: &'static [&'static str],
    pub reversal_amount: &'static [&'static str],
    pub buyer: &'static [&'static str],
    pub reason: &'static [&'static str],
    // ----- sentence patterns (regex with named groups `name` and optionally `amount`) -----
    pub sent_you: &'static [&'static str],
    /// "… from {name}" at the end of a subject.
    pub subject_from: &'static [&'static str],
}

pub const ALL: [&Lang; 4] = [&en::EN, &he::HE, &ar::AR, &tr::TR];

pub fn by_code(code: &str) -> &'static Lang {
    ALL.iter().copied().find(|l| l.code == code).unwrap_or(&en::EN)
}
