use crate::error::AppResult;
use crate::state::AppState;
use ppfeez_core::ledger::{
    AdjustmentInput, BalanceCard, LedgerEntry, LedgerView, PayoutInput, PayoutPreview, Statement,
};
use ppfeez_core::refunds::RefundAlert;
use ppfeez_core::transactions::Period;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn ledger_balances(state: State<'_, AppState>, customer_id: i64) -> AppResult<Vec<BalanceCard>> {
    state.core.guard()?;
    state.core.ledger_balances(customer_id)
}

#[tauri::command]
pub async fn ledger_entries(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: String,
    period: Option<Period>,
) -> AppResult<LedgerView> {
    state.core.guard()?;
    state.core.ledger_entries(customer_id, &currency, period.as_ref())
}

/// SPEC §4.9: balance before / after for the "تسجيل دفعة" dialog.
#[tauri::command]
pub async fn ledger_payout_preview(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: String,
    amount_text: Option<String>,
) -> AppResult<PayoutPreview> {
    state.core.guard()?;
    state.core.ledger_payout_preview(customer_id, &currency, amount_text.as_deref())
}

#[tauri::command]
pub async fn ledger_add_payout(
    state: State<'_, AppState>,
    customer_id: i64,
    input: PayoutInput,
) -> AppResult<LedgerEntry> {
    state.core.guard()?;
    state.core.ledger_add_payout(customer_id, input)
}

#[tauri::command]
pub async fn ledger_add_adjustment(
    state: State<'_, AppState>,
    customer_id: i64,
    input: AdjustmentInput,
) -> AppResult<LedgerEntry> {
    state.core.guard()?;
    state.core.ledger_add_adjustment(customer_id, input)
}

#[tauri::command]
pub async fn ledger_reverse_entry(state: State<'_, AppState>, entry_id: i64, reason: String) -> AppResult<LedgerEntry> {
    state.core.guard()?;
    state.core.ledger_reverse_entry(entry_id, &reason)
}

#[tauri::command]
pub async fn ledger_export_csv(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: String,
    period: Option<Period>,
    path: PathBuf,
) -> AppResult<()> {
    state.core.guard()?;
    state.core.ledger_export_csv(customer_id, &currency, period.as_ref(), &path)
}

#[tauri::command]
pub async fn ledger_statement(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: String,
    period: Option<Period>,
) -> AppResult<Statement> {
    state.core.guard()?;
    state.core.ledger_statement(customer_id, &currency, period.as_ref())
}

#[tauri::command]
pub async fn refund_alerts(state: State<'_, AppState>) -> AppResult<Vec<RefundAlert>> {
    state.core.guard()?;
    state.core.refund_alerts()
}

#[tauri::command]
pub async fn refund_confirm_reversal(
    state: State<'_, AppState>,
    refund_txn_id: i64,
    amount_text: Option<String>,
) -> AppResult<LedgerEntry> {
    state.core.guard()?;
    state.core.refund_confirm_reversal(refund_txn_id, amount_text.as_deref())
}

#[tauri::command]
pub async fn refund_dismiss(state: State<'_, AppState>, refund_txn_id: i64) -> AppResult<()> {
    state.core.guard()?;
    state.core.refund_dismiss(refund_txn_id)
}
