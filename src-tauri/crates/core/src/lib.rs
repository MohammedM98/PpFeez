//! PpFeez core: all business logic, storage and mail handling, independent of Tauri.
//!
//! The Tauri app (`src-tauri/src`) is a thin command layer over [`Core`]. Every public
//! method returns [`AppResult`], whose error serializes to the contract's `AppError`.

pub mod audit;
pub mod backup;
pub mod clock;
pub mod commission;
pub mod customers;
pub mod dashboard;
pub mod db;
pub mod deletion;
pub mod emails;
pub mod error;
pub mod excel;
pub mod ledger;
pub mod lock;
pub mod mail;
pub mod money;
pub mod paypal;
pub mod refunds;
pub mod settings;
pub mod transactions;

pub use error::{AppError, AppResult, ErrorCode};

use clock::{iso, Clock, SystemClock};
use mail::fetcher::{FetcherFactory, ImapFetcherFactory};
use mail::secrets::{KeyringSecretStore, SecretStore};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

/// Everything the core needs from the outside world. Tests swap the clock, the secret store
/// and the mail fetcher for in-memory fakes.
pub struct CoreConfig {
    pub db_path: PathBuf,
    pub data_dir: PathBuf,
    pub version: String,
    pub clock: Arc<dyn Clock>,
    pub secrets: Arc<dyn SecretStore>,
    pub fetchers: Arc<dyn FetcherFactory>,
}

impl CoreConfig {
    /// Production configuration: system clock, Windows Credential Manager, real IMAP.
    pub fn production(data_dir: &Path, version: &str) -> Self {
        CoreConfig {
            db_path: data_dir.join("ppfeez.db"),
            data_dir: data_dir.to_path_buf(),
            version: version.to_string(),
            clock: Arc::new(SystemClock),
            secrets: Arc::new(KeyringSecretStore),
            fetchers: Arc::new(ImapFetcherFactory),
        }
    }
}

pub struct Core {
    conn: Mutex<Connection>,
    pub(crate) db_path: PathBuf,
    pub(crate) data_dir: PathBuf,
    pub(crate) version: String,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) secrets: Arc<dyn SecretStore>,
    pub(crate) fetchers: Arc<dyn FetcherFactory>,
    pub(crate) lock_state: Mutex<lock::LockState>,
    /// Cancel flags of running pulls, by run id.
    pub(crate) pulls: Mutex<HashMap<i64, Arc<AtomicBool>>>,
}

impl Core {
    /// Open (or create) the database, apply migrations and recover from an unclean shutdown.
    pub fn open(cfg: CoreConfig) -> AppResult<Core> {
        if let Some(parent) = cfg.db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = db::open(&cfg.db_path)?;
        let core = Core {
            conn: Mutex::new(conn),
            db_path: cfg.db_path,
            data_dir: cfg.data_dir,
            version: cfg.version,
            clock: cfg.clock,
            secrets: cfg.secrets,
            fetchers: cfg.fetchers,
            lock_state: Mutex::new(lock::LockState::default()),
            pulls: Mutex::new(HashMap::new()),
        };
        core.init_lock_state()?;
        core.fail_stale_pulls()?;
        // One-off re-parse after a parser update; never blocks startup.
        if let Err(e) = core.reparse_after_update() {
            eprintln!("re-parse after update failed: {e}");
        }
        Ok(core)
    }

    pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn now_iso(&self) -> String {
        iso(self.clock.now())
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}
