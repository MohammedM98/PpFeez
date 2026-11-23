//! Mailbox passwords (Gmail App Passwords) live in the OS credential store — Windows
//! Credential Manager in production — under the key `ppfeez:mailbox:{id}`. Never in SQLite.

use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::sync::Mutex;

pub fn mailbox_key(id: i64) -> String {
    format!("ppfeez:mailbox:{id}")
}

pub trait SecretStore: Send + Sync {
    fn set(&self, key: &str, secret: &str) -> AppResult<()>;
    fn get(&self, key: &str) -> AppResult<Option<String>>;
    fn delete(&self, key: &str) -> AppResult<()>;
}

/// Production store via the `keyring` crate (v4, `v1` feature).
pub struct KeyringSecretStore;

const SERVICE: &str = "PpFeez";

impl KeyringSecretStore {
    fn entry(key: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(SERVICE, key)
            .map_err(|e| AppError::internal(format!("تعذّر الوصول إلى خزنة كلمات المرور: {e}")))
    }
}

impl SecretStore for KeyringSecretStore {
    fn set(&self, key: &str, secret: &str) -> AppResult<()> {
        Self::entry(key)?
            .set_password(secret)
            .map_err(|e| AppError::internal(format!("تعذّر حفظ كلمة المرور في خزنة ويندوز: {e}")))
    }

    fn get(&self, key: &str) -> AppResult<Option<String>> {
        match Self::entry(key)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::internal(format!("تعذّر قراءة كلمة المرور من خزنة ويندوز: {e}"))),
        }
    }

    fn delete(&self, key: &str) -> AppResult<()> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::internal(format!("تعذّر حذف كلمة المرور: {e}"))),
        }
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn set(&self, key: &str, secret: &str) -> AppResult<()> {
        self.map.lock().unwrap().insert(key.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, key: &str) -> AppResult<Option<String>> {
        Ok(self.map.lock().unwrap().get(key).cloned())
    }

    fn delete(&self, key: &str) -> AppResult<()> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}
