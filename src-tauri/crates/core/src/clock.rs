//! Time source and date conventions.
//!
//! Stored timestamps are UTC ISO-8601 text (`YYYY-MM-DDTHH:MM:SSZ`) so that string comparison
//! orders them correctly. Periods and ledger entry dates are calendar dates in the device's
//! local time zone.

use chrono::{DateTime, Duration, FixedOffset, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use std::sync::Mutex;

pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
    /// Convert a local wall-clock time to UTC.
    fn local_to_utc(&self, local: NaiveDateTime) -> DateTime<Utc>;
    /// Local wall-clock time of a UTC instant.
    fn utc_to_local(&self, utc: DateTime<Utc>) -> NaiveDateTime;

    fn today(&self) -> NaiveDate {
        self.utc_to_local(self.now()).date()
    }
}

/// The real clock, using the device's time zone.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }

    fn local_to_utc(&self, local: NaiveDateTime) -> DateTime<Utc> {
        match Local.from_local_datetime(&local) {
            chrono::LocalResult::Single(t) => t.with_timezone(&Utc),
            chrono::LocalResult::Ambiguous(a, _) => a.with_timezone(&Utc),
            // A wall-clock time skipped by a DST jump: shift forward an hour.
            chrono::LocalResult::None => Local
                .from_local_datetime(&(local + Duration::hours(1)))
                .earliest()
                .map(|t| t.with_timezone(&Utc))
                .unwrap_or_else(|| Utc.from_utc_datetime(&local)),
        }
    }

    fn utc_to_local(&self, utc: DateTime<Utc>) -> NaiveDateTime {
        utc.with_timezone(&Local).naive_local()
    }
}

/// A controllable clock for tests: fixed offset, settable time.
pub struct FixedClock {
    now: Mutex<DateTime<Utc>>,
    offset: FixedOffset,
}

impl FixedClock {
    pub fn new(now: DateTime<Utc>, offset_hours: i32) -> Self {
        FixedClock { now: Mutex::new(now), offset: FixedOffset::east_opt(offset_hours * 3600).expect("valid offset") }
    }

    pub fn set(&self, now: DateTime<Utc>) {
        *self.now.lock().unwrap() = now;
    }

    pub fn advance(&self, d: Duration) {
        let mut n = self.now.lock().unwrap();
        *n += d;
    }
}

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        *self.now.lock().unwrap()
    }

    fn local_to_utc(&self, local: NaiveDateTime) -> DateTime<Utc> {
        self.offset.from_local_datetime(&local).single().expect("fixed offset is unambiguous").with_timezone(&Utc)
    }

    fn utc_to_local(&self, utc: DateTime<Utc>) -> NaiveDateTime {
        utc.with_timezone(&self.offset).naive_local()
    }
}

/// Canonical storage format for timestamps.
pub fn iso(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn parse_iso(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

pub fn date_str(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}
