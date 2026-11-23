use crate::error::AppResult;
use crate::state::AppState;
use ppfeez_core::audit::HistoryItem;
use ppfeez_core::transactions::{
    BulkAction, BulkResult, CommissionInput, FeeInput, ManualTxnInput, Transaction, TxnCounts, TxnFilter,
    TxnListResult, TxnPreview, TxnSort,
};
use tauri::State;

#[tauri::command]
pub async fn txn_list(
    state: State<'_, AppState>,
    filter: TxnFilter,
    sort: Option<TxnSort>,
    page: i64,
    page_size: i64,
) -> AppResult<TxnListResult> {
    state.core.guard()?;
    state.core.txn_list(&filter, sort.unwrap_or_default(), page, page_size)
}

#[tauri::command]
pub async fn txn_counts(state: State<'_, AppState>, filter: Option<TxnFilter>) -> AppResult<TxnCounts> {
    state.core.guard()?;
    state.core.txn_counts(&filter.unwrap_or_default())
}

#[tauri::command]
pub async fn txn_get(state: State<'_, AppState>, id: i64) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_get(id)
}

#[tauri::command]
pub async fn txn_history(state: State<'_, AppState>, id: i64) -> AppResult<Vec<HistoryItem>> {
    state.core.guard()?;
    state.core.txn_history(id)
}

#[tauri::command]
pub async fn txn_preview(
    state: State<'_, AppState>,
    id: i64,
    fee: Option<FeeInput>,
    commission: Option<CommissionInput>,
    customer_id: Option<i64>,
) -> AppResult<TxnPreview> {
    state.core.guard()?;
    state.core.txn_preview(id, fee, commission, customer_id)
}

#[tauri::command]
pub async fn txn_create_manual(state: State<'_, AppState>, input: ManualTxnInput) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_create_manual(input)
}

#[tauri::command]
pub async fn txn_assign(
    state: State<'_, AppState>,
    id: i64,
    customer_id: i64,
    commission: Option<CommissionInput>,
    approve: Option<bool>,
) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_assign(id, customer_id, commission, approve.unwrap_or(false))
}

#[tauri::command]
pub async fn txn_unassign(state: State<'_, AppState>, id: i64) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_unassign(id)
}

#[tauri::command]
pub async fn txn_set_fee(state: State<'_, AppState>, id: i64, fee: FeeInput) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_set_fee(id, fee)
}

#[tauri::command]
pub async fn txn_set_commission(
    state: State<'_, AppState>,
    id: i64,
    commission: CommissionInput,
) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_set_commission(id, commission)
}

#[tauri::command]
pub async fn txn_approve(state: State<'_, AppState>, id: i64) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_approve(id)
}

#[tauri::command]
pub async fn txn_unapprove(state: State<'_, AppState>, id: i64, reason: String) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_unapprove(id, &reason)
}

#[tauri::command]
pub async fn txn_set_excluded(state: State<'_, AppState>, id: i64, excluded: bool) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_set_excluded(id, excluded)
}

#[tauri::command]
pub async fn txn_set_note(state: State<'_, AppState>, id: i64, note: Option<String>) -> AppResult<Transaction> {
    state.core.guard()?;
    state.core.txn_set_note(id, note)
}

#[tauri::command]
pub async fn txn_bulk(
    state: State<'_, AppState>,
    action: BulkAction,
    ids: Vec<i64>,
    customer_id: Option<i64>,
    commission: Option<CommissionInput>,
) -> AppResult<BulkResult> {
    state.core.guard()?;
    state.core.txn_bulk(action, &ids, customer_id, commission)
}
