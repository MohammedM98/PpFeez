//! Gmail mailbox settings (SPEC §6.7). Passwords go to the OS credential store only.

use super::fetcher::ConnectParams;
use super::secrets::mailbox_key;
use crate::error::{is_unique_violation, AppError, AppResult, ErrorCode};
use crate::Core;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

pub const DEFAULT_HOST: &str = "imap.gmail.com";
pub const DEFAULT_PORT: i64 = 993;
pub const DEFAULT_FOLDER: &str = "[Gmail]/All Mail";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mailbox {
    pub id: i64,
    pub label: String,
    pub email: String,
    pub host: String,
    pub port: i64,
    pub folder: String,
    pub is_active: bool,
    pub has_password: bool,
    pub last_pulled_at: Option<String>,
    pub last_uid: i64,
    pub running: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxInput {
    pub label: String,
    pub email: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<i64>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxTestResult {
    pub ok: bool,
    pub folder_count: i64,
}

/// Internal row with sync state.
#[derive(Debug, Clone)]
pub struct MailboxRow {
    pub id: i64,
    pub label: String,
    pub email: String,
    pub host: String,
    pub port: i64,
    pub folder: String,
    pub uid_validity: Option<i64>,
    pub last_uid: i64,
    pub last_pulled_at: Option<String>,
    pub is_active: bool,
}

impl MailboxRow {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(MailboxRow {
            id: r.get("id")?,
            label: r.get("label")?,
            email: r.get("email")?,
            host: r.get("host")?,
            port: r.get("port")?,
            folder: r.get("folder")?,
            uid_validity: r.get("uid_validity")?,
            last_uid: r.get("last_uid")?,
            last_pulled_at: r.get("last_pulled_at")?,
            is_active: r.get::<_, i64>("is_active")? != 0,
        })
    }
}

pub fn load(conn: &Connection, id: i64) -> AppResult<MailboxRow> {
    conn.query_row("SELECT * FROM mailboxes WHERE id = ?1", params![id], MailboxRow::from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("البريد"))
}

/// Gmail shows App Passwords as four groups of four letters; spaces are not part of it.
pub fn normalize_password(p: &str) -> String {
    p.chars().filter(|c| !c.is_whitespace()).collect()
}

struct Clean {
    label: String,
    email: String,
    host: String,
    port: i64,
    folder: String,
}

fn validate(input: &MailboxInput) -> AppResult<Clean> {
    let label = input.label.trim().to_string();
    if label.is_empty() {
        return Err(AppError::validation("label", "التسمية مطلوبة"));
    }
    let email = input.email.trim().to_ascii_lowercase();
    let valid = email
        .split_once('@')
        .map(|(l, d)| !l.is_empty() && d.contains('.') && !d.starts_with('.') && !email.contains(' '))
        .unwrap_or(false);
    if !valid {
        return Err(AppError::validation("email", "عنوان البريد غير صالح"));
    }
    let host = input.host.as_deref().map(str::trim).filter(|h| !h.is_empty()).unwrap_or(DEFAULT_HOST).to_string();
    let port = input.port.unwrap_or(DEFAULT_PORT);
    if !(1..=65535).contains(&port) {
        return Err(AppError::validation("port", "رقم المنفذ غير صالح"));
    }
    let folder = input.folder.as_deref().map(str::trim).filter(|f| !f.is_empty()).unwrap_or(DEFAULT_FOLDER).to_string();
    Ok(Clean { label, email, host, port, folder })
}

impl Core {
    fn mailbox_dto(&self, conn: &Connection, row: MailboxRow) -> AppResult<Mailbox> {
        let running: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pull_runs WHERE mailbox_id = ?1 AND status = 'running')",
            params![row.id],
            |r| r.get(0),
        )?;
        Ok(Mailbox {
            has_password: self.secrets.get(&mailbox_key(row.id))?.is_some(),
            id: row.id,
            label: row.label,
            email: row.email,
            host: row.host,
            port: row.port,
            folder: row.folder,
            is_active: row.is_active,
            last_pulled_at: row.last_pulled_at,
            last_uid: row.last_uid,
            running,
        })
    }

    pub fn mailbox_list(&self) -> AppResult<Vec<Mailbox>> {
        let conn = self.conn();
        let rows: Vec<MailboxRow> = {
            let mut stmt = conn.prepare("SELECT * FROM mailboxes ORDER BY id")?;
            let it = stmt.query_map([], MailboxRow::from_row)?;
            it.collect::<Result<_, _>>()?
        };
        rows.into_iter().map(|r| self.mailbox_dto(&conn, r)).collect()
    }

    pub fn mailbox_get(&self, id: i64) -> AppResult<Mailbox> {
        let conn = self.conn();
        let row = load(&conn, id)?;
        self.mailbox_dto(&conn, row)
    }

    pub fn mailbox_create(&self, input: MailboxInput) -> AppResult<Mailbox> {
        let c = validate(&input)?;
        let now = self.now_iso();
        let id = {
            let conn = self.conn();
            conn.execute(
                "INSERT INTO mailboxes (label, email, host, port, folder, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![c.label, c.email, c.host, c.port, c.folder, now],
            )
            .map_err(|e| {
                if is_unique_violation(&e) {
                    AppError::new(ErrorCode::Duplicate, "هذا البريد مضاف مسبقاً").with_field("email")
                } else {
                    e.into()
                }
            })?;
            conn.last_insert_rowid()
        };
        if let Some(p) = input.password.as_deref().map(normalize_password).filter(|p| !p.is_empty()) {
            self.secrets.set(&mailbox_key(id), &p)?;
        }
        self.mailbox_get(id)
    }

    pub fn mailbox_update(&self, id: i64, input: MailboxInput) -> AppResult<Mailbox> {
        let c = validate(&input)?;
        {
            let conn = self.conn();
            let before = load(&conn, id)?;
            // Changing the account or folder restarts the sync from scratch.
            let reset = before.email != c.email || before.folder != c.folder || before.host != c.host;
            conn.execute(
                "UPDATE mailboxes SET label = ?1, email = ?2, host = ?3, port = ?4, folder = ?5,
                 uid_validity = CASE WHEN ?6 THEN NULL ELSE uid_validity END,
                 last_uid = CASE WHEN ?6 THEN 0 ELSE last_uid END WHERE id = ?7",
                params![c.label, c.email, c.host, c.port, c.folder, reset, id],
            )
            .map_err(|e| {
                if is_unique_violation(&e) {
                    AppError::new(ErrorCode::Duplicate, "هذا البريد مضاف مسبقاً").with_field("email")
                } else {
                    e.into()
                }
            })?;
        }
        if let Some(p) = input.password.as_deref().map(normalize_password).filter(|p| !p.is_empty()) {
            self.secrets.set(&mailbox_key(id), &p)?;
        }
        self.mailbox_get(id)
    }

    pub fn mailbox_set_active(&self, id: i64, active: bool) -> AppResult<Mailbox> {
        {
            let conn = self.conn();
            load(&conn, id)?;
            conn.execute("UPDATE mailboxes SET is_active = ?1 WHERE id = ?2", params![active as i64, id])?;
        }
        self.mailbox_get(id)
    }

    pub fn mailbox_set_password(&self, id: i64, password: &str) -> AppResult<()> {
        load(&self.conn(), id)?;
        let p = normalize_password(password);
        if p.is_empty() {
            return Err(AppError::validation("password", "كلمة مرور التطبيق مطلوبة"));
        }
        self.secrets.set(&mailbox_key(id), &p)
    }

    /// Connect, log in and open the folder. Either a saved mailbox (`id`) or unsaved settings.
    pub fn mailbox_test(&self, id: Option<i64>, input: Option<MailboxInput>) -> AppResult<MailboxTestResult> {
        let (params, folder) = match (id, input) {
            (_, Some(input)) => {
                let c = validate(&input)?;
                let password = match input.password.as_deref().map(normalize_password).filter(|p| !p.is_empty()) {
                    Some(p) => p,
                    None => match id {
                        Some(id) => self.secrets.get(&mailbox_key(id))?.ok_or_else(missing_password)?,
                        None => return Err(missing_password()),
                    },
                };
                (ConnectParams { host: c.host, port: c.port as u16, email: c.email, password }, c.folder)
            }
            (Some(id), None) => {
                let row = load(&self.conn(), id)?;
                let password = self.secrets.get(&mailbox_key(id))?.ok_or_else(missing_password)?;
                (ConnectParams { host: row.host, port: row.port as u16, email: row.email, password }, row.folder)
            }
            (None, None) => return Err(AppError::validation("id", "حدّد البريد المراد اختباره")),
        };
        let mut f = self.fetchers.connect(&params)?;
        let result = (|| {
            let count = f.folder_count()?;
            f.select(&folder).map_err(|e| {
                AppError::new(e.code, format!("تعذّر فتح المجلد «{folder}»: {}", e.message_ar)).with_field("folder")
            })?;
            Ok(MailboxTestResult { ok: true, folder_count: count as i64 })
        })();
        f.logout();
        result
    }

    /// Delete a mailbox that has no transactions (its stored emails and pull history go too).
    pub fn mailbox_delete(&self, id: i64) -> AppResult<()> {
        {
            let conn = self.conn();
            load(&conn, id)?;
            let txns: i64 =
                conn.query_row("SELECT COUNT(*) FROM paypal_transactions WHERE mailbox_id = ?1", params![id], |r| {
                    r.get(0)
                })?;
            if txns > 0 {
                return Err(AppError::new(
                    ErrorCode::HasDependents,
                    format!("لا يمكن حذف البريد: له {txns} معاملة. يمكنك إيقافه بدلاً من ذلك"),
                ));
            }
            let running: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM pull_runs WHERE mailbox_id = ?1 AND status = 'running')",
                params![id],
                |r| r.get(0),
            )?;
            if running {
                return Err(AppError::new(ErrorCode::PullRunning, "يوجد سحب قيد التشغيل لهذا البريد"));
            }
            let tx = conn.unchecked_transaction()?;
            tx.execute("DELETE FROM raw_emails WHERE mailbox_id = ?1", params![id])?;
            tx.execute("DELETE FROM pull_runs WHERE mailbox_id = ?1", params![id])?;
            tx.execute("DELETE FROM mailboxes WHERE id = ?1", params![id])?;
            tx.commit()?;
        }
        self.secrets.delete(&mailbox_key(id))
    }
}

pub fn missing_password() -> AppError {
    AppError::new(ErrorCode::ImapAuth, "لا توجد كلمة مرور تطبيق محفوظة لهذا البريد").with_field("password")
}
