mod common;

use common::{code, harness};
use ppfeez_core::error::ErrorCode;
use ppfeez_core::ledger::{AdjustmentInput, Direction, LedgerType, PayoutInput, PayoutMethod};
use ppfeez_core::transactions::{Period, TxnStatus};
use rusqlite::Connection;

fn payout(currency: &str, amount: &str, date: &str, confirm: bool) -> PayoutInput {
    PayoutInput {
        currency: currency.into(),
        amount_text: amount.into(),
        entry_date: date.into(),
        method: PayoutMethod::Cash,
        reference: Some("R-1".into()),
        description: None,
        confirm_overdraw: Some(confirm),
    }
}

fn approved(h: &common::Harness, customer_id: i64, currency: &str, gross: &str, fee: &str) -> i64 {
    let t = h.manual(currency, gross, Some(fee));
    h.core.txn_assign(t.id, customer_id, None, true).unwrap();
    t.id
}

#[test]
fn ledger_rows_are_immutable() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    approved(&h, c.id, "USD", "100", "5");
    let conn = Connection::open(h.core.db_path()).unwrap();
    let upd = conn.execute("UPDATE ledger_entries SET amount_minor = 1", []);
    assert!(upd.unwrap_err().to_string().contains("immutable"));
    let del = conn.execute("DELETE FROM ledger_entries", []);
    assert!(del.unwrap_err().to_string().contains("immutable"));
}

#[test]
fn balance_per_currency_and_running_balance() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    approved(&h, c.id, "USD", "100", "5"); // 71.25
    approved(&h, c.id, "USD", "200", "10"); // 142.50
    approved(&h, c.id, "EUR", "50,00", "2,05"); // 47.95 → 35.96 (commission 11.99 → half-up of 11.9875)
    let b = h.core.ledger_balances(c.id).unwrap();
    let usd = b.iter().find(|x| x.currency == "USD").unwrap();
    let eur = b.iter().find(|x| x.currency == "EUR").unwrap();
    assert_eq!(usd.balance_minor, 21375);
    assert_eq!(eur.balance_minor, 4795 - 1199);

    h.core.ledger_add_payout(c.id, payout("USD", "100", "2026-11-23", false)).unwrap();
    h.core
        .ledger_add_adjustment(
            c.id,
            AdjustmentInput {
                currency: "USD".into(),
                amount_text: "10".into(),
                direction: Direction::Credit,
                entry_date: "2026-11-24".into(),
                description: "رصيد افتتاحي".into(),
            },
        )
        .unwrap();
    let view = h.core.ledger_entries(c.id, "USD", None).unwrap();
    let running: Vec<i64> = view.entries.iter().map(|e| e.running_balance_minor).collect();
    assert_eq!(running, vec![7125, 21375, 11375, 12375]);
    assert_eq!((view.opening_balance_minor, view.closing_balance_minor), (0, 12375));

    let card = h.core.ledger_balances(c.id).unwrap().into_iter().find(|x| x.currency == "USD").unwrap();
    assert_eq!((card.credits_minor, card.debits_minor, card.balance_minor), (22375, 10000, 12375));

    // Period with opening balance line.
    let p = Period { from: Some("2026-11-24".into()), to: None };
    let view = h.core.ledger_entries(c.id, "USD", Some(&p)).unwrap();
    assert_eq!(view.opening_balance_minor, 11375);
    assert_eq!(view.entries.len(), 1);
    assert_eq!(view.entries[0].running_balance_minor, 12375);
}

#[test]
fn unapprove_restores_the_previous_balance() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    approved(&h, c.id, "USD", "50", "0");
    let before = h.balance(c.id, "USD");
    let id = approved(&h, c.id, "USD", "100", "5");
    assert_eq!(h.balance(c.id, "USD"), before + 7125);

    let t = h.core.txn_unapprove(id, "خطأ في العميل").unwrap();
    assert_eq!(t.status, TxnStatus::Unassigned);
    assert!(t.customer.is_none());
    assert_eq!(h.balance(c.id, "USD"), before);

    let view = h.core.ledger_entries(c.id, "USD", None).unwrap();
    let credit = view.entries.iter().find(|e| e.transaction_id == Some(id) && e.kind == LedgerType::Credit).unwrap();
    let rev = view.entries.iter().find(|e| e.reverses_entry_id == Some(credit.id)).unwrap();
    assert_eq!(rev.amount_minor, -7125);
    assert_eq!(credit.reversed_by_entry_id, Some(rev.id));
    assert!(rev.description.starts_with("عكس: دفعة من John Doe"));

    // Re-approve: a fresh credit, the balance is back.
    h.core.txn_assign(id, c.id, None, true).unwrap();
    assert_eq!(h.balance(c.id, "USD"), before + 7125);
    let credits = h
        .core
        .ledger_entries(c.id, "USD", None)
        .unwrap()
        .entries
        .iter()
        .filter(|e| e.transaction_id == Some(id) && e.kind == LedgerType::Credit)
        .count();
    assert_eq!(credits, 2);
}

#[test]
fn reversal_is_allowed_once() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    approved(&h, c.id, "USD", "100", "0");
    let p = h.core.ledger_add_payout(c.id, payout("USD", "20", "2026-11-23", false)).unwrap();
    assert_eq!(p.amount_minor, -2000);
    assert_eq!(code(h.core.ledger_reverse_entry(p.id, "")), ErrorCode::Validation);
    let r = h.core.ledger_reverse_entry(p.id, "دفعة مكررة").unwrap();
    assert_eq!(r.amount_minor, 2000);
    assert_eq!(r.kind, LedgerType::Reversal);
    assert_eq!(r.reverses_entry_id, Some(p.id));
    assert_eq!(code(h.core.ledger_reverse_entry(p.id, "مرة أخرى")), ErrorCode::AlreadyReversed);
    assert_eq!(h.balance(c.id, "USD"), 7500);
    // The DB itself refuses a second reversal of the same entry.
    let conn = Connection::open(h.core.db_path()).unwrap();
    let dup = conn.execute(
        "INSERT INTO ledger_entries (customer_id, currency, type, amount_minor, reverses_entry_id, description, entry_date, created_at)
         VALUES (?1, 'USD', 'reversal', 2000, ?2, 'x', '2026-11-23', '2026-11-23T00:00:00Z')",
        rusqlite::params![c.id, p.id],
    );
    assert!(dup.unwrap_err().to_string().contains("UNIQUE"));
}

#[test]
fn approval_entries_go_through_unapprove() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let id = approved(&h, c.id, "USD", "100", "0");
    let credit = h.core.ledger_entries(c.id, "USD", None).unwrap().entries[0].clone();
    assert_eq!(code(h.core.ledger_reverse_entry(credit.id, "x")), ErrorCode::InvalidTransition);
    h.core.txn_unapprove(id, "x").unwrap();
    let rev = h.core.ledger_entries(c.id, "USD", None).unwrap().entries[1].clone();
    assert_eq!(code(h.core.ledger_reverse_entry(rev.id, "x")), ErrorCode::InvalidTransition);
}

#[test]
fn payout_overdraw_needs_confirmation() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    approved(&h, c.id, "USD", "100", "0"); // 75.00
    let e = h.core.ledger_add_payout(c.id, payout("USD", "80", "2026-11-23", false)).unwrap_err();
    assert_eq!((e.code, e.field.as_deref()), (ErrorCode::Validation, Some("overdraw")));
    h.core.ledger_add_payout(c.id, payout("USD", "80", "2026-11-23", true)).unwrap();
    assert_eq!(h.balance(c.id, "USD"), -500, "negative balance = customer owes");
    assert_eq!(code(h.core.ledger_add_payout(c.id, payout("USD", "0", "2026-11-23", true))), ErrorCode::InvalidAmount);
    assert_eq!(code(h.core.ledger_add_payout(c.id, payout("USD", "1", "23/11/2026", true))), ErrorCode::Validation);
    assert_eq!(code(h.core.ledger_add_payout(999, payout("USD", "1", "2026-11-23", true))), ErrorCode::NotFound);
}

#[test]
fn adjustment_requires_description() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    let input = AdjustmentInput {
        currency: "EUR".into(),
        amount_text: "12,50".into(),
        direction: Direction::Debit,
        entry_date: "2026-11-01".into(),
        description: "  ".into(),
    };
    assert_eq!(code(h.core.ledger_add_adjustment(c.id, input.clone())), ErrorCode::Validation);
    let e = h.core.ledger_add_adjustment(c.id, AdjustmentInput { description: "خصم".into(), ..input }).unwrap();
    assert_eq!((e.amount_minor, e.kind), (-1250, LedgerType::Adjustment));
}

#[test]
fn csv_export_and_statement() {
    let h = harness();
    let c = h.customer("أحمد", 2500);
    approved(&h, c.id, "USD", "1,000.00", "50");
    h.core.ledger_add_payout(c.id, payout("USD", "100", "2026-11-23", false)).unwrap();
    let path = h.dir.path().join("statement.csv");
    h.core.ledger_export_csv(c.id, "USD", None, &path).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..3], b"\xEF\xBB\xBF", "UTF-8 BOM for Excel");
    let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
    assert!(text.contains("\"أحمد\""));
    assert!(text.contains("التاريخ,النوع,الوصف,له,عليه,الرصيد,المرجع"));
    assert!(text.contains(",712.50,,712.50,"));
    assert!(text.contains(",,100.00,612.50,\"R-1\""));
    let st = h.core.ledger_statement(c.id, "USD", None).unwrap();
    assert_eq!(st.view.closing_balance_minor, 61250);
    assert_eq!(st.customer.name, "أحمد");
}

#[test]
fn customers_are_deactivated_not_deleted() {
    let h = harness();
    let c = h.customer("Ali", 2500);
    approved(&h, c.id, "USD", "10", "0");
    let c = h.core.customer_set_active(c.id, false).unwrap();
    assert!(!c.is_active);
    assert_eq!(c.balances[0].minor, 750, "ledger stays");
    assert_eq!(h.core.customers_list(None, Some(true)).unwrap().len(), 0);
    assert_eq!(h.core.customers_list(Some("al"), None).unwrap().len(), 1);
}
