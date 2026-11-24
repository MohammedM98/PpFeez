//! The "Pull" button (SPEC §5.1): incremental UID-based sync in batches of 50 with progress,
//! cancellation between batches and safe resumption after a failure.

use super::fetcher::{ConnectParams, MailFetcher};
use super::ingest::{extract, ingest, Ingested};
use super::mailboxes::{self, missing_password};
use super::secrets::mailbox_key;
use crate::clock::{date_str, parse_date};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::Core;
use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const BATCH_SIZE: usize = 50;
pub const MAX_RANGE_DAYS: i64 = 3650;

/// What to pull (SPEC §5.5). Dates are inclusive local calendar days `YYYY-MM-DD`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PullRange {
    /// Since the last pull (everything on the first pull or after a UIDVALIDITY change).
    #[default]
    New,
    LastDays {
        days: i64,
    },
    Between {
        from: String,
        to: String,
    },
    All,
}

/// A validated range: `(kind, from, to)` as stored in `pull_runs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedRange {
    pub kind: &'static str,
    pub window: Option<(NaiveDate, NaiveDate)>,
}

fn invalid_range(msg: &str) -> AppError {
    AppError::new(ErrorCode::InvalidRange, msg).with_field("range")
}

impl PullRange {
    pub fn resolve(&self, today: NaiveDate) -> AppResult<ResolvedRange> {
        Ok(match self {
            PullRange::New => ResolvedRange { kind: "new", window: None },
            PullRange::All => ResolvedRange { kind: "all", window: None },
            PullRange::LastDays { days } => {
                if !(1..=MAX_RANGE_DAYS).contains(days) {
                    return Err(invalid_range("عدد الأيام يجب أن يكون بين 1 و3650"));
                }
                ResolvedRange { kind: "last_days", window: Some((today - Duration::days(days - 1), today)) }
            }
            PullRange::Between { from, to } => {
                let (Some(f), Some(t)) = (parse_date(from), parse_date(to)) else {
                    return Err(invalid_range("التاريخ غير صالح (YYYY-MM-DD)"));
                };
                if f > t {
                    return Err(invalid_range("تاريخ البداية بعد تاريخ النهاية"));
                }
                if t > today {
                    return Err(invalid_range("لا يمكن اختيار تاريخ في المستقبل"));
                }
                ResolvedRange { kind: "between", window: Some((f, t)) }
            }
        })
    }
}

fn range_from_row(kind: &str, from: Option<String>, to: Option<String>) -> PullRange {
    let dates = from.as_deref().and_then(parse_date).zip(to.as_deref().and_then(parse_date));
    match (kind, dates) {
        ("all", _) => PullRange::All,
        ("last_days", Some((f, t))) => PullRange::LastDays { days: (t - f).num_days() + 1 },
        ("between", Some(_)) => PullRange::Between { from: from.unwrap_or_default(), to: to.unwrap_or_default() },
        _ => PullRange::New,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PullStatus {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRun {
    pub id: i64,
    pub mailbox_id: i64,
    pub mailbox_label: String,
    pub status: PullStatus,
    pub total_count: i64,
    pub fetched_count: i64,
    pub new_transactions_count: i64,
    pub duplicate_count: i64,
    pub ignored_count: i64,
    pub failed_count: i64,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub range: PullRange,
}

fn run_from_row(r: &Row<'_>) -> rusqlite::Result<PullRun> {
    Ok(PullRun {
        id: r.get("id")?,
        mailbox_id: r.get("mailbox_id")?,
        mailbox_label: r.get("label")?,
        status: match r.get::<_, String>("status")?.as_str() {
            "running" => PullStatus::Running,
            "done" => PullStatus::Done,
            "cancelled" => PullStatus::Cancelled,
            _ => PullStatus::Failed,
        },
        total_count: r.get("total_count")?,
        fetched_count: r.get("fetched_count")?,
        new_transactions_count: r.get("new_transactions_count")?,
        duplicate_count: r.get("duplicate_count")?,
        ignored_count: r.get("ignored_count")?,
        failed_count: r.get("failed_count")?,
        error: r.get("error")?,
        started_at: r.get("started_at")?,
        finished_at: r.get("finished_at")?,
        range: range_from_row(&r.get::<_, String>("range_kind")?, r.get("range_from")?, r.get("range_to")?),
    })
}

const SELECT: &str = "SELECT p.*, m.label FROM pull_runs p JOIN mailboxes m ON m.id = p.mailbox_id";

pub fn get_run(conn: &Connection, id: i64) -> AppResult<PullRun> {
    conn.query_row(&format!("{SELECT} WHERE p.id = ?1"), params![id], run_from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("عملية السحب"))
}

pub fn last_run(conn: &Connection) -> AppResult<Option<PullRun>> {
    Ok(conn.query_row(&format!("{SELECT} ORDER BY p.id DESC LIMIT 1"), [], run_from_row).optional()?)
}

#[derive(Default)]
struct Counters {
    fetched: i64,
    new: i64,
    duplicate: i64,
    ignored: i64,
    failed: i64,
}

impl Core {
    pub fn pull_runs_list(&self, limit: i64) -> AppResult<Vec<PullRun>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY p.id DESC LIMIT ?1"))?;
        let rows = stmt.query_map(params![limit.clamp(1, 1000)], run_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Create a `running` pull for a mailbox. The caller then runs [`Core::pull_execute`]
    /// (on a background thread) with the returned cancel flag.
    pub fn pull_start(&self, mailbox_id: i64, range: Option<PullRange>) -> AppResult<(PullRun, Arc<AtomicBool>)> {
        let resolved = range.unwrap_or_default().resolve(self.clock.today())?;
        let now = self.now_iso();
        let conn = self.conn();
        let mb = mailboxes::load(&conn, mailbox_id)?;
        if !mb.is_active {
            return Err(AppError::validation("mailboxId", "هذا البريد موقوف. فعّله من الإعدادات أولاً"));
        }
        let tx = conn.unchecked_transaction()?;
        let running: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pull_runs WHERE mailbox_id = ?1 AND status = 'running')",
            params![mailbox_id],
            |r| r.get(0),
        )?;
        if running {
            return Err(AppError::new(ErrorCode::PullRunning, "يوجد سحب قيد التشغيل لهذا البريد"));
        }
        tx.execute(
            "INSERT INTO pull_runs (mailbox_id, status, started_at, range_kind, range_from, range_to)
             VALUES (?1, 'running', ?2, ?3, ?4, ?5)",
            params![
                mailbox_id,
                now,
                resolved.kind,
                resolved.window.map(|w| date_str(w.0)),
                resolved.window.map(|w| date_str(w.1))
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        let flag = Arc::new(AtomicBool::new(false));
        self.pulls.lock().unwrap().insert(id, flag.clone());
        Ok((get_run(&conn, id)?, flag))
    }

    pub fn pull_cancel(&self, run_id: i64) -> AppResult<()> {
        match self.pulls.lock().unwrap().get(&run_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
            None => Err(AppError::invalid_transition("عملية السحب ليست قيد التشغيل")),
        }
    }

    /// Run a pull to completion. Never panics or returns an error: failures are recorded on
    /// the run (`failed` + message) and whatever was saved stays saved.
    pub fn pull_execute(&self, run_id: i64, cancel: &AtomicBool, on_progress: &dyn Fn(&PullRun)) -> PullRun {
        let mut c = Counters::default();
        let result = self.pull_inner(run_id, cancel, on_progress, &mut c);
        let now = self.now_iso();
        let (status, error) = match &result {
            Ok(true) => ("done", None),
            Ok(false) => ("cancelled", None),
            Err(e) => ("failed", Some(e.message_ar.clone())),
        };
        let conn = self.conn();
        let _ = conn.execute(
            "UPDATE pull_runs SET status = ?1, error = ?2, finished_at = ?3, fetched_count = ?4,
             new_transactions_count = ?5, duplicate_count = ?6, ignored_count = ?7, failed_count = ?8 WHERE id = ?9",
            params![status, error, now, c.fetched, c.new, c.duplicate, c.ignored, c.failed, run_id],
        );
        if status == "done" {
            let _ = conn.execute(
                "UPDATE mailboxes SET last_pulled_at = ?1 WHERE id = (SELECT mailbox_id FROM pull_runs WHERE id = ?2)",
                params![now, run_id],
            );
        }
        self.pulls.lock().unwrap().remove(&run_id);
        get_run(&conn, run_id).unwrap_or_else(|_| PullRun {
            id: run_id,
            mailbox_id: 0,
            mailbox_label: String::new(),
            status: PullStatus::Failed,
            total_count: 0,
            fetched_count: c.fetched,
            new_transactions_count: c.new,
            duplicate_count: c.duplicate,
            ignored_count: c.ignored,
            failed_count: c.failed,
            error,
            started_at: now.clone(),
            finished_at: Some(now),
            range: PullRange::New,
        })
    }

    /// `Ok(true)` = done, `Ok(false)` = cancelled.
    fn pull_inner(
        &self,
        run_id: i64,
        cancel: &AtomicBool,
        on_progress: &dyn Fn(&PullRun),
        c: &mut Counters,
    ) -> AppResult<bool> {
        let mb = {
            let conn = self.conn();
            let run = get_run(&conn, run_id)?;
            mailboxes::load(&conn, run.mailbox_id)?
        };
        let password = self.secrets.get(&mailbox_key(mb.id))?.ok_or_else(missing_password)?;
        let mut fetcher = self.fetchers.connect(&ConnectParams {
            host: mb.host.clone(),
            port: mb.port as u16,
            email: mb.email.clone(),
            password,
        })?;
        let r = self.pull_with(&mut *fetcher, &mb, run_id, cancel, on_progress, c);
        fetcher.logout();
        r
    }

    fn pull_with(
        &self,
        f: &mut dyn MailFetcher,
        mb: &mailboxes::MailboxRow,
        run_id: i64,
        cancel: &AtomicBool,
        on_progress: &dyn Fn(&PullRun),
        c: &mut Counters,
    ) -> AppResult<bool> {
        let range = get_run(&self.conn(), run_id)?.range;
        // The window stored at pull_start (validated there).
        let window: Option<(NaiveDate, NaiveDate)> = {
            let (from, to): (Option<String>, Option<String>) = self.conn().query_row(
                "SELECT range_from, range_to FROM pull_runs WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            from.as_deref().and_then(parse_date).zip(to.as_deref().and_then(parse_date))
        };
        let validity = f.select(&mb.folder)? as i64;
        let changed = mb.uid_validity != Some(validity);
        if changed {
            // First pull, or the server renumbered the folder: old UIDs mean nothing any more.
            // Message-ID de-duplication keeps already stored emails from repeating.
            self.conn().execute(
                "UPDATE mailboxes SET uid_validity = ?1, last_uid = 0 WHERE id = ?2",
                params![validity, mb.id],
            )?;
        }
        let uids = match (&range, window) {
            (PullRange::New, _) => f.search_paypal(if changed { None } else { Some(mb.last_uid as u32) })?,
            // IMAP dates are whole days in the server's zone: widen by a day on each side, then
            // filter each message by its Date header in local time.
            (_, Some((from, to))) => f.search_paypal_dates(from - Duration::days(1), to + Duration::days(2))?,
            _ => f.search_paypal(None)?,
        };
        let mut total = uids.len() as i64;
        self.conn().execute("UPDATE pull_runs SET total_count = ?1 WHERE id = ?2", params![total, run_id])?;
        on_progress(&get_run(&self.conn(), run_id)?);

        for batch in uids.chunks(BATCH_SIZE) {
            if cancel.load(Ordering::SeqCst) {
                return Ok(false);
            }
            let messages = f.fetch(batch)?;
            let now = self.now_iso();
            {
                let conn = self.conn();
                for m in &messages {
                    let fallback = format!("ppfeez-no-id:{}:{}:{}", mb.id, validity, m.uid);
                    let stored = extract(&m.raw, &fallback, self.clock.now());
                    if let (Some((from, to)), Some(e)) = (window, &stored) {
                        let day = self.clock.utc_to_local(e.received_at).date();
                        if day < from || day > to {
                            // Outside the chosen range: not stored, not counted.
                            total -= 1;
                            continue;
                        }
                    }
                    let outcome = match stored {
                        Some(stored) => {
                            let tx = conn.unchecked_transaction()?;
                            let o = ingest(&tx, &now, mb.id, m.uid, &stored)?;
                            tx.commit()?;
                            o
                        }
                        None => Ingested::Failed,
                    };
                    c.fetched += 1;
                    match outcome {
                        Ingested::New => c.new += 1,
                        Ingested::Duplicate | Ingested::AlreadySeen => c.duplicate += 1,
                        Ingested::Ignored => c.ignored += 1,
                        Ingested::Failed => c.failed += 1,
                    }
                }
                let max_uid = *batch.iter().max().unwrap_or(&0) as i64;
                let tx = conn.unchecked_transaction()?;
                tx.execute("UPDATE mailboxes SET last_uid = MAX(last_uid, ?1) WHERE id = ?2", params![max_uid, mb.id])?;
                tx.execute(
                    "UPDATE pull_runs SET fetched_count = ?1, new_transactions_count = ?2, duplicate_count = ?3,
                     ignored_count = ?4, failed_count = ?5, total_count = ?6 WHERE id = ?7",
                    params![c.fetched, c.new, c.duplicate, c.ignored, c.failed, total, run_id],
                )?;
                tx.commit()?;
            }
            on_progress(&get_run(&self.conn(), run_id)?);
        }
        Ok(true)
    }
}
