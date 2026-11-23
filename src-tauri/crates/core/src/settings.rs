//! Key/value settings (`settings` table) exposed as the contract's `Settings` object.

use crate::commission::validate_bps;
use crate::error::{AppError, AppResult};
use crate::Core;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Deserializer, Serialize};

pub const K_LOCK_ENABLED: &str = "lock_enabled";
pub const K_LOCK_HASH: &str = "lock_hash";
pub const K_BACKUP_DIR: &str = "backup_dir";
pub const K_BACKUP_ON_CLOSE: &str = "backup_on_close";
pub const K_BACKUP_KEEP: &str = "backup_keep";
pub const K_THEME: &str = "theme";
pub const K_DEFAULT_COMMISSION_BPS: &str = "default_commission_bps";
pub const K_FEE_ESTIMATE_BPS: &str = "fee_estimate_bps";
pub const K_FEE_ESTIMATE_FIXED_MINOR: &str = "fee_estimate_fixed_minor";
pub const K_FEE_ESTIMATE_ENABLED: &str = "fee_estimate_enabled";
pub const K_AUTO_LOCK_MINUTES: &str = "auto_lock_minutes";
pub const K_ONBOARDING_DONE: &str = "onboarding_done";
pub const K_EXCEL_EXPORT_PATH: &str = "excel_export_path";
pub const K_EXCEL_LAST_EXPORTED_AT: &str = "excel_last_exported_at";
pub const K_EXCEL_UPDATE_ON_CLOSE: &str = "excel_update_on_close";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Dark,
    Light,
    System,
}

impl Theme {
    fn as_str(self) -> &'static str {
        match self {
            Theme::Dark => "dark",
            Theme::Light => "light",
            Theme::System => "system",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    pub default_commission_bps: i64,
    pub fee_estimate_enabled: bool,
    pub fee_estimate_bps: i64,
    pub fee_estimate_fixed_minor: i64,
    pub backup_dir: Option<String>,
    pub backup_on_close: bool,
    pub backup_keep: i64,
    pub auto_lock_minutes: Option<i64>,
    pub onboarding_done: bool,
    pub excel_export_path: Option<String>,
    pub excel_last_exported_at: Option<String>,
    pub excel_update_on_close: bool,
}

/// Distinguish an absent field from an explicit `null` in a patch.
fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// `Partial<Settings>` from the UI.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub theme: Option<Theme>,
    pub default_commission_bps: Option<i64>,
    pub fee_estimate_enabled: Option<bool>,
    pub fee_estimate_bps: Option<i64>,
    pub fee_estimate_fixed_minor: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub backup_dir: Option<Option<String>>,
    pub backup_on_close: Option<bool>,
    pub backup_keep: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub auto_lock_minutes: Option<Option<i64>>,
    pub onboarding_done: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub excel_export_path: Option<Option<String>>,
    pub excel_update_on_close: Option<bool>,
}

pub fn get_raw(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0)).optional()?)
}

pub fn set_raw(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete_raw(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

fn get_i64(conn: &Connection, key: &str, default: i64) -> AppResult<i64> {
    Ok(get_raw(conn, key)?.and_then(|v| v.parse().ok()).unwrap_or(default))
}

fn get_bool(conn: &Connection, key: &str, default: bool) -> AppResult<bool> {
    Ok(get_raw(conn, key)?.map(|v| v == "1" || v == "true").unwrap_or(default))
}

fn bool_str(b: bool) -> &'static str {
    if b {
        "1"
    } else {
        "0"
    }
}

pub fn load(conn: &Connection) -> AppResult<Settings> {
    let theme = match get_raw(conn, K_THEME)?.as_deref() {
        Some("dark") => Theme::Dark,
        Some("light") => Theme::Light,
        _ => Theme::System,
    };
    Ok(Settings {
        theme,
        default_commission_bps: get_i64(conn, K_DEFAULT_COMMISSION_BPS, 2500)?,
        fee_estimate_enabled: get_bool(conn, K_FEE_ESTIMATE_ENABLED, false)?,
        fee_estimate_bps: get_i64(conn, K_FEE_ESTIMATE_BPS, 440)?,
        fee_estimate_fixed_minor: get_i64(conn, K_FEE_ESTIMATE_FIXED_MINOR, 30)?,
        backup_dir: get_raw(conn, K_BACKUP_DIR)?.filter(|s| !s.is_empty()),
        backup_on_close: get_bool(conn, K_BACKUP_ON_CLOSE, true)?,
        backup_keep: get_i64(conn, K_BACKUP_KEEP, 30)?,
        auto_lock_minutes: get_raw(conn, K_AUTO_LOCK_MINUTES)?.and_then(|v| v.parse().ok()),
        onboarding_done: get_bool(conn, K_ONBOARDING_DONE, false)?,
        excel_export_path: get_raw(conn, K_EXCEL_EXPORT_PATH)?.filter(|s| !s.is_empty()),
        excel_last_exported_at: get_raw(conn, K_EXCEL_LAST_EXPORTED_AT)?.filter(|s| !s.is_empty()),
        excel_update_on_close: get_bool(conn, K_EXCEL_UPDATE_ON_CLOSE, true)?,
    })
}

impl Core {
    pub fn get_settings(&self) -> AppResult<Settings> {
        load(&self.conn())
    }

    pub fn update_settings(&self, patch: SettingsPatch) -> AppResult<Settings> {
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        if let Some(t) = patch.theme {
            set_raw(&tx, K_THEME, t.as_str())?;
        }
        if let Some(b) = patch.default_commission_bps {
            validate_bps(b).map_err(|e| e.with_field("defaultCommissionBps"))?;
            set_raw(&tx, K_DEFAULT_COMMISSION_BPS, &b.to_string())?;
        }
        if let Some(e) = patch.fee_estimate_enabled {
            set_raw(&tx, K_FEE_ESTIMATE_ENABLED, bool_str(e))?;
        }
        if let Some(b) = patch.fee_estimate_bps {
            validate_bps(b).map_err(|e| e.with_field("feeEstimateBps"))?;
            set_raw(&tx, K_FEE_ESTIMATE_BPS, &b.to_string())?;
        }
        if let Some(f) = patch.fee_estimate_fixed_minor {
            if f < 0 {
                return Err(AppError::invalid_amount("feeEstimateFixedMinor"));
            }
            set_raw(&tx, K_FEE_ESTIMATE_FIXED_MINOR, &f.to_string())?;
        }
        if let Some(dir) = patch.backup_dir {
            match dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
                Some(d) => set_raw(&tx, K_BACKUP_DIR, &d)?,
                None => delete_raw(&tx, K_BACKUP_DIR)?,
            }
        }
        if let Some(b) = patch.backup_on_close {
            set_raw(&tx, K_BACKUP_ON_CLOSE, bool_str(b))?;
        }
        if let Some(k) = patch.backup_keep {
            if !(1..=1000).contains(&k) {
                return Err(AppError::validation("backupKeep", "عدد النسخ المحفوظة يجب أن يكون بين 1 و1000"));
            }
            set_raw(&tx, K_BACKUP_KEEP, &k.to_string())?;
        }
        if let Some(m) = patch.auto_lock_minutes {
            match m {
                Some(m) if m > 0 => set_raw(&tx, K_AUTO_LOCK_MINUTES, &m.to_string())?,
                Some(_) => {
                    return Err(AppError::validation(
                        "autoLockMinutes",
                        "مدة القفل التلقائي يجب أن تكون دقيقة على الأقل",
                    ))
                }
                None => delete_raw(&tx, K_AUTO_LOCK_MINUTES)?,
            }
        }
        if let Some(d) = patch.onboarding_done {
            set_raw(&tx, K_ONBOARDING_DONE, bool_str(d))?;
        }
        if let Some(p) = patch.excel_export_path {
            match p.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
                Some(p) => set_raw(&tx, K_EXCEL_EXPORT_PATH, &crate::excel::validate_xlsx_path(&p)?)?,
                None => delete_raw(&tx, K_EXCEL_EXPORT_PATH)?,
            }
        }
        if let Some(b) = patch.excel_update_on_close {
            set_raw(&tx, K_EXCEL_UPDATE_ON_CLOSE, bool_str(b))?;
        }
        let s = load(&tx)?;
        tx.commit()?;
        Ok(s)
    }
}
