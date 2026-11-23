//! Test harness: a Core over a temporary database with a fixed clock (UTC+3), an in-memory
//! secret store and a fake mailbox that serves `.eml` fixtures.
#![allow(dead_code)]

use chrono::{TimeZone, Utc};
use ppfeez_core::clock::FixedClock;
use ppfeez_core::customers::{Customer, CustomerInput};
use ppfeez_core::error::{AppError, AppResult, ErrorCode};
use ppfeez_core::mail::fetcher::{ConnectParams, FetchedMessage, FetcherFactory, MailFetcher};
use ppfeez_core::mail::secrets::MemorySecretStore;
use ppfeez_core::transactions::{FeeInput, ManualTxnInput, Transaction};
use ppfeez_core::{Core, CoreConfig};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

pub struct FakeState {
    pub uid_validity: u32,
    pub messages: BTreeMap<u32, Vec<u8>>,
    /// Fail the n-th `fetch` call (1-based) with a connection error, once.
    pub fail_on_fetch_call: Option<usize>,
    pub fetch_calls: usize,
    pub fetched_batches: Vec<Vec<u32>>,
    pub searches: Vec<Option<u32>>,
    pub reject_login: bool,
}

impl Default for FakeState {
    fn default() -> Self {
        FakeState {
            uid_validity: 1,
            messages: BTreeMap::new(),
            fail_on_fetch_call: None,
            fetch_calls: 0,
            fetched_batches: vec![],
            searches: vec![],
            reject_login: false,
        }
    }
}

#[derive(Clone, Default)]
pub struct FakeFactory(pub Arc<Mutex<FakeState>>);

pub struct FakeFetcher(Arc<Mutex<FakeState>>);

impl FetcherFactory for FakeFactory {
    fn connect(&self, p: &ConnectParams) -> AppResult<Box<dyn MailFetcher>> {
        if self.0.lock().unwrap().reject_login || p.password == "wrong" {
            return Err(AppError::new(ErrorCode::ImapAuth, "فشل تسجيل الدخول"));
        }
        Ok(Box::new(FakeFetcher(self.0.clone())))
    }
}

impl MailFetcher for FakeFetcher {
    fn folder_count(&mut self) -> AppResult<usize> {
        Ok(7)
    }
    fn select(&mut self, _folder: &str) -> AppResult<u32> {
        Ok(self.0.lock().unwrap().uid_validity)
    }
    fn search_paypal(&mut self, after_uid: Option<u32>) -> AppResult<Vec<u32>> {
        let mut s = self.0.lock().unwrap();
        s.searches.push(after_uid);
        Ok(s.messages.keys().copied().filter(|u| after_uid.map(|a| *u > a).unwrap_or(true)).collect())
    }
    fn fetch(&mut self, uids: &[u32]) -> AppResult<Vec<FetchedMessage>> {
        let mut s = self.0.lock().unwrap();
        s.fetch_calls += 1;
        if s.fail_on_fetch_call == Some(s.fetch_calls) {
            s.fail_on_fetch_call = None;
            return Err(AppError::new(ErrorCode::ImapConnect, "انقطع الاتصال"));
        }
        s.fetched_batches.push(uids.to_vec());
        Ok(uids
            .iter()
            .filter_map(|u| s.messages.get(u).map(|raw| FetchedMessage { uid: *u, raw: raw.clone() }))
            .collect())
    }
    fn logout(&mut self) {}
}

pub struct Harness {
    pub core: Core,
    pub clock: Arc<FixedClock>,
    pub secrets: Arc<MemorySecretStore>,
    pub mail: FakeFactory,
    pub dir: TempDir,
}

pub fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    open_in(dir)
}

pub fn open_in(dir: TempDir) -> Harness {
    let clock = Arc::new(FixedClock::new(Utc.with_ymd_and_hms(2026, 11, 23, 9, 0, 0).unwrap(), 3));
    let secrets = Arc::new(MemorySecretStore::default());
    let mail = FakeFactory::default();
    let core = Core::open(CoreConfig {
        db_path: dir.path().join("data").join("ppfeez.db"),
        data_dir: dir.path().join("data"),
        version: "0.1.0-test".into(),
        clock: clock.clone(),
        secrets: secrets.clone(),
        fetchers: Arc::new(mail.clone()),
    })
    .unwrap();
    Harness { core, clock, secrets, mail, dir }
}

pub fn fixture(name: &str) -> Vec<u8> {
    let p: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests", "fixtures", "emails", name].iter().collect();
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

impl Harness {
    pub fn customer(&self, name: &str, bps: i64) -> Customer {
        self.core
            .customer_create(CustomerInput {
                name: name.into(),
                phone: None,
                default_commission_bps: bps,
                notes: None,
                is_active: None,
            })
            .unwrap()
    }

    pub fn manual(&self, currency: &str, gross: &str, fee: Option<&str>) -> Transaction {
        self.core
            .txn_create_manual(ManualTxnInput {
                occurred_at: "2026-11-20 10:30".into(),
                payer_name: Some("John Doe".into()),
                payer_email: Some("john.doe@example.com".into()),
                payer_note: None,
                currency: currency.into(),
                gross_text: gross.into(),
                fee_text: fee.map(str::to_string),
                paypal_txn_id: None,
                note: None,
                raw_email_id: None,
            })
            .unwrap()
    }

    pub fn set_fee(&self, id: i64, fee: &str) -> Transaction {
        self.core.txn_set_fee(id, FeeInput::Fee { fee_text: fee.into() }).unwrap()
    }

    pub fn balance(&self, customer_id: i64, currency: &str) -> i64 {
        self.core
            .ledger_balances(customer_id)
            .unwrap()
            .into_iter()
            .find(|b| b.currency == currency)
            .map(|b| b.balance_minor)
            .unwrap_or(0)
    }
}

pub fn code<T: std::fmt::Debug>(r: AppResult<T>) -> ErrorCode {
    r.expect_err("expected an error").code
}
