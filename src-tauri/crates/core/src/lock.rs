//! Program lock (SPEC §6.1): argon2id hash in settings, 5 wrong attempts ⇒ 30 s wait.
//! The lock only prevents casual use; the database itself is not encrypted.

use crate::clock::iso;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::settings::{self, K_LOCK_ENABLED, K_LOCK_HASH, K_ONBOARDING_DONE};
use crate::Core;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

pub const MAX_ATTEMPTS: u32 = 5;
pub const WAIT_SECONDS: i64 = 30;
pub const MIN_PASSWORD_LEN: usize = 4;

#[derive(Debug, Default)]
pub struct LockState {
    pub locked: bool,
    pub failures: u32,
    pub locked_until: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub version: String,
    pub locked: bool,
    pub lock_enabled: bool,
    pub onboarding_done: bool,
    pub data_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_until: Option<String>,
}

pub fn hash_password(password: &str) -> AppResult<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(AppError::internal)
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

impl Core {
    pub(crate) fn init_lock_state(&self) -> AppResult<()> {
        let enabled = self.lock_enabled()?;
        self.lock_state.lock().unwrap().locked = enabled;
        Ok(())
    }

    fn lock_enabled(&self) -> AppResult<bool> {
        let conn = self.conn();
        let enabled = settings::get_raw(&conn, K_LOCK_ENABLED)?.as_deref() == Some("1");
        let has_hash = settings::get_raw(&conn, K_LOCK_HASH)?.is_some();
        Ok(enabled && has_hash)
    }

    pub fn app_status(&self) -> AppResult<AppStatus> {
        let lock_enabled = self.lock_enabled()?;
        let onboarding_done = settings::get_raw(&self.conn(), K_ONBOARDING_DONE)?.as_deref() == Some("1");
        let st = self.lock_state.lock().unwrap();
        let now = self.clock.now();
        Ok(AppStatus {
            version: self.version.clone(),
            locked: lock_enabled && st.locked,
            lock_enabled,
            onboarding_done,
            data_dir: self.data_dir.display().to_string(),
            locked_until: st.locked_until.filter(|u| *u > now).map(iso),
        })
    }

    /// Fails with `locked` while the program is locked. Called by every command except
    /// `app_status` and `unlock`.
    pub fn guard(&self) -> AppResult<()> {
        // Lock order is always conn → lock_state, so read the setting first.
        let enabled = self.lock_enabled()?;
        if enabled && self.lock_state.lock().unwrap().locked {
            return Err(AppError::new(ErrorCode::Locked, "البرنامج مقفل"));
        }
        Ok(())
    }

    pub fn unlock(&self, password: &str) -> AppResult<AppStatus> {
        if !self.lock_enabled()? {
            self.lock_state.lock().unwrap().locked = false;
            return self.app_status();
        }
        let hash = settings::get_raw(&self.conn(), K_LOCK_HASH)?.unwrap_or_default();
        let now = self.clock.now();
        {
            let mut st = self.lock_state.lock().unwrap();
            if let Some(until) = st.locked_until {
                if until > now {
                    let secs = (until - now).num_seconds().max(1);
                    return Err(AppError::new(
                        ErrorCode::TooManyAttempts,
                        format!("محاولات كثيرة خاطئة. انتظر {secs} ثانية"),
                    ));
                }
                st.locked_until = None;
            }
            if verify_password(password, &hash) {
                st.locked = false;
                st.failures = 0;
            } else {
                st.failures += 1;
                if st.failures >= MAX_ATTEMPTS {
                    st.failures = 0;
                    st.locked_until = Some(now + Duration::seconds(WAIT_SECONDS));
                    return Err(AppError::new(
                        ErrorCode::TooManyAttempts,
                        format!("محاولات كثيرة خاطئة. انتظر {WAIT_SECONDS} ثانية"),
                    ));
                }
                return Err(AppError::new(ErrorCode::WrongPassword, "كلمة المرور غير صحيحة").with_field("password"));
            }
        }
        self.app_status()
    }

    pub fn lock(&self) -> AppResult<()> {
        if self.lock_enabled()? {
            self.lock_state.lock().unwrap().locked = true;
        }
        Ok(())
    }

    /// Set, change (`next = Some`) or disable (`next = None`) the lock password.
    pub fn set_lock_password(&self, current: Option<&str>, next: Option<&str>) -> AppResult<()> {
        if self.lock_enabled()? {
            let hash = settings::get_raw(&self.conn(), K_LOCK_HASH)?.unwrap_or_default();
            if !current.map(|c| verify_password(c, &hash)).unwrap_or(false) {
                return Err(AppError::new(ErrorCode::WrongPassword, "كلمة المرور الحالية غير صحيحة").with_field("current"));
            }
        }
        {
        let conn = self.conn();
        match next {
            Some(p) => {
                if p.chars().count() < MIN_PASSWORD_LEN {
                    return Err(AppError::validation(
                        "next",
                        format!("كلمة القفل يجب أن تكون {MIN_PASSWORD_LEN} أحرف على الأقل"),
                    ));
                }
                let h = hash_password(p)?;
                settings::set_raw(&conn, K_LOCK_HASH, &h)?;
                settings::set_raw(&conn, K_LOCK_ENABLED, "1")?;
            }
            None => {
                settings::delete_raw(&conn, K_LOCK_HASH)?;
                settings::set_raw(&conn, K_LOCK_ENABLED, "0")?;
            }
        }
        }
        let mut st = self.lock_state.lock().unwrap();
        st.locked = false;
        st.failures = 0;
        st.locked_until = None;
        Ok(())
    }
}
