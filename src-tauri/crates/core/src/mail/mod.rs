//! Gmail pull: fetcher abstraction, IMAP client, sender verification, pull runs.

pub mod fetcher;
pub mod imap_fetcher;
pub mod ingest;
pub mod mailboxes;
pub mod pull;
pub mod secrets;
pub mod verify;

use crate::error::AppResult;
use crate::Core;
use rusqlite::params;

impl Core {
    /// On startup any run still marked `running` was interrupted (crash/power loss).
    pub(crate) fn fail_stale_pulls(&self) -> AppResult<()> {
        let now = self.now_iso();
        self.conn().execute(
            "UPDATE pull_runs SET status = 'failed', error = 'انقطع', finished_at = ?1 WHERE status = 'running'",
            params![now],
        )?;
        Ok(())
    }
}
