//! SQLite connection setup and numbered migrations (applied at startup, tracked in `user_version`).

use crate::error::AppResult;
use rusqlite::Connection;
use std::path::Path;

/// Migrations in order; index + 1 is the schema version.
const MIGRATIONS: &[&str] = &[include_str!("migrations/0001_init.sql"), include_str!("migrations/0002_pull_range.sql")];

pub fn schema_version() -> i64 {
    MIGRATIONS.len() as i64
}

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn, true)?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn, false)?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn configure(conn: &Connection, wal: bool) -> AppResult<()> {
    if wal {
        conn.pragma_update(None, "journal_mode", "WAL")?;
    }
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

pub fn migrate(conn: &Connection) -> AppResult<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = i as i64 + 1;
        if version <= current {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}
