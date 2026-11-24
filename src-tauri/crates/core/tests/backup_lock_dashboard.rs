mod common;

use chrono::Duration;
use common::{code, harness};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::ledger::{PayoutInput, PayoutMethod};
use ppfeez_core::settings::{SettingsPatch, Theme};
use ppfeez_core::transactions::Period;

fn set_backup_dir(h: &common::Harness, keep: i64) -> std::path::PathBuf {
    let dir = h.dir.path().join("backups");
    h.core
        .update_settings(SettingsPatch {
            backup_dir: Some(Some(dir.display().to_string())),
            backup_keep: Some(keep),
            ..Default::default()
        })
        .unwrap();
    dir
}

#[test]
fn backup_requires_a_folder() {
    let h = harness();
    assert_eq!(code(h.core.backup_now()), ErrorCode::BackupFailed);
    assert!(h.core.backup_on_close().unwrap().is_none());
    assert!(h.core.backup_list().unwrap().is_empty());
}

#[test]
fn backup_keeps_the_newest_n() {
    let h = harness();
    set_backup_dir(&h, 3);
    for _ in 0..5 {
        h.core.backup_now().unwrap();
        h.clock.advance(Duration::seconds(61));
    }
    let list = h.core.backup_list().unwrap();
    assert_eq!(list.len(), 3);
    assert!(list[0].path > list[1].path, "newest first");
    assert!(list[0].size_bytes > 0);
    // 09:00Z + 4×61 s at UTC+3 → file named with local time.
    assert!(list[0].path.ends_with("ppfeez-20261123-120404.db"), "{}", list[0].path);
    assert_eq!(list[0].created_at, "2026-11-23T09:04:04Z");
}

#[test]
fn same_second_backups_do_not_overwrite() {
    let h = harness();
    set_backup_dir(&h, 30);
    let a = h.core.backup_now().unwrap();
    let b = h.core.backup_now().unwrap();
    assert_ne!(a.path, b.path);
    assert_eq!(h.core.backup_list().unwrap().len(), 2);
}

#[test]
fn backup_and_restore_round_trip() {
    let h = harness();
    set_backup_dir(&h, 30);
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100", Some("0"));
    h.core.txn_assign(t.id, c.id, None, true).unwrap();
    let snapshot = h.core.backup_now().unwrap();
    h.clock.advance(Duration::seconds(5));

    // Changes after the backup.
    h.core
        .ledger_add_payout(
            c.id,
            PayoutInput {
                platform: None,
                network: None,
                destination: None,
                currency: "USD".into(),
                amount_text: "75".into(),
                entry_date: "2026-11-23".into(),
                method: PayoutMethod::Bank,
                reference: None,
                description: None,
                confirm_overdraw: None,
            },
        )
        .unwrap();
    h.customer("Later", 1000);
    assert_eq!(h.balance(c.id, "USD"), 0);

    let safety = h.core.backup_restore(std::path::Path::new(&snapshot.path)).unwrap();
    assert_eq!(h.balance(c.id, "USD"), 7500, "data from the backup");
    assert_eq!(h.core.customers_list(None, None).unwrap().len(), 1);
    // The pre-restore copy holds the newer data.
    let check = rusqlite::Connection::open(&safety.path).unwrap();
    let n: i64 = check.query_row("SELECT COUNT(*) FROM customers", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
    // Ledger triggers survive the restore.
    let conn = rusqlite::Connection::open(h.core.db_path()).unwrap();
    assert!(conn.execute("DELETE FROM ledger_entries", []).is_err());
}

#[test]
fn restore_rejects_foreign_or_broken_files() {
    let h = harness();
    let junk = h.dir.path().join("junk.db");
    std::fs::write(&junk, b"not a database at all, definitely not sqlite").unwrap();
    assert_eq!(code(h.core.backup_restore(&junk)), ErrorCode::RestoreFailed);
    let other = h.dir.path().join("other.db");
    rusqlite::Connection::open(&other).unwrap().execute_batch("CREATE TABLE x (a INTEGER);").unwrap();
    assert_eq!(code(h.core.backup_restore(&other)), ErrorCode::RestoreFailed);
    assert_eq!(code(h.core.backup_restore(&h.dir.path().join("missing.db"))), ErrorCode::RestoreFailed);
}

#[test]
fn backup_on_close_when_enabled() {
    let h = harness();
    set_backup_dir(&h, 30);
    assert!(h.core.backup_on_close().unwrap().is_some());
    h.core.update_settings(SettingsPatch { backup_on_close: Some(false), ..Default::default() }).unwrap();
    assert!(h.core.backup_on_close().unwrap().is_none());
}

#[test]
fn lock_flow() {
    let h = harness();
    let st = h.core.app_status().unwrap();
    assert!(!st.lock_enabled && !st.locked && !st.onboarding_done);
    assert_eq!(code(h.core.set_lock_password(None, Some("12"))), ErrorCode::Validation);
    h.core.set_lock_password(None, Some("سر-1234")).unwrap();
    assert!(h.core.app_status().unwrap().lock_enabled);
    assert!(!h.core.app_status().unwrap().locked, "setting the password does not lock immediately");

    h.core.lock().unwrap();
    assert_eq!(code(h.core.guard()), ErrorCode::Locked);
    assert_eq!(code(h.core.unlock("bad")), ErrorCode::WrongPassword);
    let st = h.core.unlock("سر-1234").unwrap();
    assert!(!st.locked);
    h.core.guard().unwrap();

    // Changing requires the current password.
    assert_eq!(code(h.core.set_lock_password(Some("bad"), Some("abcd"))), ErrorCode::WrongPassword);
    h.core.set_lock_password(Some("سر-1234"), Some("abcd")).unwrap();
    // Disabling.
    h.core.set_lock_password(Some("abcd"), None).unwrap();
    h.core.lock().unwrap();
    h.core.guard().unwrap();
    assert!(!h.core.app_status().unwrap().lock_enabled);
}

#[test]
fn five_wrong_attempts_wait_30_seconds() {
    let h = harness();
    h.core.set_lock_password(None, Some("1234")).unwrap();
    h.core.lock().unwrap();
    for _ in 0..4 {
        assert_eq!(code(h.core.unlock("x")), ErrorCode::WrongPassword);
    }
    assert_eq!(code(h.core.unlock("x")), ErrorCode::TooManyAttempts);
    assert!(h.core.app_status().unwrap().locked_until.is_some());
    assert_eq!(code(h.core.unlock("1234")), ErrorCode::TooManyAttempts, "even the right password waits");
    h.clock.advance(Duration::seconds(31));
    assert!(h.core.app_status().unwrap().locked_until.is_none());
    assert!(!h.core.unlock("1234").unwrap().locked);
}

#[test]
fn lock_survives_restart() {
    let h = harness();
    h.core.set_lock_password(None, Some("1234")).unwrap();
    let h2 = common::open_in(h.dir);
    assert!(h2.core.app_status().unwrap().locked, "a locked-enabled app starts locked");
    assert_eq!(code(h2.core.customers_list(None, None).and_then(|_| h2.core.guard())), ErrorCode::Locked);
}

#[test]
fn settings_validation_and_onboarding() {
    let h = harness();
    let s = h.core.get_settings().unwrap();
    assert_eq!((s.theme, s.default_commission_bps, s.backup_keep, s.backup_on_close), (Theme::System, 2500, 30, true));
    assert_eq!(
        code(h.core.update_settings(SettingsPatch { default_commission_bps: Some(10001), ..Default::default() })),
        ErrorCode::Validation
    );
    assert_eq!(
        code(h.core.update_settings(SettingsPatch { backup_keep: Some(0), ..Default::default() })),
        ErrorCode::Validation
    );
    assert_eq!(
        code(h.core.update_settings(SettingsPatch { auto_lock_minutes: Some(Some(0)), ..Default::default() })),
        ErrorCode::Validation
    );
    h.core.update_settings(SettingsPatch { onboarding_done: Some(true), ..Default::default() }).unwrap();
    assert!(h.core.app_status().unwrap().onboarding_done);
}

#[test]
fn dashboard_numbers() {
    let h = harness();
    let a = h.customer("Ali", 2500);
    let b = h.customer("Sara", 1000);
    let t1 = h.manual("USD", "100", Some("5")); // Ali: 71.25, commission 23.75
    h.core.txn_assign(t1.id, a.id, None, true).unwrap();
    let t2 = h.manual("USD", "200", Some("0")); // Sara: 180, commission 20
    h.core.txn_assign(t2.id, b.id, None, true).unwrap();
    let t3 = h.manual("USD", "30", None); // unassigned, needs fee
    let t4 = h.manual("EUR", "40", Some("1")); // pending
    h.core.txn_assign(t4.id, a.id, None, false).unwrap();
    let t5 = h.manual("USD", "999", Some("0"));
    h.core.txn_set_excluded(t5.id, true).unwrap();
    h.core
        .ledger_add_payout(
            b.id,
            PayoutInput {
                platform: None,
                network: None,
                destination: None,
                currency: "USD".into(),
                amount_text: "50".into(),
                entry_date: "2026-11-23".into(),
                method: PayoutMethod::Cash,
                reference: None,
                description: None,
                confirm_overdraw: None,
            },
        )
        .unwrap();
    let _ = t3;

    let d = h.core.dashboard_summary(&Period::default()).unwrap();
    assert_eq!(
        (d.counts.unassigned, d.counts.needs_fee, d.counts.pending_approval, d.counts.refund_alerts),
        (1, 1, 1, 0)
    );
    let usd = d.by_currency.iter().find(|c| c.currency == "USD").unwrap();
    assert_eq!(usd.gross_minor, 33000, "excluded payments are not counted");
    assert_eq!(usd.fee_minor, 500);
    assert_eq!(usd.commission_minor, 2375 + 2000);
    assert_eq!(usd.owed_to_customers_minor, 7125 + 18000 - 5000);
    assert_eq!(usd.paid_out_minor, 5000);
    let eur = d.by_currency.iter().find(|c| c.currency == "EUR").unwrap();
    assert_eq!((eur.gross_minor, eur.commission_minor), (4000, 0));
    let tops: Vec<_> = d.top_customers.iter().map(|t| (t.name.as_str(), t.balance.minor)).collect();
    assert_eq!(tops, vec![("Sara", 13000), ("Ali", 7125)]);

    // Period filter: nothing happened in October.
    let oct = Period { from: Some("2026-10-01".into()), to: Some("2026-10-31".into()) };
    let d = h.core.dashboard_summary(&oct).unwrap();
    let usd = d.by_currency.iter().find(|c| c.currency == "USD").unwrap();
    assert_eq!((usd.gross_minor, usd.commission_minor, usd.paid_out_minor), (0, 0, 0));
    assert_eq!(usd.owed_to_customers_minor, 20125, "balances ignore the period");
}
