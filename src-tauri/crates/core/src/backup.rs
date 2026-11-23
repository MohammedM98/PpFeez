//! Backups (SPEC §6.7): online SQLite backups to the chosen folder, keep the newest N,
//! backup on close, and restore (taking a backup of the current data first).

use crate::clock::iso;
use crate::db;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::settings;
use crate::Core;
use chrono::NaiveDateTime;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};

const PREFIX: &str = "ppfeez-";
const EXT: &str = ".db";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub path: String,
    pub created_at: String,
    pub size_bytes: i64,
}

fn failed(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::BackupFailed, msg)
}

/// Local timestamp encoded in a backup file name `ppfeez-YYYYMMDD-HHMMSS[-n].db`.
fn stamp_of(name: &str) -> Option<NaiveDateTime> {
    let core = name.strip_prefix(PREFIX)?.strip_suffix(EXT)?;
    let stamp = core.get(..15)?;
    NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S").ok()
}

impl Core {
    fn backup_dir(&self) -> AppResult<Option<PathBuf>> {
        Ok(settings::load(&self.conn())?.backup_dir.map(PathBuf::from))
    }

    /// Write a consistent copy of the live database into `dir`.
    fn backup_into(&self, dir: &Path) -> AppResult<BackupFile> {
        std::fs::create_dir_all(dir).map_err(|e| failed(format!("تعذّر إنشاء مجلد النسخ: {e}")))?;
        let local = self.clock.utc_to_local(self.clock.now());
        let base = format!("{PREFIX}{}", local.format("%Y%m%d-%H%M%S"));
        let mut path = dir.join(format!("{base}{EXT}"));
        let mut n = 1;
        while path.exists() {
            path = dir.join(format!("{base}-{n}{EXT}"));
            n += 1;
        }
        {
            let conn = self.conn();
            conn.backup(rusqlite::MAIN_DB, &path, None::<fn(rusqlite::backup::Progress)>)
                .map_err(|e| failed(format!("فشل إنشاء النسخة الاحتياطية: {e}")))?;
        }
        let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
        Ok(BackupFile { path: path.display().to_string(), created_at: self.now_iso(), size_bytes: size })
    }

    pub fn backup_now(&self) -> AppResult<BackupFile> {
        let dir = self
            .backup_dir()?
            .ok_or_else(|| failed("لم يُحدَّد مجلد النسخ الاحتياطي. اختره من الإعدادات"))?;
        let file = self.backup_into(&dir)?;
        self.prune_backups(&dir)?;
        Ok(file)
    }

    /// Called when the app closes: back up if enabled and a folder is set.
    pub fn backup_on_close(&self) -> AppResult<Option<BackupFile>> {
        let s = settings::load(&self.conn())?;
        if !s.backup_on_close || s.backup_dir.is_none() {
            return Ok(None);
        }
        self.backup_now().map(Some)
    }

    fn list_in(&self, dir: &Path) -> AppResult<Vec<BackupFile>> {
        let mut out = vec![];
        let Ok(rd) = std::fs::read_dir(dir) else { return Ok(out) };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(stamp) = stamp_of(&name) else { continue };
            let size = entry.metadata().map(|m| m.len() as i64).unwrap_or(0);
            out.push(BackupFile {
                path: entry.path().display().to_string(),
                created_at: iso(self.clock.local_to_utc(stamp)),
                size_bytes: size,
            });
        }
        out.sort_by(|a, b| b.path.cmp(&a.path));
        Ok(out)
    }

    pub fn backup_list(&self) -> AppResult<Vec<BackupFile>> {
        match self.backup_dir()? {
            Some(dir) => self.list_in(&dir),
            None => Ok(vec![]),
        }
    }

    fn prune_backups(&self, dir: &Path) -> AppResult<()> {
        let keep = settings::load(&self.conn())?.backup_keep.max(1) as usize;
        for old in self.list_in(dir)?.into_iter().skip(keep) {
            let _ = std::fs::remove_file(&old.path);
        }
        Ok(())
    }

    /// Replace the live data with a backup file. A backup of the current data is taken first
    /// (into the backup folder, or `<data dir>/pre-restore` when none is set). The caller
    /// restarts the app afterwards.
    pub fn backup_restore(&self, path: &Path) -> AppResult<BackupFile> {
        let restore_failed = |m: String| AppError::new(ErrorCode::RestoreFailed, m);
        // Validate the file before touching anything.
        {
            let src = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| restore_failed(format!("تعذّر فتح الملف: {e}")))?;
            let ok: String = src
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .map_err(|_| restore_failed("الملف ليس قاعدة بيانات صالحة".into()))?;
            if ok != "ok" {
                return Err(restore_failed("الملف تالف".into()));
            }
            let has_tables: i64 = src
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
                     AND name IN ('customers','paypal_transactions','ledger_entries','settings')",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| restore_failed(e.to_string()))?;
            if has_tables != 4 {
                return Err(restore_failed("الملف ليس نسخة احتياطية من PpFeez".into()));
            }
            let v: i64 = src.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap_or(0);
            if v > db::schema_version() {
                return Err(restore_failed("النسخة من إصدار أحدث من البرنامج".into()));
            }
        }
        let safety_dir = self.backup_dir()?.unwrap_or_else(|| self.data_dir.join("pre-restore"));
        let safety = self
            .backup_into(&safety_dir)
            .map_err(|e| restore_failed(format!("تعذّر أخذ نسخة من البيانات الحالية: {}", e.message_ar)))?;
        {
            let mut conn = self.conn();
            conn.restore(rusqlite::MAIN_DB, path, None::<fn(rusqlite::backup::Progress)>)
                .map_err(|e| restore_failed(format!("فشلت الاستعادة: {e}")))?;
            db::configure(&conn, true)?;
            db::migrate(&conn)?;
        }
        self.init_lock_state()?;
        self.fail_stale_pulls()?;
        Ok(safety)
    }
}
