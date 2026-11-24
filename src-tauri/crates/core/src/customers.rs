//! Customers (SPEC §4.6, §6.4). Customers are never deleted, only deactivated.

use crate::audit;
use crate::commission::validate_bps;
use crate::error::{is_unique_violation, AppError, AppResult, ErrorCode};
use crate::Core;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Money {
    pub minor: i64,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub default_commission_bps: i64,
    pub notes: Option<String>,
    pub is_active: bool,
    pub balances: Vec<Money>,
    pub pending_count: i64,
    pub created_at: String,
    /// SPEC §6.8.2: the linked Excel statement.
    pub excel: Option<crate::excel::customer::CustomerExcel>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerInput {
    pub name: String,
    #[serde(default)]
    pub phone: Option<String>,
    pub default_commission_bps: i64,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

/// Small reference used inside other DTOs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerRef {
    pub id: i64,
    pub name: String,
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Per-currency balances of a customer (sum of ledger entries; never stored).
pub fn balances(conn: &Connection, customer_id: i64) -> AppResult<Vec<Money>> {
    let mut stmt = conn.prepare(
        "SELECT currency, SUM(amount_minor) FROM ledger_entries WHERE customer_id = ?1 GROUP BY currency ORDER BY currency",
    )?;
    let rows = stmt.query_map(params![customer_id], |r| Ok(Money { currency: r.get(0)?, minor: r.get(1)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn balance_in(conn: &Connection, customer_id: i64, currency: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries WHERE customer_id = ?1 AND currency = ?2",
        params![customer_id, currency],
        |r| r.get(0),
    )?)
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<Customer> {
    Ok(Customer {
        id: r.get("id")?,
        name: r.get("name")?,
        phone: r.get("phone")?,
        default_commission_bps: r.get("default_commission_bps")?,
        notes: r.get("notes")?,
        is_active: r.get::<_, i64>("is_active")? != 0,
        balances: vec![],
        pending_count: r.get("pending_count")?,
        created_at: r.get("created_at")?,
        excel: None,
    })
}

const SELECT: &str = "SELECT c.*, (SELECT COUNT(*) FROM paypal_transactions t
     WHERE t.customer_id = c.id AND t.status = 'pending_approval') AS pending_count
     FROM customers c";

pub fn get(conn: &Connection, id: i64) -> AppResult<Customer> {
    let row = conn.query_row(&format!("{SELECT} WHERE c.id = ?1"), params![id], from_row).optional()?;
    let mut c = row.ok_or_else(|| AppError::not_found("العميل"))?;
    c.balances = balances(conn, id)?;
    c.excel = crate::excel::customer::get_link(conn, id)?;
    Ok(c)
}

pub fn customer_ref(conn: &Connection, id: i64) -> AppResult<CustomerRef> {
    conn.query_row("SELECT id, name FROM customers WHERE id = ?1", params![id], |r| {
        Ok(CustomerRef { id: r.get(0)?, name: r.get(1)? })
    })
    .optional()?
    .ok_or_else(|| AppError::not_found("العميل"))
}

fn validate(input: &CustomerInput) -> AppResult<(String, Option<String>, Option<String>)> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("name", "اسم العميل مطلوب"));
    }
    validate_bps(input.default_commission_bps).map_err(|e| e.with_field("defaultCommissionBps"))?;
    Ok((name, clean(input.phone.clone()), clean(input.notes.clone())))
}

fn duplicate_name() -> AppError {
    AppError::new(ErrorCode::Duplicate, "يوجد عميل بنفس الاسم").with_field("name")
}

impl Core {
    pub fn customers_list(&self, search: Option<&str>, active: Option<bool>) -> AppResult<Vec<Customer>> {
        self.customers_list_filtered(search, active, None)
    }

    /// `has_pending`: only customers with (true) / without (false) transactions awaiting approval.
    pub fn customers_list_filtered(
        &self,
        search: Option<&str>,
        active: Option<bool>,
        has_pending: Option<bool>,
    ) -> AppResult<Vec<Customer>> {
        let conn = self.conn();
        let mut sql = format!("{SELECT} WHERE 1=1");
        let mut args: Vec<rusqlite::types::Value> = vec![];
        if let Some(s) = search.map(str::trim).filter(|s| !s.is_empty()) {
            sql.push_str(" AND (c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')");
            let like = format!("%{}%", crate::transactions::escape_like(s));
            args.push(like.clone().into());
            args.push(like.into());
        }
        if let Some(a) = active {
            sql.push_str(" AND c.is_active = ?");
            args.push((a as i64).into());
        }
        if let Some(p) = has_pending {
            sql.push_str(if p { " AND pending_count > 0" } else { " AND pending_count = 0" });
        }
        sql.push_str(" ORDER BY c.is_active DESC, c.name COLLATE NOCASE");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args), from_row)?;
        let mut out = vec![];
        for row in rows {
            let mut c = row?;
            c.balances = balances(&conn, c.id)?;
            c.excel = crate::excel::customer::get_link(&conn, c.id)?;
            out.push(c);
        }
        Ok(out)
    }

    pub fn customer_get(&self, id: i64) -> AppResult<Customer> {
        get(&self.conn(), id)
    }

    pub fn customer_create(&self, input: CustomerInput) -> AppResult<Customer> {
        let (name, phone, notes) = validate(&input)?;
        let now = self.now_iso();
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO customers (name, phone, default_commission_bps, notes, is_active, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![name, phone, input.default_commission_bps, notes, input.is_active.unwrap_or(true) as i64, now],
        )
        .map_err(|e| if is_unique_violation(&e) { duplicate_name() } else { e.into() })?;
        let id = tx.last_insert_rowid();
        audit::log(
            &tx,
            &now,
            "customer.create",
            "customer",
            Some(id),
            json!({ "name": name, "defaultCommissionBps": input.default_commission_bps }),
        )?;
        tx.commit()?;
        get(&conn, id)
    }

    pub fn customer_update(&self, id: i64, input: CustomerInput) -> AppResult<Customer> {
        let (name, phone, notes) = validate(&input)?;
        let now = self.now_iso();
        let conn = self.conn();
        let before = get(&conn, id)?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE customers SET name = ?1, phone = ?2, default_commission_bps = ?3, notes = ?4,
             is_active = ?5, updated_at = ?6 WHERE id = ?7",
            params![
                name,
                phone,
                input.default_commission_bps,
                notes,
                input.is_active.unwrap_or(before.is_active) as i64,
                now,
                id
            ],
        )
        .map_err(|e| if is_unique_violation(&e) { duplicate_name() } else { e.into() })?;
        audit::log(
            &tx,
            &now,
            "customer.update",
            "customer",
            Some(id),
            json!({
                "before": { "name": before.name, "defaultCommissionBps": before.default_commission_bps },
                "after": { "name": name, "defaultCommissionBps": input.default_commission_bps },
            }),
        )?;
        tx.commit()?;
        get(&conn, id)
    }

    pub fn customer_set_active(&self, id: i64, active: bool) -> AppResult<Customer> {
        let now = self.now_iso();
        let conn = self.conn();
        get(&conn, id)?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE customers SET is_active = ?1, updated_at = ?2 WHERE id = ?3",
            params![active as i64, now, id],
        )?;
        audit::log(&tx, &now, "customer.set_active", "customer", Some(id), json!({ "active": active }))?;
        tx.commit()?;
        get(&conn, id)
    }
}
