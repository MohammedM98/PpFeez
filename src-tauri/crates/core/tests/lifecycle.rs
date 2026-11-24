mod common;

use common::{code, harness};
use ppfeez_core::commission::CommissionMode;
use ppfeez_core::customers::CustomerInput;
use ppfeez_core::error::ErrorCode;
use ppfeez_core::settings::SettingsPatch;
use ppfeez_core::transactions::{
    BulkAction, CommissionInput, FeeInput, ManualTxnInput, SortDir, StatusFilter, TxnAction, TxnFilter, TxnSort,
    TxnSortKey, TxnStatus,
};

#[test]
fn manual_entry_defaults() {
    let h = harness();
    let t = h.manual("usd", "100.00", None);
    assert!(t.paypal_txn_id.starts_with("MANUAL-"));
    assert_eq!(t.currency, "USD");
    assert_eq!(t.gross_minor, 10000);
    assert_eq!(t.fee_minor, None);
    assert_eq!(t.status, TxnStatus::Unassigned);
    // 10:30 local (UTC+3) → 07:30Z
    assert_eq!(t.occurred_at, "2026-11-20T07:30:00Z");
    assert_eq!(
        t.allowed_actions,
        vec![
            TxnAction::Assign,
            TxnAction::SetFee,
            TxnAction::Exclude,
            TxnAction::EditDetails,
            TxnAction::EditNote,
            TxnAction::Delete
        ]
    );

    let dup = h.core.txn_create_manual(ManualTxnInput {
        occurred_at: "2026-11-20 10:30".into(),
        payer_name: None,
        payer_email: None,
        payer_note: None,
        currency: "USD".into(),
        gross_text: "5".into(),
        fee_text: None,
        paypal_txn_id: Some(t.paypal_txn_id.clone()),
        note: None,
        raw_email_id: None,
    });
    let e = dup.unwrap_err();
    assert_eq!((e.code, e.field.as_deref()), (ErrorCode::Duplicate, Some("paypalTxnId")));
}

#[test]
fn manual_entry_validation() {
    let h = harness();
    let base = || ManualTxnInput {
        occurred_at: "2026-11-20 10:30".into(),
        payer_name: None,
        payer_email: None,
        payer_note: None,
        currency: "USD".into(),
        gross_text: "10".into(),
        fee_text: None,
        paypal_txn_id: None,
        note: None,
        raw_email_id: None,
    };
    let e = h.core.txn_create_manual(ManualTxnInput { gross_text: "abc".into(), ..base() }).unwrap_err();
    assert_eq!((e.code, e.field.as_deref()), (ErrorCode::InvalidAmount, Some("grossText")));
    let e = h.core.txn_create_manual(ManualTxnInput { gross_text: "0".into(), ..base() }).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidAmount);
    let e = h.core.txn_create_manual(ManualTxnInput { fee_text: Some("11".into()), ..base() }).unwrap_err();
    assert_eq!(e.field.as_deref(), Some("feeText"));
    let e = h.core.txn_create_manual(ManualTxnInput { currency: "US".into(), ..base() }).unwrap_err();
    assert_eq!(e.field.as_deref(), Some("currency"));
    let e = h.core.txn_create_manual(ManualTxnInput { occurred_at: "yesterday".into(), ..base() }).unwrap_err();
    assert_eq!(e.field.as_deref(), Some("occurredAt"));
}

#[test]
fn full_happy_path_assign_fee_approve() {
    let h = harness();
    let ahmed = h.customer("أحمد", 2500);
    let t = h.manual("USD", "100.00", None);

    let t = h.core.txn_assign(t.id, ahmed.id, None, false).unwrap();
    assert_eq!(t.status, TxnStatus::PendingApproval);
    assert_eq!(t.commission_mode, Some(CommissionMode::Percent));
    assert_eq!(t.commission_bps, Some(2500));
    assert_eq!(t.customer_amount_minor, None, "no fee yet");
    assert!(!t.allowed_actions.contains(&TxnAction::Approve));

    assert_eq!(code(h.core.txn_approve(t.id)), ErrorCode::FeeRequired);

    let t = h.set_fee(t.id, "5.00");
    assert_eq!((t.net_minor, t.commission_minor, t.customer_amount_minor), (Some(9500), Some(2375), Some(7125)));
    assert!(!t.fee_is_estimated);
    assert!(t.allowed_actions.contains(&TxnAction::Approve));

    let t = h.core.txn_approve(t.id).unwrap();
    assert_eq!(t.status, TxnStatus::Approved);
    assert_eq!(t.allowed_actions, vec![TxnAction::Unapprove, TxnAction::EditNote, TxnAction::Delete]);
    assert_eq!(h.balance(ahmed.id, "USD"), 7125);

    let view = h.core.ledger_entries(ahmed.id, "USD", None).unwrap();
    assert_eq!(view.entries.len(), 1, "exactly one credit");
    let e = &view.entries[0];
    assert_eq!(e.amount_minor, 7125);
    assert_eq!(e.entry_date, "2026-11-23");
    assert_eq!(e.transaction_id, Some(t.id));
    assert_eq!(
        e.description,
        "دفعة من John Doe — أصلي \u{2066}100.00 USD\u{2069}، رسوم \u{2066}5.00 USD\u{2069}، عمولة \u{2066}25.00%\u{2069}"
    );
    // Every number in the Arabic sentence is wrapped in LRI…PDI so "%" stays after the number in RTL.
    assert_eq!(e.description.matches('\u{2066}').count(), 3);
    assert_eq!(e.description.matches('\u{2069}').count(), 3);

    let history = h.core.txn_history(t.id).unwrap();
    let actions: Vec<_> = history.iter().map(|i| i.action.as_str()).collect();
    assert_eq!(actions, vec!["txn.create", "txn.assign", "txn.fee_set", "txn.approve"]);
}

#[test]
fn assign_with_override_and_direct_approval() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100.00", Some("5.00"));
    let t = h.core.txn_assign(t.id, c.id, Some(CommissionInput::Fixed { amount_text: "10".into() }), true).unwrap();
    assert_eq!(t.status, TxnStatus::Approved);
    assert_eq!(t.commission_mode, Some(CommissionMode::Fixed));
    assert_eq!(t.customer_amount_minor, Some(8500));
    assert_eq!(h.balance(c.id, "USD"), 8500);
}

#[test]
fn direct_approval_without_fee_rolls_back_the_assignment() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100.00", None);
    assert_eq!(code(h.core.txn_assign(t.id, c.id, None, true)), ErrorCode::FeeRequired);
    assert_eq!(h.core.txn_get(t.id).unwrap().status, TxnStatus::Unassigned);
}

#[test]
fn fee_and_net_inputs() {
    let h = harness();
    let t = h.manual("USD", "100.00", None);
    let t = h.core.txn_set_fee(t.id, FeeInput::Net { net_text: "96.20".into() }).unwrap();
    assert_eq!((t.fee_minor, t.net_minor), (Some(380), Some(9620)));
    let t = h.core.txn_set_fee(t.id, FeeInput::Zero).unwrap();
    assert_eq!((t.fee_minor, t.net_minor), (Some(0), Some(10000)));
    assert_eq!(code(h.core.txn_set_fee(t.id, FeeInput::Fee { fee_text: "100.01".into() })), ErrorCode::Validation);
    assert_eq!(code(h.core.txn_set_fee(t.id, FeeInput::Net { net_text: "100.01".into() })), ErrorCode::Validation);
    assert_eq!(code(h.core.txn_set_fee(t.id, FeeInput::Fee { fee_text: "x".into() })), ErrorCode::InvalidAmount);
    // Estimate is disabled by default.
    assert_eq!(code(h.core.txn_set_fee(t.id, FeeInput::AcceptEstimate)), ErrorCode::Validation);
}

#[test]
fn fee_estimate_is_suggested_and_saved_only_on_confirmation() {
    let h = harness();
    h.core.update_settings(SettingsPatch { fee_estimate_enabled: Some(true), ..Default::default() }).unwrap();
    let t = h.manual("USD", "100.00", None);
    let p = h.core.txn_preview(t.id, None, None, None).unwrap();
    assert_eq!(p.fee_estimate_minor, Some(470));
    assert_eq!(h.core.txn_get(t.id).unwrap().fee_minor, None, "preview never saves");
    let t = h.core.txn_set_fee(t.id, FeeInput::AcceptEstimate).unwrap();
    assert_eq!(t.fee_minor, Some(470));
    assert!(t.fee_is_estimated);
    let t = h.set_fee(t.id, "4.00");
    assert!(!t.fee_is_estimated);
}

#[test]
fn preview_does_not_save_and_reports_errors() {
    let h = harness();
    let c = h.customer("Ali", 2000);
    let t = h.manual("USD", "100.00", Some("5"));
    let p = h.core.txn_preview(t.id, None, None, Some(c.id)).unwrap();
    assert_eq!((p.net_minor, p.commission_minor, p.customer_amount_minor), (Some(9500), Some(1900), Some(7600)));
    let p = h.core.txn_preview(t.id, None, Some(CommissionInput::Fixed { amount_text: "96".into() }), None).unwrap();
    assert_eq!(p.error.map(|e| e.code), Some(ErrorCode::CommissionExceedsNet));
    let p = h
        .core
        .txn_preview(
            t.id,
            Some(FeeInput::Fee { fee_text: "10".into() }),
            Some(CommissionInput::Percent { bps: 1000 }),
            None,
        )
        .unwrap();
    assert_eq!(p.customer_amount_minor, Some(8100));
    let p = h.core.txn_preview(t.id, Some(FeeInput::Net { net_text: "96.20".into() }), None, None).unwrap();
    assert_eq!((p.fee_minor, p.net_minor), (Some(380), Some(9620)));
    let saved = h.core.txn_get(t.id).unwrap();
    assert_eq!((saved.fee_minor, saved.customer.is_none()), (Some(500), true));
}

#[test]
fn set_commission_recomputes_and_rejects_more_than_net() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100.00", Some("5"));
    h.core.txn_assign(t.id, c.id, None, false).unwrap();
    let t = h.core.txn_set_commission(t.id, CommissionInput::Percent { bps: 1000 }).unwrap();
    assert_eq!(t.customer_amount_minor, Some(8550));
    assert_eq!(
        code(h.core.txn_set_commission(t.id, CommissionInput::Fixed { amount_text: "95.01".into() })),
        ErrorCode::CommissionExceedsNet
    );
    // Raising the fee above what a fixed commission allows is rejected too.
    h.core.txn_set_commission(t.id, CommissionInput::Fixed { amount_text: "90".into() }).unwrap();
    assert_eq!(
        code(h.core.txn_set_fee(t.id, FeeInput::Fee { fee_text: "11".into() })),
        ErrorCode::CommissionExceedsNet
    );
}

#[test]
fn forbidden_transitions() {
    let h = harness();
    let active = h.customer("Active", 2500);
    let inactive = h.customer("Inactive", 2500);
    h.core.customer_set_active(inactive.id, false).unwrap();

    let t = h.manual("USD", "10", Some("1"));
    // unassigned: cannot approve, unassign, unapprove, set commission, include
    assert_eq!(code(h.core.txn_approve(t.id)), ErrorCode::InvalidTransition);
    assert_eq!(code(h.core.txn_unassign(t.id)), ErrorCode::InvalidTransition);
    assert_eq!(code(h.core.txn_unapprove(t.id, "x")), ErrorCode::InvalidTransition);
    assert_eq!(
        code(h.core.txn_set_commission(t.id, CommissionInput::Percent { bps: 1 })),
        ErrorCode::InvalidTransition
    );
    assert_eq!(code(h.core.txn_set_excluded(t.id, false)), ErrorCode::InvalidTransition);
    // inactive customer
    assert_eq!(code(h.core.txn_assign(t.id, inactive.id, None, false)), ErrorCode::CustomerInactive);
    assert_eq!(code(h.core.txn_assign(t.id, 9999, None, false)), ErrorCode::NotFound);

    // pending: cannot assign again or exclude
    h.core.txn_assign(t.id, active.id, None, false).unwrap();
    assert_eq!(code(h.core.txn_assign(t.id, active.id, None, false)), ErrorCode::InvalidTransition);
    assert_eq!(code(h.core.txn_set_excluded(t.id, true)), ErrorCode::InvalidTransition);

    // approved: locked
    h.core.txn_approve(t.id).unwrap();
    assert_eq!(code(h.core.txn_set_fee(t.id, FeeInput::Zero)), ErrorCode::InvalidTransition);
    assert_eq!(
        code(h.core.txn_set_commission(t.id, CommissionInput::Percent { bps: 0 })),
        ErrorCode::InvalidTransition
    );
    assert_eq!(code(h.core.txn_unassign(t.id)), ErrorCode::InvalidTransition);
    assert_eq!(code(h.core.txn_approve(t.id)), ErrorCode::InvalidTransition);
    assert_eq!(code(h.core.txn_set_excluded(t.id, true)), ErrorCode::InvalidTransition);
    assert_eq!(code(h.core.txn_unapprove(t.id, "   ")), ErrorCode::Validation, "reason is required");

    // zero customer share cannot be approved
    let t2 = h.manual("USD", "10", Some("1"));
    h.core.txn_assign(t2.id, active.id, Some(CommissionInput::Percent { bps: 10000 }), false).unwrap();
    assert_eq!(code(h.core.txn_approve(t2.id)), ErrorCode::Validation);
}

#[test]
fn unassign_exclude_include() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "10", Some("1"));
    h.core.txn_assign(t.id, c.id, None, false).unwrap();
    let t = h.core.txn_unassign(t.id).unwrap();
    assert_eq!((t.status, t.customer.is_none(), t.commission_bps), (TxnStatus::Unassigned, true, None));
    let t = h.core.txn_set_excluded(t.id, true).unwrap();
    assert_eq!(t.status, TxnStatus::Excluded);
    assert_eq!(t.allowed_actions, vec![TxnAction::Include, TxnAction::EditNote, TxnAction::Delete]);
    let t = h.core.txn_set_excluded(t.id, false).unwrap();
    assert_eq!(t.status, TxnStatus::Unassigned);
    let t = h.core.txn_set_note(t.id, Some("  لي شخصياً ".into())).unwrap();
    assert_eq!(t.note.as_deref(), Some("لي شخصياً"));
}

#[test]
fn default_commission_change_does_not_touch_assigned() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let t = h.manual("USD", "100", Some("0"));
    h.core.txn_assign(t.id, c.id, None, false).unwrap();
    h.core
        .customer_update(
            c.id,
            CustomerInput {
                name: "Ali".into(),
                phone: None,
                default_commission_bps: 1000,
                notes: None,
                is_active: None,
            },
        )
        .unwrap();
    assert_eq!(h.core.txn_get(t.id).unwrap().commission_bps, Some(2500));
}

#[test]
fn bulk_actions_report_each_failure() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let a = h.manual("USD", "10", Some("1"));
    let b = h.manual("USD", "20", None);
    let r = h.core.txn_bulk(BulkAction::Assign, &[a.id, b.id, 999], Some(c.id), None).unwrap();
    assert_eq!(r.ok, vec![a.id, b.id]);
    assert_eq!(r.failed.len(), 1);
    assert_eq!(r.failed[0].code, ErrorCode::NotFound);
    let r = h.core.txn_bulk(BulkAction::Approve, &[a.id, b.id], None, None).unwrap();
    assert_eq!(r.ok, vec![a.id]);
    assert_eq!(r.failed[0].id, b.id);
    assert_eq!(r.failed[0].code, ErrorCode::FeeRequired);
    let r = h.core.txn_bulk(BulkAction::Unassign, &[b.id], None, None).unwrap();
    assert_eq!(r.ok, vec![b.id]);
    let r = h.core.txn_bulk(BulkAction::Exclude, &[b.id, a.id], None, None).unwrap();
    assert_eq!((r.ok.clone(), r.failed[0].id), (vec![b.id], a.id));
    assert_eq!(code(h.core.txn_bulk(BulkAction::Assign, &[a.id], None, None)), ErrorCode::Validation);
}

#[test]
fn list_filter_sort_page_totals_and_counts() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    for i in 0..60 {
        h.manual("USD", &format!("{}.00", i + 1), if i % 2 == 0 { Some("1") } else { None });
    }
    let eur = h.manual("EUR", "50,00", Some("2,05"));
    h.core.txn_assign(eur.id, c.id, None, false).unwrap();

    let all = h.core.txn_list(&TxnFilter::default(), TxnSort::default(), 1, 50).unwrap();
    assert_eq!((all.total, all.items.len(), all.page_size), (61, 50, 50));
    let usd = all.totals.iter().find(|t| t.currency == "USD").unwrap();
    assert_eq!(usd.count, 60);
    assert_eq!(usd.gross_minor, (1..=60).sum::<i64>() * 100);
    assert_eq!(usd.fee_minor, 30 * 100);
    let page2 = h.core.txn_list(&TxnFilter::default(), TxnSort::default(), 2, 50).unwrap();
    assert_eq!(page2.items.len(), 11);

    let sorted = h
        .core
        .txn_list(&TxnFilter::default(), TxnSort { key: TxnSortKey::GrossMinor, dir: SortDir::Desc }, 1, 5)
        .unwrap();
    assert_eq!(sorted.items[0].gross_minor, 6000);

    let f = TxnFilter { needs_fee_only: Some(true), ..Default::default() };
    assert_eq!(h.core.txn_list(&f, TxnSort::default(), 1, 50).unwrap().total, 30);
    let f = TxnFilter { status: Some(StatusFilter::Status(TxnStatus::PendingApproval)), ..Default::default() };
    assert_eq!(h.core.txn_list(&f, TxnSort::default(), 1, 50).unwrap().total, 1);
    let f = TxnFilter { currency: Some("eur".into()), customer_id: Some(c.id), ..Default::default() };
    assert_eq!(h.core.txn_list(&f, TxnSort::default(), 1, 50).unwrap().total, 1);
    let f = TxnFilter { search: Some("john.doe@".into()), ..Default::default() };
    assert_eq!(h.core.txn_list(&f, TxnSort::default(), 1, 50).unwrap().total, 61);
    let f = TxnFilter { search: Some("100%".into()), ..Default::default() };
    assert_eq!(h.core.txn_list(&f, TxnSort::default(), 1, 50).unwrap().total, 0, "LIKE wildcards are escaped");

    let counts = h.core.txn_counts(&TxnFilter::default()).unwrap();
    assert_eq!((counts.all, counts.unassigned, counts.pending_approval, counts.needs_fee), (61, 60, 1, 30));

    // Period: occurred 2026-11-20 10:30 local
    let f = TxnFilter {
        period: Some(ppfeez_core::transactions::Period {
            from: Some("2026-11-20".into()),
            to: Some("2026-11-20".into()),
        }),
        ..Default::default()
    };
    assert_eq!(h.core.txn_list(&f, TxnSort::default(), 1, 50).unwrap().total, 61);
    let f = TxnFilter {
        period: Some(ppfeez_core::transactions::Period { from: Some("2026-11-21".into()), to: None }),
        ..Default::default()
    };
    assert_eq!(h.core.txn_list(&f, TxnSort::default(), 1, 50).unwrap().total, 0);
}
