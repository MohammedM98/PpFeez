//! Dashboard (SPEC §6.2).

use crate::customers::Money;
use crate::error::AppResult;
use crate::mail::pull::{last_run, PullRun};
use crate::refunds::alert_count;
use crate::transactions::Period;
use crate::Core;
use rusqlite::params;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardCounts {
    pub unassigned: i64,
    pub needs_fee: i64,
    pub pending_approval: i64,
    pub refund_alerts: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencySummary {
    pub currency: String,
    pub gross_minor: i64,
    pub fee_minor: i64,
    pub commission_minor: i64,
    pub owed_to_customers_minor: i64,
    pub paid_out_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopCustomer {
    pub customer_id: i64,
    pub name: String,
    pub balance: Money,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    pub counts: DashboardCounts,
    pub by_currency: Vec<CurrencySummary>,
    pub top_customers: Vec<TopCustomer>,
    pub last_pull: Option<PullRun>,
}

fn slot(by: &mut BTreeMap<String, CurrencySummary>, currency: String) -> &mut CurrencySummary {
    by.entry(currency.clone()).or_insert_with(|| CurrencySummary { currency, ..Default::default() })
}

impl Core {
    pub fn dashboard_summary(&self, period: &Period) -> AppResult<DashboardSummary> {
        let (from_ts, to_ts) = self.period_bounds(period)?;
        let from_date = period.from.clone().filter(|s| !s.trim().is_empty());
        let to_date = period.to.clone().filter(|s| !s.trim().is_empty());
        let conn = self.conn();

        let counts = conn.query_row(
            "SELECT
               COALESCE(SUM(status = 'unassigned'), 0),
               COALESCE(SUM(fee_minor IS NULL AND type = 'payment' AND status <> 'excluded'), 0),
               COALESCE(SUM(status = 'pending_approval'), 0)
             FROM paypal_transactions",
            [],
            |r| {
                Ok(DashboardCounts {
                    unassigned: r.get(0)?,
                    needs_fee: r.get(1)?,
                    pending_approval: r.get(2)?,
                    refund_alerts: 0,
                })
            },
        )?;
        let counts = DashboardCounts { refund_alerts: alert_count(&conn)?, ..counts };

        let mut by: BTreeMap<String, CurrencySummary> = BTreeMap::new();
        // Incoming payments in the period (not excluded).
        {
            let mut stmt = conn.prepare(
                "SELECT currency, SUM(gross_minor), COALESCE(SUM(fee_minor), 0) FROM paypal_transactions
                 WHERE type = 'payment' AND status <> 'excluded'
                   AND (?1 IS NULL OR occurred_at >= ?1) AND (?2 IS NULL OR occurred_at < ?2)
                 GROUP BY currency",
            )?;
            let rows =
                stmt.query_map(params![from_ts, to_ts], |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)))?;
            for row in rows {
                let (c, g, f): (String, i64, i64) = row?;
                let e = slot(&mut by, c);
                e.gross_minor = g;
                e.fee_minor = f;
            }
        }
        // Commission earned on approvals made in the period.
        {
            let mut stmt = conn.prepare(
                "SELECT currency, COALESCE(SUM(commission_minor), 0) FROM paypal_transactions
                 WHERE status = 'approved' AND (?1 IS NULL OR approved_at >= ?1) AND (?2 IS NULL OR approved_at < ?2)
                 GROUP BY currency",
            )?;
            let rows = stmt.query_map(params![from_ts, to_ts], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?;
            for row in rows {
                let (c, v): (String, i64) = row?;
                slot(&mut by, c).commission_minor = v;
            }
        }
        // Current balances owed (not affected by the period).
        {
            let mut stmt = conn.prepare("SELECT currency, SUM(amount_minor) FROM ledger_entries GROUP BY currency")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?;
            for row in rows {
                let (c, v): (String, i64) = row?;
                slot(&mut by, c).owed_to_customers_minor = v;
            }
        }
        // Payouts in the period (positive), net of payout reversals.
        {
            let mut stmt = conn.prepare(
                "SELECT e.currency, -SUM(e.amount_minor) FROM ledger_entries e
                 LEFT JOIN ledger_entries o ON o.id = e.reverses_entry_id
                 WHERE (e.type = 'payout' OR (e.type = 'reversal' AND o.type = 'payout'))
                   AND (?1 IS NULL OR e.entry_date >= ?1) AND (?2 IS NULL OR e.entry_date <= ?2)
                 GROUP BY e.currency",
            )?;
            let rows = stmt.query_map(params![from_date, to_date], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?;
            for row in rows {
                let (c, v): (String, i64) = row?;
                slot(&mut by, c).paid_out_minor = v;
            }
        }

        // Top 5 customers by positive balance, per currency.
        let mut top_customers = vec![];
        {
            let mut stmt = conn.prepare(
                "SELECT c.id, c.name, e.currency, SUM(e.amount_minor) AS bal FROM ledger_entries e
                 JOIN customers c ON c.id = e.customer_id
                 GROUP BY c.id, e.currency HAVING bal > 0
                 ORDER BY e.currency, bal DESC, c.name",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(TopCustomer {
                    customer_id: r.get(0)?,
                    name: r.get(1)?,
                    balance: Money { currency: r.get(2)?, minor: r.get(3)? },
                })
            })?;
            let mut per: BTreeMap<String, usize> = BTreeMap::new();
            for row in rows {
                let t = row?;
                let n = per.entry(t.balance.currency.clone()).or_default();
                if *n < 5 {
                    *n += 1;
                    top_customers.push(t);
                }
            }
        }

        Ok(DashboardSummary {
            counts,
            by_currency: by.into_values().collect(),
            top_customers,
            last_pull: last_run(&conn)?,
        })
    }
}
