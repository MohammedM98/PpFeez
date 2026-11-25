//! SPEC §4.8 / §6.5: linked payouts, transfer numbers, the eight figures and the statement.

use crate::error::AppResult;
use crate::state::AppState;
use ppfeez_core::payouts::{
    CreateStatus, CustomerStatement, CustomerSummary, Payout, PayoutCreateInput, PayoutDetails, PayoutPreparation,
    PayoutRegisterRow, PayoutSelection, StatementFilter,
};
use ppfeez_core::transactions::BulkResult;
use tauri::State;

#[tauri::command]
pub async fn customer_summary(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: String,
) -> AppResult<CustomerSummary> {
    state.core.guard()?;
    state.core.customer_summary(customer_id, &currency)
}

#[tauri::command]
pub async fn customer_statement(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: String,
    filter: Option<StatementFilter>,
) -> AppResult<CustomerStatement> {
    state.core.guard()?;
    state.core.customer_statement(customer_id, &currency, &filter.unwrap_or_default())
}

#[tauri::command]
pub async fn payout_prepare(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: String,
    selection: PayoutSelection,
) -> AppResult<PayoutPreparation> {
    state.core.guard()?;
    state.core.payout_prepare(customer_id, &currency, &selection)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn payout_create(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: String,
    txn_ids: Vec<i64>,
    returned_entry_ids: Option<Vec<i64>>,
    amount_text: Option<String>,
    difference_reason: Option<String>,
    date: String,
    details: PayoutDetails,
    status: CreateStatus,
    matched_confirmed: bool,
) -> AppResult<Payout> {
    state.core.guard()?;
    state.core.payout_create(
        customer_id,
        PayoutCreateInput {
            currency,
            txn_ids,
            returned_entry_ids: returned_entry_ids.unwrap_or_default(),
            amount_text,
            difference_reason,
            date,
            details,
            status,
            matched_confirmed,
        },
    )
}

#[tauri::command]
pub async fn payout_mark_sent(state: State<'_, AppState>, payout_id: i64, date: Option<String>) -> AppResult<Payout> {
    state.core.guard()?;
    state.core.payout_mark_sent(payout_id, date.as_deref())
}

#[tauri::command]
pub async fn payout_update_details(
    state: State<'_, AppState>,
    payout_id: i64,
    details: PayoutDetails,
) -> AppResult<Payout> {
    state.core.guard()?;
    state.core.payout_update_details(payout_id, details)
}

#[tauri::command]
pub async fn payout_cancel(state: State<'_, AppState>, payout_id: i64, reason: String) -> AppResult<Payout> {
    state.core.guard()?;
    state.core.payout_cancel(payout_id, &reason)
}

/// SPEC §4.9: standalone and linked payouts in one numbering, with the cumulative paid amount.
#[tauri::command]
pub async fn payout_register(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: String,
) -> AppResult<Vec<PayoutRegisterRow>> {
    state.core.guard()?;
    state.core.payout_register(customer_id, &currency)
}

#[tauri::command]
pub async fn payouts_list(state: State<'_, AppState>, customer_id: i64, currency: String) -> AppResult<Vec<Payout>> {
    state.core.guard()?;
    state.core.payouts_list(customer_id, &currency)
}

#[tauri::command]
pub async fn payout_defaults(state: State<'_, AppState>, customer_id: i64) -> AppResult<Option<PayoutDetails>> {
    state.core.guard()?;
    state.core.payout_defaults(customer_id)
}

#[tauri::command]
pub async fn payout_platform_suggestions(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    state.core.guard()?;
    state.core.payout_platform_suggestions()
}

#[tauri::command]
pub async fn txn_set_matched(state: State<'_, AppState>, ids: Vec<i64>, matched: bool) -> AppResult<BulkResult> {
    state.core.guard()?;
    state.core.txn_set_matched(&ids, matched)
}
