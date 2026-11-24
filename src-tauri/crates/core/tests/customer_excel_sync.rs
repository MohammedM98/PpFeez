//! SPEC §6.8.3: the customer's Excel statement follows the program automatically.

mod common;

use calamine::{open_workbook, Data, Reader, Xlsx};
use common::{fixture, harness, open_in, Harness};
use ppfeez_core::error::{AppError, ErrorCode};
use ppfeez_core::excel::customer::ExcelStatus;
use ppfeez_core::excel::statement as stmt;
use ppfeez_core::ledger::{AdjustmentInput, Direction, PayoutInput, PayoutMethod};
use ppfeez_core::mail::mailboxes::MailboxInput;
use ppfeez_core::payouts::{CreateStatus, PayoutCreateInput, PayoutDetails, StatementFilter, StatementShow};
use ppfeez_core::transactions::{FeeInput, TxnFilter, TxnType};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

fn rows(path: &Path) -> Vec<Vec<Data>> {
    let mut wb: Xlsx<_> = open_workbook(path).unwrap();
    wb.worksheet_range("كشف USD")
        .unwrap()
        .rows()
        .filter(|r| r.get(stmt::C_KEY as usize).is_some_and(|k| matches!(k, Data::String(x) if x.contains(':'))))
        .map(|r| r.to_vec())
        .collect()
}

fn s(d: &Data) -> String {
    match d {
        Data::String(s) => s.clone(),
        Data::Empty => String::new(),
        o => format!("{o:?}"),
    }
}

fn keys(path: &Path) -> Vec<String> {
    rows(path).iter().map(|r| s(&r[stmt::C_KEY as usize])).collect()
}

fn col(path: &Path, key_prefix: &str, c: u16) -> Data {
    rows(path).into_iter().find(|r| s(&r[stmt::C_KEY as usize]).starts_with(key_prefix)).unwrap()[c as usize].clone()
}

/// Customer "Ali" (25%) with a linked, empty statement (automatic sync on).
fn linked(h: &Harness) -> (i64, PathBuf) {
    let c = h.customer("Ali", 2500);
    let path = h.dir.path().join("ali.xlsx");
    let created = h.core.customer_excel_create(c.id, &path.display().to_string(), false).unwrap();
    assert_eq!(created.added, 0);
    assert!(h.core.customer_excel_get(c.id).unwrap().unwrap().auto_sync, "on by default");
    (c.id, path)
}

fn approve(h: &Harness, customer: i64, gross: &str) -> i64 {
    let t = h.manual("USD", gross, Some("0"));
    h.core.txn_assign(t.id, customer, None, true).unwrap().id
}

fn sync(h: &Harness) -> (i64, i64, Option<ErrorCode>) {
    let ev = h.core.customer_excel_sync_due();
    (
        ev.iter().map(|e| e.added).sum(),
        ev.iter().map(|e| e.pending).sum(),
        ev.iter().find_map(|e| e.error.as_ref().map(|x| x.code)),
    )
}

fn details(reference: &str) -> PayoutDetails {
    PayoutDetails {
        method: PayoutMethod::Usdt,
        platform: Some("Binance".into()),
        network: Some("TRC20".into()),
        destination: None,
        reference: Some(reference.into()),
        note: None,
    }
}

fn pay(h: &Harness, customer: i64, txns: Vec<i64>, status: CreateStatus) -> i64 {
    h.core
        .payout_create(
            customer,
            PayoutCreateInput {
                currency: "USD".into(),
                txn_ids: txns,
                returned_entry_ids: vec![],
                amount_text: None,
                difference_reason: None,
                date: "2026-11-23".into(),
                details: details("0xfeed"),
                status,
                matched_confirmed: true,
            },
        )
        .unwrap()
        .id
}

fn counts(h: &Harness, customer: i64) -> (i64, i64, i64) {
    let l = h.core.customer_excel_get(customer).unwrap().unwrap();
    (l.exported_count, l.pending_count, l.not_exported_count)
}

#[test]
fn each_event_adds_its_row() {
    let h = harness();
    let (c, path) = linked(&h);

    // Approve: queued with the operation, written by the background pass.
    let t = approve(&h, c, "100");
    assert_eq!(h.core.txn_get(t).unwrap().excel_status, ExcelStatus::Pending);
    assert_eq!(counts(&h, c), (0, 1, 0));
    assert_eq!(sync(&h), (1, 0, None));
    assert_eq!(h.core.txn_get(t).unwrap().excel_status, ExcelStatus::Exported);
    assert_eq!(sync(&h), (0, 0, None), "nothing more to write");
    let tk = keys(&path)[0].clone();
    assert!(tk.starts_with("T:MANUAL-"));
    assert_eq!(col(&path, "T:", stmt::C_SEQ), Data::Float(1.0));
    assert_eq!(col(&path, "T:", stmt::C_CREDIT), Data::Float(75.0));

    // Adjustment and a payout without transfers.
    h.core
        .ledger_add_adjustment(
            c,
            AdjustmentInput {
                currency: "USD".into(),
                amount_text: "5".into(),
                direction: Direction::Credit,
                entry_date: "2026-11-23".into(),
                description: "تعويض".into(),
            },
        )
        .unwrap();
    let u = h
        .core
        .ledger_add_payout(
            c,
            PayoutInput {
                currency: "USD".into(),
                amount_text: "10".into(),
                entry_date: "2026-11-23".into(),
                method: PayoutMethod::Usdt,
                platform: Some("Binance".into()),
                network: None,
                destination: None,
                reference: None,
                description: None,
                confirm_overdraw: None,
            },
        )
        .unwrap();
    assert_eq!(u.excel_status, ExcelStatus::Pending);
    assert_eq!(sync(&h), (2, 0, None));
    assert_eq!(keys(&path)[1..].iter().map(|k| &k[..2]).collect::<Vec<_>>(), vec!["L:", "U:"]);

    // A draft payout is not exported until it is sent.
    let p = pay(&h, c, vec![t], CreateStatus::Draft);
    assert_eq!(sync(&h), (0, 0, None));
    assert_eq!(h.core.payouts_list(c, "USD").unwrap()[0].excel_status, ExcelStatus::NotExported);
    assert_eq!(counts(&h, c).2, 0, "a draft does not belong in the statement yet");
    h.core.payout_mark_sent(p, None).unwrap();
    assert_eq!(sync(&h), (1, 0, None));
    assert_eq!(s(&col(&path, &format!("P:{p}"), stmt::C_DEBIT)), "Float(75.0)");
    assert_eq!(s(&col(&path, "T:", stmt::C_SENT)), "نعم — دفعة 1", "its transfer is marked paid");

    // Details edited after sending: the payout's row is updated, no new row.
    h.core.payout_update_details(p, details("0xbeef")).unwrap();
    assert_eq!(h.core.payouts_list(c, "USD").unwrap()[0].excel_status, ExcelStatus::Pending);
    assert_eq!(sync(&h), (0, 0, None));
    assert_eq!(s(&col(&path, &format!("P:{p}"), stmt::C_REF)), "0xbeef");
    assert_eq!(keys(&path).len(), 4);

    // Cancelled: a reversal row; the payout row says cancelled and the transfer is unpaid again.
    h.core.payout_cancel(p, "خطأ في العنوان").unwrap();
    assert_eq!(sync(&h), (1, 0, None));
    assert!(keys(&path)[4].starts_with(&format!("-P:{p}:")));
    assert_eq!(col(&path, "-P:", stmt::C_CREDIT), Data::Float(75.0));
    assert_eq!(s(&col(&path, &format!("P:{p}"), stmt::C_SENT)), "ملغاة");
    assert_eq!(s(&col(&path, "T:", stmt::C_SENT)), "لا");

    // Unapproved after export: a reversal row that keeps the transfer's number and figures.
    h.core.txn_unapprove(t, "حوالة خاطئة").unwrap();
    assert_eq!(sync(&h), (1, 0, None));
    let last = rows(&path).pop().unwrap();
    assert_eq!(s(&last[stmt::C_LABEL as usize]), "إلغاء اعتماد الحوالة #1");
    assert!(s(&last[stmt::C_KEY as usize]).starts_with("-T:"));
    assert_eq!(last[stmt::C_DEBIT as usize], Data::Float(75.0));
    assert_eq!(last[stmt::C_NET as usize], Data::Float(100.0));
    assert_eq!(last[stmt::C_COMMISSION as usize], Data::Float(25.0));

    // Approved and unapproved before the writer ran: nothing to write.
    let t2 = approve(&h, c, "40");
    h.core.txn_unapprove(t2, "تجربة").unwrap();
    assert_eq!(sync(&h), (0, 0, None));
    assert_eq!(keys(&path).len(), 6);
    assert_eq!(counts(&h, c), (6, 0, 0));
    if let Ok(d) = std::env::var("DUMP_DIR") {
        std::fs::copy(&path, Path::new(&d).join("sync.xlsx")).unwrap();
    }
}

#[test]
fn a_refund_return_adds_its_row() {
    let h = harness();
    let (c, path) = linked(&h);
    let mb = h
        .core
        .mailbox_create(MailboxInput {
            label: "PayPal".into(),
            email: "owner@example.com".into(),
            host: None,
            port: None,
            folder: None,
            password: Some("pass".into()),
        })
        .unwrap();
    {
        let mut st = h.mail.0.lock().unwrap();
        st.messages.insert(100, fixture("payment_received_basic.eml"));
        st.messages.insert(101, fixture("refund_sent_partial.eml"));
    }
    let (run, cancel) = h.core.pull_start(mb.id, None).unwrap();
    h.core.pull_execute(run.id, &cancel, &|_| {});
    let f = TxnFilter { kind: Some(TxnType::Payment), ..Default::default() };
    let original = h.core.txn_list(&f, Default::default(), 1, 10).unwrap().items.remove(0);
    h.core.txn_set_fee(original.id, FeeInput::Fee { fee_text: "5".into() }).unwrap();
    h.core.txn_assign(original.id, c, None, true).unwrap();
    let alert = h.core.refund_alerts().unwrap().remove(0);
    let e = h.core.refund_confirm_reversal(alert.refund_txn.id, None).unwrap();
    assert_eq!(sync(&h), (2, 0, None));
    assert_eq!(keys(&path)[1], format!("R:{}", e.id));
    assert_eq!(col(&path, "R:", stmt::C_DEBIT), Data::Float(28.5));
}

#[test]
fn a_locked_file_keeps_the_line_pending_then_send_now_writes_it_once() {
    let h = harness();
    let (c, path) = linked(&h);
    h.core.debug_set_excel_fault(Some(AppError::new(ErrorCode::FileLocked, "أغلق الملف في Excel ثم أعد المحاولة")));
    let t = approve(&h, c, "100");
    // The operation itself is saved.
    assert_eq!(h.balance(c, "USD"), 7500);
    assert_eq!(sync(&h), (0, 1, Some(ErrorCode::FileLocked)));
    assert_eq!(h.core.txn_get(t).unwrap().excel_status, ExcelStatus::Pending);
    let link = h.core.customer_excel_get(c).unwrap().unwrap();
    assert_eq!((link.pending_count, link.last_error.map(|e| e.code)), (1, Some(ErrorCode::FileLocked)));
    assert_eq!(h.core.customer_excel_send_unexported(c, None).unwrap_err().code, ErrorCode::FileLocked);
    assert!(keys(&path).is_empty());

    // Closed in Excel: "send now" writes it once; the background pass has nothing left.
    h.core.debug_set_excel_fault(None);
    let r = h.core.customer_excel_send_unexported(c, None).unwrap();
    assert_eq!((r.added, r.skipped_duplicates, r.still_pending), (1, 0, 0));
    assert_eq!(sync(&h), (0, 0, None));
    assert_eq!(keys(&path).len(), 1);
    let link = h.core.customer_excel_get(c).unwrap().unwrap();
    assert_eq!((link.exported_count, link.pending_count, link.last_error), (1, 0, None));
}

#[test]
fn a_missing_file_keeps_lines_pending_and_restart_retries() {
    let h = harness();
    let (c, path) = linked(&h);
    let away = path.with_file_name("moved.xlsx");
    std::fs::rename(&path, &away).unwrap();
    approve(&h, c, "100");
    approve(&h, c, "20");
    assert_eq!(sync(&h), (0, 2, Some(ErrorCode::ExportFailed)));
    assert!(!h.core.customer_excel_get(c).unwrap().unwrap().exists);
    assert_eq!(sync(&h), (0, 0, None), "no busy retry loop; retried on the next event or at startup");

    // The program restarts with the file back in place.
    std::fs::rename(&away, &path).unwrap();
    let Harness { core, dir, .. } = h;
    drop(core);
    let h = open_in(dir);
    assert_eq!(sync(&h), (2, 0, None));
    let seqs: Vec<Data> = rows(&path).iter().map(|r| r[stmt::C_SEQ as usize].clone()).collect();
    assert_eq!(seqs, vec![Data::Float(1.0), Data::Float(2.0)], "in the order they happened");
}

#[test]
fn no_duplicates_after_a_partial_failure() {
    let h = harness();
    let (c, path) = linked(&h);
    approve(&h, c, "100");
    assert_eq!(sync(&h).0, 1);
    // The file was saved but the program stopped before recording it.
    let conn = Connection::open(h.core.db_path()).unwrap();
    conn.execute("UPDATE customer_excel_items SET status = 'pending'", []).unwrap();
    conn.execute("UPDATE customer_excel SET dirty = 1", []).unwrap();
    drop(conn);
    approve(&h, c, "20");
    let ev = h.core.customer_excel_sync_due();
    assert_eq!((ev[0].added, ev[0].pending), (1, 0));
    assert_eq!(keys(&path).len(), 2, "the first line is not written twice");
    assert_eq!(counts(&h, c), (2, 0, 0));
}

#[test]
fn counts_filter_and_send_unexported_in_statement_order() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    // Approved before the file existed, in this order: #1, #2, #3.
    let ids: Vec<i64> = ["10", "20", "30"].iter().map(|g| approve(&h, c.id, g)).collect();
    let path = h.dir.path().join("ali.xlsx");
    h.core.customer_excel_create(c.id, &path.display().to_string(), false).unwrap();
    assert_eq!(counts(&h, c.id), (0, 0, 3));
    let f = StatementFilter { show: Some(StatementShow::NotExported), ..Default::default() };
    assert_eq!(h.core.customer_statement(c.id, "USD", &f).unwrap().rows.len(), 3);
    assert_eq!(h.core.txn_get(ids[0]).unwrap().excel_status, ExcelStatus::NotExported);

    // Automatic sync off: a new approval is not queued.
    assert!(!h.core.customer_excel_set_auto(c.id, false).unwrap().auto_sync);
    approve(&h, c.id, "40");
    assert_eq!(sync(&h), (0, 0, None));
    assert_eq!(counts(&h, c.id), (0, 0, 4));
    let summary = h.core.customer_excel_unexported_summary().unwrap();
    assert_eq!(summary.len(), 1);
    assert_eq!((summary[0].customer_id, summary[0].not_exported), (c.id, 4));

    let r = h.core.customer_excel_send_unexported(c.id, None).unwrap();
    assert_eq!((r.added, r.still_pending), (4, 0));
    let seqs: Vec<Data> = rows(&path).iter().map(|r| r[stmt::C_SEQ as usize].clone()).collect();
    assert_eq!(seqs, [1.0, 2.0, 3.0, 4.0].map(Data::Float).to_vec());
    assert_eq!(counts(&h, c.id), (4, 0, 0));
    assert!(h.core.customer_statement(c.id, "USD", &f).unwrap().rows.is_empty());
    assert!(h.core.customer_excel_unexported_summary().unwrap().is_empty());
}

#[test]
fn summary_covers_several_customers() {
    let h = harness();
    let (a, a_path) = linked(&h);
    let b = h.customer("Sara", 2000);
    let b_path = h.dir.path().join("sara.xlsx");
    h.core.customer_excel_create(b.id, &b_path.display().to_string(), false).unwrap();
    let z = h.customer("Zaid", 2000);
    h.core.customer_excel_create(z.id, &h.dir.path().join("zaid.xlsx").display().to_string(), false).unwrap();
    approve(&h, a, "100");
    approve(&h, b.id, "50");
    approve(&h, z.id, "10");
    std::fs::remove_file(&b_path).unwrap();
    let mut ev = h.core.customer_excel_sync_due();
    ev.sort_by_key(|e| e.customer_id);
    assert_eq!(ev.len(), 3);
    assert_eq!((ev[0].added, ev[0].error.is_none()), (1, true));
    assert_eq!(
        (ev[1].added, ev[1].pending, ev[1].error.as_ref().map(|e| e.code)),
        (0, 1, Some(ErrorCode::ExportFailed))
    );
    assert_eq!(keys(&a_path).len(), 1);
    let summary = h.core.customer_excel_unexported_summary().unwrap();
    assert_eq!(summary.len(), 1, "only the customer with something missing");
    assert_eq!((summary[0].customer_name.as_str(), summary[0].pending), ("Sara", 1));
    assert_eq!(summary[0].last_error.as_ref().map(|e| e.code), Some(ErrorCode::ExportFailed));
}

#[test]
fn deleting_an_exported_transfer_writes_a_deletion_row() {
    let h = harness();
    let (c, path) = linked(&h);
    let t = approve(&h, c, "100");
    let pending = approve(&h, c, "20");
    assert_eq!(sync(&h).0, 2);
    let t3 = approve(&h, c, "8");
    h.core.txn_delete(&[t, t3], Some("مكررة")).unwrap();
    assert_eq!(sync(&h), (1, 0, None), "the unexported one simply goes away");
    let last = rows(&path).pop().unwrap();
    assert!(s(&last[stmt::C_KEY as usize]).starts_with("-T:") && s(&last[stmt::C_KEY as usize]).ends_with(":del"));
    assert_eq!(s(&last[stmt::C_LABEL as usize]), format!("حذف: {}", s(&rows(&path)[0][stmt::C_LABEL as usize])));
    assert_eq!(last[stmt::C_DEBIT as usize], Data::Float(75.0));
    assert_eq!(last[stmt::C_NET as usize], Data::Float(100.0));
    let _ = pending;

    // Unapproved (reversal exported) then deleted: line and reversal cancel out, nothing added.
    let t4 = approve(&h, c, "12");
    assert_eq!(sync(&h).0, 1);
    h.core.txn_unapprove(t4, "خطأ").unwrap();
    assert_eq!(sync(&h).0, 1);
    let before = keys(&path).len();
    h.core.txn_delete(&[t4], None).unwrap();
    assert_eq!(sync(&h), (0, 0, None));
    assert_eq!(keys(&path).len(), before);
}

#[test]
fn the_header_counts_reversal_rows() {
    let h = harness();
    let (c, path) = linked(&h);
    let t = approve(&h, c, "100");
    approve(&h, c, "20");
    sync(&h);
    h.core.txn_unapprove(t, "خطأ").unwrap();
    sync(&h);
    let mut wb: Xlsx<_> = open_workbook(&path).unwrap();
    let f = wb.worksheet_formula("كشف USD").unwrap();
    let all: Vec<String> = f.rows().flatten().filter(|x| !x.is_empty()).cloned().collect();
    assert!(all.iter().any(|x| x.contains("COUNTIFS(Statement_USD[مفتاح],\"-T:*\")")), "{all:?}");
}

/// A 0.5.0 database (schema 7) with a linked statement and lines added by hand.
#[test]
fn upgrade_from_0_5_0_tracking() {
    const V7: [&str; 7] = [
        include_str!("../src/db/migrations/0001_init.sql"),
        include_str!("../src/db/migrations/0002_pull_range.sql"),
        include_str!("../src/db/migrations/0003_review_hold.sql"),
        include_str!("../src/db/migrations/0004_ledger_delete_flow.sql"),
        include_str!("../src/db/migrations/0005_excel_exported.sql"),
        include_str!("../src/db/migrations/0006_payouts.sql"),
        include_str!("../src/db/migrations/0007_customer_excel.sql"),
    ];
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    let path = dir.path().join("owner.xlsx");
    {
        let conn = Connection::open(dir.path().join("data").join("ppfeez.db")).unwrap();
        for sql in V7 {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 7).unwrap();
        let now = "2026-11-20T10:00:00Z";
        conn.execute(
            "INSERT INTO customers (id, name, default_commission_bps, created_at, updated_at) VALUES (1, 'Owner Test', 2500, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO paypal_transactions (id, source, paypal_txn_id, type, payer_name, currency, gross_minor, fee_minor,
             net_minor, fee_is_estimated, occurred_at, status, customer_id, commission_mode, commission_bps, commission_minor,
             customer_amount_minor, assigned_at, approved_at, created_at, updated_at, customer_seq)
             VALUES (1, 'manual', 'OLD00000000000001', 'payment', 'Payer', 'USD', 10000, 0, 10000, 0, ?1, 'approved', 1,
                     'percent', 2500, 2500, 7500, ?1, ?1, ?1, ?1, 1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ledger_entries (id, customer_id, currency, type, amount_minor, paypal_transaction_id, description,
             entry_date, created_at) VALUES (1, 1, 'USD', 'credit', 7500, 1, 'اعتماد', '2026-11-20', ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ledger_entries (id, customer_id, currency, type, amount_minor, payout_method, description,
             entry_date, created_at) VALUES (2, 1, 'USD', 'payout', -1000, 'usdt', 'دفعة', '2026-11-21', ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO customer_excel (customer_id, file_path, updated_at, add_by_default) VALUES (1, ?1, ?2, 0)",
            params![path.display().to_string(), now],
        )
        .unwrap();
        for (kind, id) in [("txn", 1), ("ledger", 2)] {
            conn.execute(
                "INSERT INTO customer_excel_items (customer_id, file_path, item_kind, item_id, currency, added_at)
                 VALUES (1, ?1, ?2, ?3, 'USD', ?4)",
                params![path.display().to_string(), kind, id, now],
            )
            .unwrap();
        }
    }
    let h = open_in(dir);
    let conn = Connection::open(h.core.db_path()).unwrap();
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(version, 9);
    let lines: Vec<(String, String, Option<i64>)> = conn
        .prepare("SELECT line_key, status, source_id FROM customer_excel_items ORDER BY line_key")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        lines,
        vec![("T:OLD00000000000001".into(), "exported".into(), Some(1)), ("U:2".into(), "exported".into(), None)]
    );
    drop(conn);
    // The file is gone in this test, but the link and its state survive the upgrade.
    let link = h.core.customer_excel_get(1).unwrap().unwrap();
    assert!(link.auto_sync);
    assert_eq!((link.exported_count, link.pending_count, link.not_exported_count), (2, 0, 0));
    assert_eq!(h.core.txn_get(1).unwrap().excel_status, ExcelStatus::Exported);
}

#[test]
fn a_manual_add_is_written_in_statement_order_not_selection_order() {
    use ppfeez_core::excel::customer::{ItemKind, ItemRef};
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t1 = approve(&h, c.id, "10");
    let t2 = approve(&h, c.id, "20");
    let u = h
        .core
        .ledger_add_payout(
            c.id,
            PayoutInput {
                currency: "USD".into(),
                amount_text: "5".into(),
                entry_date: "2026-11-23".into(),
                method: PayoutMethod::Usdt,
                platform: None,
                network: None,
                destination: None,
                reference: None,
                description: None,
                confirm_overdraw: None,
            },
        )
        .unwrap();
    let t3 = approve(&h, c.id, "30");
    let path = h.dir.path().join("ali.xlsx");
    h.core.customer_excel_create(c.id, &path.display().to_string(), false).unwrap();
    let items = [
        ItemRef { kind: ItemKind::Txn, id: t3 },
        ItemRef { kind: ItemKind::Ledger, id: u.id },
        ItemRef { kind: ItemKind::Txn, id: t1 },
        ItemRef { kind: ItemKind::Txn, id: t2 },
    ];
    assert_eq!(h.core.customer_excel_add(c.id, &items, None).unwrap().added, 4);
    let written: Vec<String> = rows(&path).iter().map(|r| s(&r[stmt::C_SEQ as usize])).collect();
    assert_eq!(written, vec!["Float(1.0)", "Float(2.0)", "", "Float(3.0)"]);
    assert_eq!(keys(&path)[2], format!("U:{}", u.id));
}
