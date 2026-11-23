use ppfeez_core::commission::{compute, estimate_fee, percent_of, Commission};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::money::{decimals, format_amount, format_bps, parse_amount};
use ppfeez_core::paypal::amount::{find_all, find_first};

#[test]
fn parses_the_four_spec_formats() {
    assert_eq!(parse_amount("$1,234.56 USD", "USD"), Some(123456));
    assert_eq!(parse_amount("1.234,56 EUR", "EUR"), Some(123456));
    assert_eq!(parse_amount("€50,00", "EUR"), Some(5000));
    assert_eq!(parse_amount("100.00 USD", "USD"), Some(10000));
}

#[test]
fn parses_common_user_input() {
    assert_eq!(parse_amount("95.5", "USD"), Some(9550));
    assert_eq!(parse_amount("95", "USD"), Some(9500));
    assert_eq!(parse_amount("1,234", "USD"), Some(123400));
    assert_eq!(parse_amount("1 234,56", "EUR"), Some(123456));
    assert_eq!(parse_amount("1,234,567.89", "USD"), Some(123456789));
    assert_eq!(parse_amount("-2.05", "USD"), Some(-205));
    assert_eq!(parse_amount("−€2,05 EUR", "EUR"), Some(-205));
    assert_eq!(parse_amount("٩٥٫٥٠", "USD"), Some(9550));
    assert_eq!(parse_amount("0.30", "USD"), Some(30));
}

#[test]
fn rejects_invalid_amounts() {
    for bad in ["", "abc", "1.2.3,4,5", "1,23,4", "0.123", "1.2345", "--5", "5-", "12,3456"] {
        assert_eq!(parse_amount(bad, "USD"), None, "{bad}");
    }
    // A single separator followed by exactly three digits groups thousands.
    assert_eq!(parse_amount("12.345", "USD"), Some(1234500));
    assert_eq!(parse_amount("1.999", "USD"), Some(199900));
}

#[test]
fn zero_decimal_currencies() {
    assert_eq!(decimals("JPY"), 0);
    assert_eq!(decimals("huf"), 0);
    assert_eq!(decimals("TWD"), 0);
    assert_eq!(decimals("USD"), 2);
    assert_eq!(parse_amount("¥5,000 JPY", "JPY"), Some(5000));
    assert_eq!(parse_amount("5.000", "JPY"), Some(5000));
    assert_eq!(parse_amount("100.00", "JPY"), Some(100));
    assert_eq!(parse_amount("100.5", "JPY"), None);
    assert_eq!(format_amount(5000, "JPY"), "5,000 JPY");
}

#[test]
fn formats_amounts_and_rates() {
    assert_eq!(format_amount(125000, "USD"), "1,250.00 USD");
    assert_eq!(format_amount(-7125, "EUR"), "-71.25 EUR");
    assert_eq!(format_amount(5, "USD"), "0.05 USD");
    assert_eq!(format_amount(123456789, "USD"), "1,234,567.89 USD");
    assert_eq!(format_bps(2500), "25.00%");
    assert_eq!(format_bps(1250), "12.50%");
    assert_eq!(format_bps(5), "0.05%");
}

#[test]
fn finds_money_in_email_text() {
    let f = find_first("John Doe sent you $100.00 USD").unwrap();
    assert_eq!((f.minor, f.currency.as_str()), (10000, "USD"));
    let f = find_first("Amount received: €50,00 EUR").unwrap();
    assert_eq!((f.minor, f.currency.as_str()), (5000, "EUR"));
    let f = find_first("PayPal fee: -€2,05 EUR").unwrap();
    assert!(f.negative);
    assert_eq!(f.minor, 205);
    let f = find_first("Total USD 25.00").unwrap();
    assert_eq!((f.minor, f.currency.as_str()), (2500, "USD"));
    assert_eq!(find_first("Transaction date Nov 20, 2026"), None);
    assert_eq!(find_all("1.234,56 EUR and £3.50").len(), 2);
}

#[test]
fn spec_example_100_5_25_percent() {
    let b = compute(10000, 500, Commission::Percent(2500)).unwrap();
    assert_eq!(b.net_minor, 9500);
    assert_eq!(b.commission_minor, 2375);
    assert_eq!(b.customer_amount_minor, 7125);
}

#[test]
fn half_up_rounding() {
    // 0.10 × 25% = 0.025 → 0.03 (half up)
    assert_eq!(percent_of(10, 2500), 3);
    // 0.30 × 15% = 0.045 → 0.05
    assert_eq!(percent_of(30, 1500), 5);
    // 0.01 × 49.99% = 0.004999 → 0.00
    assert_eq!(percent_of(1, 4999), 0);
    // 0.01 × 50% = 0.005 → 0.01
    assert_eq!(percent_of(1, 5000), 1);
}

#[test]
fn zero_and_full_percent() {
    let zero = compute(10000, 500, Commission::Percent(0)).unwrap();
    assert_eq!((zero.commission_minor, zero.customer_amount_minor), (0, 9500));
    let full = compute(10000, 500, Commission::Percent(10000)).unwrap();
    assert_eq!((full.commission_minor, full.customer_amount_minor), (9500, 0));
    assert_eq!(compute(10000, 0, Commission::Percent(10001)).unwrap_err().code, ErrorCode::Validation);
}

#[test]
fn fixed_commission() {
    let b = compute(10000, 500, Commission::Fixed(1000)).unwrap();
    assert_eq!((b.commission_minor, b.customer_amount_minor), (1000, 8500));
    let all = compute(10000, 500, Commission::Fixed(9500)).unwrap();
    assert_eq!(all.customer_amount_minor, 0);
    let err = compute(10000, 500, Commission::Fixed(9501)).unwrap_err();
    assert_eq!(err.code, ErrorCode::CommissionExceedsNet);
}

#[test]
fn fee_cannot_exceed_gross() {
    assert_eq!(compute(1000, 1001, Commission::Percent(2500)).unwrap_err().code, ErrorCode::Validation);
}

#[test]
fn fee_estimate() {
    // 4.4% + 0.30 of 100.00 = 4.40 + 0.30 = 4.70
    assert_eq!(estimate_fee(10000, 440, 30), 470);
    // never above gross
    assert_eq!(estimate_fee(20, 440, 30), 20);
}
