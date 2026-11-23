//! Mail source abstraction. [`ImapFetcherFactory`] talks to Gmail; tests use a fake that
//! serves `.eml` files.

use crate::error::AppResult;

pub use super::imap_fetcher::ImapFetcherFactory;

#[derive(Debug, Clone)]
pub struct FetchedMessage {
    pub uid: u32,
    pub raw: Vec<u8>,
}

/// Connection parameters of a mailbox.
#[derive(Debug, Clone)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub email: String,
    pub password: String,
}

pub trait FetcherFactory: Send + Sync {
    /// Connect and log in. Errors: `imap_connect`, `imap_auth`, `imap_disabled`.
    fn connect(&self, params: &ConnectParams) -> AppResult<Box<dyn MailFetcher>>;
}

pub trait MailFetcher: Send {
    /// Number of folders visible to the account (used by "test connection").
    fn folder_count(&mut self) -> AppResult<usize>;
    /// Open `folder` read-only and return its UIDVALIDITY.
    fn select(&mut self, folder: &str) -> AppResult<u32>;
    /// `UID SEARCH FROM "paypal.com"`, limited to UIDs greater than `after_uid` when given.
    /// Returns UIDs in ascending order.
    fn search_paypal(&mut self, after_uid: Option<u32>) -> AppResult<Vec<u32>>;
    /// Fetch full messages with `BODY.PEEK[]` (does not mark them as read).
    fn fetch(&mut self, uids: &[u32]) -> AppResult<Vec<FetchedMessage>>;
    fn logout(&mut self);
}
