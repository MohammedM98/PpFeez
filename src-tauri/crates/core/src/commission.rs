//! Commission calculation (SPEC §4.1). Commission is taken from the net after PayPal fees.
//!
//! ```text
//! net        = gross − fee
//! commission = percent: round_half_up(net × bps / 10000)   fixed: entered amount (0 ≤ c ≤ net)
//! customer   = net − commission
//! ```

use crate::error::{AppError, AppResult, ErrorCode};
use crate::money::mul_div_half_up;
use serde::{Deserialize, Serialize};

pub const MAX_BPS: i64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommissionMode {
    Percent,
    Fixed,
}

impl CommissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CommissionMode::Percent => "percent",
            CommissionMode::Fixed => "fixed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "percent" => Some(CommissionMode::Percent),
            "fixed" => Some(CommissionMode::Fixed),
            _ => None,
        }
    }
}

/// A resolved commission rule (amounts already parsed into minor units).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Commission {
    Percent(i64),
    Fixed(i64),
}

impl Commission {
    pub fn mode(self) -> CommissionMode {
        match self {
            Commission::Percent(_) => CommissionMode::Percent,
            Commission::Fixed(_) => CommissionMode::Fixed,
        }
    }

    pub fn bps(self) -> Option<i64> {
        match self {
            Commission::Percent(b) => Some(b),
            Commission::Fixed(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Breakdown {
    pub net_minor: i64,
    pub commission_minor: i64,
    pub customer_amount_minor: i64,
}

pub fn validate_bps(bps: i64) -> AppResult<i64> {
    if (0..=MAX_BPS).contains(&bps) {
        Ok(bps)
    } else {
        Err(AppError::validation("bps", "نسبة العمولة يجب أن تكون بين 0% و100%"))
    }
}

/// Percent commission on a net amount, rounded half-up with integers: `(net × bps + 5000) / 10000`.
pub fn percent_of(net_minor: i64, bps: i64) -> i64 {
    mul_div_half_up(net_minor, bps, MAX_BPS)
}

/// Compute the full breakdown from gross and fee.
pub fn compute(gross_minor: i64, fee_minor: i64, rule: Commission) -> AppResult<Breakdown> {
    if fee_minor < 0 || fee_minor > gross_minor {
        return Err(AppError::validation("fee", "الرسوم يجب ألا تتجاوز المبلغ الأصلي"));
    }
    let net = gross_minor - fee_minor;
    let commission = match rule {
        Commission::Percent(bps) => {
            validate_bps(bps)?;
            percent_of(net, bps)
        }
        Commission::Fixed(amount) => {
            if amount < 0 {
                return Err(AppError::invalid_amount("amountText"));
            }
            if amount > net {
                return Err(AppError::new(
                    ErrorCode::CommissionExceedsNet,
                    "العمولة أكبر من الصافي بعد رسوم PayPal",
                )
                .with_field("amountText"));
            }
            amount
        }
    };
    Ok(Breakdown { net_minor: net, commission_minor: commission, customer_amount_minor: net - commission })
}

/// Fee estimate `round_half_up(gross × bps / 10000) + fixed`, never above gross.
pub fn estimate_fee(gross_minor: i64, bps: i64, fixed_minor: i64) -> i64 {
    (mul_div_half_up(gross_minor, bps, MAX_BPS) + fixed_minor).clamp(0, gross_minor)
}
