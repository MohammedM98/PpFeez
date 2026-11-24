//! Every DTO returned to the UI serializes with exactly the camelCase field names of
//! docs/UI-CONTRACT.md §3, and every input type accepts the contract's JSON shape.
//! One test per command group.

mod common;

use common::{fixture, harness};
use ppfeez_core::customers::CustomerInput;
use ppfeez_core::emails::ParseStatus;
use ppfeez_core::ledger::{AdjustmentInput, PayoutInput};
use ppfeez_core::mail::mailboxes::MailboxInput;
use ppfeez_core::settings::SettingsPatch;
use ppfeez_core::transactions::{BulkAction, CommissionInput, FeeInput, ManualTxnInput, Period, TxnFilter, TxnSort};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object().expect("object").keys().cloned().collect()
}

fn set(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[track_caller]
fn assert_keys<T: Serialize>(value: &T, expected: &[&str]) -> Value {
    let v = serde_json::to_value(value).unwrap();
    assert_eq!(keys(&v), set(expected), "fields of {v}");
    v
}

const TRANSACTION: &[&str] = &[
    "id",
    "source",
    "paypalTxnId",
    "relatedTxnId",
    "type",
    "payerName",
    "payerEmail",
    "payerNote",
    "currency",
    "grossMinor",
    "feeMinor",
    "netMinor",
    "feeIsEstimated",
    "occurredAt",
    "status",
    "customer",
    "commissionMode",
    "commissionBps",
    "commissionMinor",
    "customerAmountMinor",
    "assignedAt",
    "approvedAt",
    "note",
    "mailbox",
    "rawEmailId",
    "refundedBy",
    "allowedActions",
    "needsReview",
    "reviewReasonAr",
    "holdStatus",
];
const CUSTOMER: &[&str] =
    &["id", "name", "phone", "defaultCommissionBps", "notes", "isActive", "balances", "pendingCount", "createdAt"];
const LEDGER_ENTRY: &[&str] = &[
    "id",
    "customerId",
    "currency",
    "type",
    "amountMinor",
    "runningBalanceMinor",
    "transactionId",
    "reversesEntryId",
    "reversedByEntryId",
    "payoutMethod",
    "reference",
    "description",
    "entryDate",
    "createdAt",
    "deletable",
    "notDeletableReasonAr",
];
const PULL_RUN: &[&str] = &[
    "range",
    "id",
    "mailboxId",
    "mailboxLabel",
    "status",
    "totalCount",
    "fetchedCount",
    "newTransactionsCount",
    "duplicateCount",
    "ignoredCount",
    "failedCount",
    "error",
    "startedAt",
    "finishedAt",
];
const EMAIL_SUMMARY: &[&str] = &[
    "id",
    "mailboxLabel",
    "fromAddr",
    "subject",
    "receivedAt",
    "parseStatus",
    "parseReason",
    "parseReasonAr",
    "transactionId",
];

#[test]
fn app_and_settings_group() {
    let h = harness();
    let st =
        assert_keys(&h.core.app_status().unwrap(), &["version", "locked", "lockEnabled", "onboardingDone", "dataDir"]);
    assert_eq!(st["locked"], json!(false));
    let s = assert_keys(
        &h.core.get_settings().unwrap(),
        &[
            "theme",
            "defaultCommissionBps",
            "feeEstimateEnabled",
            "feeEstimateBps",
            "feeEstimateFixedMinor",
            "backupDir",
            "backupOnClose",
            "backupKeep",
            "autoLockMinutes",
            "onboardingDone",
            "excelExportPath",
            "excelLastExportedAt",
            "excelUpdateOnClose",
            "autoCheckUpdates",
            "extraPaypalDomains",
            "builtinPaypalDomains",
        ],
    );
    assert_eq!(s["theme"], json!("system"));
    assert_eq!(s["autoCheckUpdates"], json!(true), "SPEC 6.9: on by default");
    assert_eq!(s["backupDir"], Value::Null);

    // Partial<Settings> patch, with explicit nulls.
    let patch: SettingsPatch = serde_json::from_value(json!({
        "theme": "dark", "defaultCommissionBps": 2000, "backupDir": "C:\\backups", "autoLockMinutes": 10
    }))
    .unwrap();
    let s = serde_json::to_value(h.core.update_settings(patch).unwrap()).unwrap();
    assert_eq!((s["theme"].clone(), s["autoLockMinutes"].clone()), (json!("dark"), json!(10)));
    let patch: SettingsPatch = serde_json::from_value(json!({ "backupDir": null, "autoLockMinutes": null })).unwrap();
    let s = serde_json::to_value(h.core.update_settings(patch).unwrap()).unwrap();
    assert_eq!(
        (s["backupDir"].clone(), s["autoLockMinutes"].clone(), s["theme"].clone()),
        (Value::Null, Value::Null, json!("dark"))
    );

    // lockedUntil appears only after too many attempts; error shape.
    h.core.set_lock_password(None, Some("1234")).unwrap();
    h.core.lock().unwrap();
    let err = h.core.unlock("bad").unwrap_err();
    let e = assert_keys(&err, &["code", "messageAr", "field"]);
    assert_eq!(e["code"], json!("wrong_password"));
    for _ in 0..4 {
        let _ = h.core.unlock("bad");
    }
    let st = assert_keys(
        &h.core.app_status().unwrap(),
        &["version", "locked", "lockEnabled", "onboardingDone", "dataDir", "lockedUntil"],
    );
    assert_eq!(st["locked"], json!(true));
    let e = serde_json::to_value(h.core.guard().unwrap_err()).unwrap();
    assert_eq!(keys(&e), set(&["code", "messageAr"]));
    assert_eq!(e["code"], json!("locked"));
}

#[test]
fn customers_group() {
    let h = harness();
    let input: CustomerInput = serde_json::from_value(json!({ "name": "أحمد", "defaultCommissionBps": 2500 })).unwrap();
    let c = h.core.customer_create(input).unwrap();
    let v = assert_keys(&c, CUSTOMER);
    assert_eq!(v["balances"], json!([]));
    let input: CustomerInput = serde_json::from_value(
        json!({ "name": "أحمد", "phone": null, "defaultCommissionBps": 2000, "notes": "x", "isActive": true }),
    )
    .unwrap();
    let dup = h.core.customer_create(input).unwrap_err();
    assert_eq!(serde_json::to_value(&dup).unwrap()["field"], json!("name"));
    assert_eq!(serde_json::to_value(&dup).unwrap()["code"], json!("duplicate"));

    let t = h.manual("USD", "10", Some("0"));
    h.core.txn_assign(t.id, c.id, None, true).unwrap();
    let list = h.core.customers_list(None, Some(true)).unwrap();
    let v = assert_keys(&list[0], CUSTOMER);
    assert_eq!(v["balances"], json!([{ "minor": 750, "currency": "USD" }]));
}

#[test]
fn transactions_group() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let input: ManualTxnInput = serde_json::from_value(json!({
        "occurredAt": "2026-11-20 10:30", "currency": "USD", "grossText": "100.00", "feeText": "",
        "payerName": "John", "payerEmail": "j@example.com", "payerNote": "n", "note": "m"
    }))
    .unwrap();
    let t = h.core.txn_create_manual(input).unwrap();
    let v = assert_keys(&t, TRANSACTION);
    assert_eq!(v["type"], json!("payment"));
    assert_eq!(v["status"], json!("unassigned"));
    assert_eq!(v["feeMinor"], Value::Null);
    assert_eq!(v["allowedActions"], json!(["assign", "set_fee", "exclude", "edit_details", "edit_note", "delete"]));

    // FeeInput / CommissionInput tagged unions.
    for fee in
        [json!({ "kind": "fee", "feeText": "5" }), json!({ "kind": "net", "netText": "95" }), json!({ "kind": "zero" })]
    {
        let f: FeeInput = serde_json::from_value(fee).unwrap();
        h.core.txn_set_fee(t.id, f).unwrap();
    }
    let _: FeeInput = serde_json::from_value(json!({ "kind": "accept_estimate" })).unwrap();
    let pct: CommissionInput = serde_json::from_value(json!({ "mode": "percent", "bps": 2000 })).unwrap();
    let fixed: CommissionInput = serde_json::from_value(json!({ "mode": "fixed", "amountText": "3.50" })).unwrap();

    let p = h.core.txn_preview(t.id, None, Some(fixed), Some(c.id)).unwrap();
    assert_keys(&p, &["feeMinor", "netMinor", "commissionMinor", "customerAmountMinor", "feeEstimateMinor"]);
    let p = h.core.txn_preview(t.id, None, Some(CommissionInput::Fixed { amount_text: "999".into() }), None).unwrap();
    let pv = assert_keys(
        &p,
        &["feeMinor", "netMinor", "commissionMinor", "customerAmountMinor", "feeEstimateMinor", "error"],
    );
    assert_eq!(pv["error"]["code"], json!("commission_exceeds_net"));

    let t = h.core.txn_assign(t.id, c.id, Some(pct), false).unwrap();
    let v = assert_keys(&t, TRANSACTION);
    assert_eq!(v["customer"], json!({ "id": c.id, "name": "Ali" }));
    assert_eq!(v["commissionMode"], json!("percent"));
    assert_eq!(v["status"], json!("pending_approval"));

    let filter: TxnFilter = serde_json::from_value(json!({
        "status": "all", "search": "john", "currency": "USD", "needsFeeOnly": false, "type": "payment",
        "period": { "from": "2026-11-01", "to": "2026-11-30" }
    }))
    .unwrap();
    let sort: TxnSort = serde_json::from_value(json!({ "key": "customerAmountMinor", "dir": "asc" })).unwrap();
    let list = h.core.txn_list(&filter, sort, 1, 50).unwrap();
    let lv = assert_keys(&list, &["items", "total", "page", "pageSize", "totals"]);
    assert_eq!(
        keys(&lv["totals"][0]),
        set(&["currency", "grossMinor", "feeMinor", "netMinor", "customerAmountMinor", "count"])
    );
    let f2: TxnFilter = serde_json::from_value(json!({ "status": "pending_approval" })).unwrap();
    assert_eq!(h.core.txn_list(&f2, TxnSort::default(), 1, 50).unwrap().total, 1);

    let counts = h.core.txn_counts(&TxnFilter::default()).unwrap();
    assert_keys(&counts, &["all", "unassigned", "pending_approval", "approved", "excluded", "needsFee", "needsReview"]);

    let hist = h.core.txn_history(t.id).unwrap();
    assert_keys(&hist[0], &["id", "action", "labelAr", "details", "createdAt"]);

    let action: BulkAction = serde_json::from_value(json!("approve")).unwrap();
    let r = h.core.txn_bulk(action, &[t.id, 12345], None, None).unwrap();
    let rv = assert_keys(&r, &["ok", "failed"]);
    assert_eq!(keys(&rv["failed"][0]), set(&["id", "code", "messageAr"]));
}

#[test]
fn ledger_group() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100", Some("0"));
    h.core.txn_assign(t.id, c.id, None, true).unwrap();
    let balances = h.core.ledger_balances(c.id).unwrap();
    assert_keys(&balances[0], &["currency", "creditsMinor", "debitsMinor", "balanceMinor"]);

    let payout: PayoutInput = serde_json::from_value(json!({
        "currency": "USD", "amountText": "10", "entryDate": "2026-11-23", "method": "usdt", "reference": "TX1"
    }))
    .unwrap();
    let e = h.core.ledger_add_payout(c.id, payout).unwrap();
    let ev = assert_keys(&e, LEDGER_ENTRY);
    assert_eq!((ev["type"].clone(), ev["payoutMethod"].clone()), (json!("payout"), json!("usdt")));

    let over: PayoutInput = serde_json::from_value(json!({
        "currency": "USD", "amountText": "1000", "entryDate": "2026-11-23", "method": "cash"
    }))
    .unwrap();
    let err = serde_json::to_value(h.core.ledger_add_payout(c.id, over).unwrap_err()).unwrap();
    assert_eq!((err["code"].clone(), err["field"].clone()), (json!("validation"), json!("overdraw")));

    let adj: AdjustmentInput = serde_json::from_value(json!({
        "currency": "USD", "amountText": "5", "direction": "debit", "entryDate": "2026-11-23", "description": "خصم"
    }))
    .unwrap();
    h.core.ledger_add_adjustment(c.id, adj).unwrap();

    let period: Period = serde_json::from_value(json!({ "from": "2026-11-01" })).unwrap();
    let view = h.core.ledger_entries(c.id, "USD", Some(&period)).unwrap();
    let vv = assert_keys(&view, &["openingBalanceMinor", "entries", "closingBalanceMinor"]);
    assert_eq!(keys(&vv["entries"][0]), set(LEDGER_ENTRY));
    let st = h.core.ledger_statement(c.id, "USD", None).unwrap();
    let sv = assert_keys(&st, &["customer", "view", "generatedAt"]);
    assert_eq!(keys(&sv["customer"]), set(CUSTOMER));
    assert!(h.core.refund_alerts().unwrap().is_empty());
}

#[test]
fn mail_and_emails_group() {
    let h = harness();
    let input: MailboxInput = serde_json::from_value(json!({
        "label": "حساب PayPal الأول", "email": "Owner@Example.com", "password": "abcd efgh ijkl mnop"
    }))
    .unwrap();
    let mb = h.core.mailbox_create(input).unwrap();
    let mv = assert_keys(
        &mb,
        &[
            "id",
            "label",
            "email",
            "host",
            "port",
            "folder",
            "isActive",
            "hasPassword",
            "lastPulledAt",
            "lastUid",
            "running",
        ],
    );
    assert_eq!((mv["email"].clone(), mv["hasPassword"].clone()), (json!("owner@example.com"), json!(true)));
    assert_eq!(mv["folder"], json!("[Gmail]/All Mail"));

    let test = h.core.mailbox_test(Some(mb.id), None).unwrap();
    assert_eq!(serde_json::to_value(&test).unwrap(), json!({ "ok": true, "folderCount": 7 }));

    {
        let mut s = h.mail.0.lock().unwrap();
        s.messages.insert(10, fixture("payment_received_basic.eml"));
        s.messages.insert(11, fixture("refund_sent_partial.eml"));
        s.messages.insert(12, fixture("payment_missing_txn_id.eml"));
    }
    let (run, cancel) = h.core.pull_start(mb.id, None).unwrap();
    let rv = assert_keys(&run, PULL_RUN);
    assert_eq!(rv["status"], json!("running"));
    assert_eq!(rv["range"], json!({ "kind": "new" }), "pull_start without range = new");
    let done = h.core.pull_execute(run.id, &cancel, &|_| {});
    assert_eq!(serde_json::to_value(&done).unwrap()["status"], json!("done"));
    assert_keys(&h.core.pull_runs_list(10).unwrap()[0], PULL_RUN);

    let page = h.core.emails_list(ParseStatus::Parsed, None, 1, 50).unwrap();
    let pv = assert_keys(&page, &["items", "total", "page", "pageSize"]);
    assert_eq!(keys(&pv["items"][0]), set(EMAIL_SUMMARY));
    let failed = h.core.emails_list(ParseStatus::Failed, None, 1, 50).unwrap();
    let mut full: Vec<&str> = EMAIL_SUMMARY.to_vec();
    full.extend(["bodyHtml", "bodyText", "parserName"]);
    let ev = assert_keys(&h.core.email_get(failed.items[0].id).unwrap(), &full);
    assert_eq!(ev["parseStatus"], json!("failed"));
    let r = h.core.email_reparse(&[failed.items[0].id]).unwrap();
    assert_keys(&r, &["ok", "failed"]);

    // Refund alert once the original payment is approved.
    let c = h.customer("John's owner", 2500);
    let payment = h
        .core
        .txn_list(
            &serde_json::from_value(json!({ "search": "9AB12345CD6789012", "type": "payment" })).unwrap(),
            Default::default(),
            1,
            5,
        )
        .unwrap()
        .items
        .remove(0);
    let tv = assert_keys(&payment, TRANSACTION);
    assert_eq!(tv["refundedBy"][0]["type"], json!("refund"));
    assert_eq!(keys(&tv["refundedBy"][0]), set(&["id", "type", "grossMinor"]));
    assert_eq!(tv["mailbox"], json!({ "id": mb.id, "label": "حساب PayPal الأول" }));
    h.core.txn_set_fee(payment.id, FeeInput::Zero).unwrap();
    h.core.txn_assign(payment.id, c.id, None, true).unwrap();
    let alerts = h.core.refund_alerts().unwrap();
    let av = assert_keys(&alerts[0], &["refundTxn", "originalTxn", "suggestedReversalMinor", "customer"]);
    assert_eq!(keys(&av["refundTxn"]), set(TRANSACTION));
    assert_eq!(av["suggestedReversalMinor"], json!(-3000));
}

#[test]
fn dashboard_and_backup_group() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100", Some("5"));
    h.core.txn_assign(t.id, c.id, None, true).unwrap();
    let period: Period = serde_json::from_value(json!({})).unwrap();
    let d = h.core.dashboard_summary(&period).unwrap();
    let dv = assert_keys(&d, &["counts", "byCurrency", "topCustomers", "lastPull"]);
    assert_eq!(
        keys(&dv["counts"]),
        set(&["unassigned", "needsFee", "pendingApproval", "refundAlerts", "needsReview", "unknownPaypalDomains"])
    );
    assert_eq!(
        keys(&dv["byCurrency"][0]),
        set(&["currency", "grossMinor", "feeMinor", "commissionMinor", "owedToCustomersMinor", "paidOutMinor"])
    );
    assert_eq!(
        dv["topCustomers"][0],
        json!({ "customerId": c.id, "name": "Ali", "balance": { "minor": 7125, "currency": "USD" } })
    );

    let dir = h.dir.path().join("backups");
    h.core
        .update_settings(SettingsPatch { backup_dir: Some(Some(dir.display().to_string())), ..Default::default() })
        .unwrap();
    let b = h.core.backup_now().unwrap();
    assert_keys(&b, &["path", "createdAt", "sizeBytes"]);
    assert_keys(&h.core.backup_list().unwrap()[0], &["path", "createdAt", "sizeBytes"]);
}

#[test]
fn excel_group() {
    let h = harness();
    let path = h.dir.path().join("PpFeez.xlsx");
    let st = serde_json::to_value(h.core.excel_set_path(&path.display().to_string()).unwrap()).unwrap();
    assert_eq!(st["excelExportPath"], json!(path.display().to_string()));
    assert_eq!(st["excelUpdateOnClose"], json!(true));
    let r = h.core.excel_update().unwrap();
    let v = assert_keys(&r, &["path", "sheets", "rows", "exportedAt"]);
    assert_eq!(v["sheets"], json!(4));
    let filter: TxnFilter = serde_json::from_value(json!({ "status": "all" })).unwrap();
    let sort: TxnSort = serde_json::from_value(json!({ "key": "occurredAt", "dir": "desc" })).unwrap();
    let q = h.dir.path().join("q.xlsx");
    assert_keys(
        &h.core.excel_export_transactions(&filter, sort, &q).unwrap(),
        &["path", "sheets", "rows", "exportedAt"],
    );
    let patch: SettingsPatch =
        serde_json::from_value(json!({ "excelExportPath": null, "excelUpdateOnClose": false })).unwrap();
    h.core.update_settings(patch).unwrap();
    let e = serde_json::to_value(h.core.excel_update().unwrap_err()).unwrap();
    assert_eq!(e["code"], json!("no_export_path"));
    let locked = serde_json::to_value(
        ppfeez_core::excel::save_atomic_with(b"x", &path, |_, _| Err(std::io::Error::from_raw_os_error(32)))
            .unwrap_err(),
    )
    .unwrap();
    assert_eq!(locked["code"], json!("file_locked"));
}

#[test]
fn pull_range_shapes() {
    use ppfeez_core::mail::pull::PullRange;
    for v in [
        json!({ "kind": "new" }),
        json!({ "kind": "last_days", "days": 30 }),
        json!({ "kind": "between", "from": "2026-01-01", "to": "2026-03-31" }),
        json!({ "kind": "all" }),
    ] {
        let r: PullRange = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(serde_json::to_value(&r).unwrap(), v);
    }
    let h = harness();
    let mb = h
        .core
        .mailbox_create(
            serde_json::from_value(json!({ "label": "x", "email": "x@example.com", "password": "p" })).unwrap(),
        )
        .unwrap();
    let range: PullRange =
        serde_json::from_value(json!({ "kind": "between", "from": "2026-12-01", "to": "2026-12-31" })).unwrap();
    let e = serde_json::to_value(h.core.pull_start(mb.id, Some(range)).unwrap_err()).unwrap();
    assert_eq!((e["code"].clone(), e["field"].clone()), (json!("invalid_range"), json!("range")));
    let (run, _) = h
        .core
        .pull_start(mb.id, Some(serde_json::from_value(json!({ "kind": "last_days", "days": 30 })).unwrap()))
        .unwrap();
    assert_eq!(serde_json::to_value(&run).unwrap()["range"], json!({ "kind": "last_days", "days": 30 }));
}

#[test]
fn deletion_group() {
    use ppfeez_core::deletion::ResetScope;
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "10", Some("0"));
    h.core.txn_assign(t.id, c.id, None, true).unwrap();
    let p = h.core.txn_delete_preview(&[t.id]).unwrap();
    let pv = assert_keys(&p, &["count", "approvedCount", "ledgerEntryCount", "effects"]);
    assert_eq!(keys(&pv["effects"][0]), set(&["customerId", "customerName", "currency", "balanceDeltaMinor"]));
    assert_keys(
        &h.core.customer_delete_preview(c.id).unwrap(),
        &["assignedCount", "approvedCount", "ledgerEntryCount", "balances"],
    );
    let scope: ResetScope = serde_json::from_value(
        json!({ "transactions": true, "customers": false, "mailboxes": false, "settings": false }),
    )
    .unwrap();
    assert_keys(
        &h.core.data_reset_preview(scope).unwrap(),
        &["transactions", "rawEmails", "pullRuns", "customers", "ledgerEntries", "mailboxes", "notes"],
    );
    let e = serde_json::to_value(h.core.customer_delete(c.id, "x").unwrap_err()).unwrap();
    assert_eq!(e["code"], json!("confirm_mismatch"));
    let r = h.core.txn_delete(&[t.id], None).unwrap();
    assert_keys(&r, &["ok", "failed", "backup"]);
    let payout: ppfeez_core::ledger::PayoutInput = serde_json::from_value(
        json!({ "currency": "USD", "amountText": "1", "entryDate": "2026-11-23", "method": "cash", "confirmOverdraw": true }),
    )
    .unwrap();
    let entry = h.core.ledger_add_payout(c.id, payout).unwrap();
    let lv = assert_keys(
        &h.core.ledger_delete_preview(entry.id).unwrap(),
        &["entries", "balanceBeforeMinor", "balanceAfterMinor"],
    );
    assert_eq!(keys(&lv["entries"][0]), set(LEDGER_ENTRY));
    assert_keys(&h.core.ledger_delete_entry(entry.id, None).unwrap(), &["backup"]);
    assert_keys(&h.core.data_reset(scope, "حذف").unwrap(), &["backup"]);
}
