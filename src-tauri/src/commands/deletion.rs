//! SPEC §4.7: delete with a preview, a confirmation and (where required) an automatic backup.

use crate::error::AppResult;
use crate::state::AppState;
use ppfeez_core::deletion::{
    CustomerDeletePreview, DeleteResult, LedgerDeletePreview, ResetPreview, ResetResult, ResetScope, TxnDeletePreview,
    TxnDeleteResult,
};
use tauri::State;

#[tauri::command]
pub async fn txn_delete_preview(state: State<'_, AppState>, ids: Vec<i64>) -> AppResult<TxnDeletePreview> {
    state.core.guard()?;
    state.core.txn_delete_preview(&ids)
}

#[tauri::command]
pub async fn txn_delete(
    state: State<'_, AppState>,
    ids: Vec<i64>,
    reason: Option<String>,
) -> AppResult<TxnDeleteResult> {
    state.core.guard()?;
    state.core.txn_delete(&ids, reason.as_deref())
}

#[tauri::command]
pub async fn customer_delete_preview(state: State<'_, AppState>, id: i64) -> AppResult<CustomerDeletePreview> {
    state.core.guard()?;
    state.core.customer_delete_preview(id)
}

#[tauri::command]
pub async fn customer_delete(state: State<'_, AppState>, id: i64, confirm_name: String) -> AppResult<DeleteResult> {
    state.core.guard()?;
    state.core.customer_delete(id, &confirm_name)
}

#[tauri::command]
pub async fn ledger_delete_preview(state: State<'_, AppState>, entry_id: i64) -> AppResult<LedgerDeletePreview> {
    state.core.guard()?;
    state.core.ledger_delete_preview(entry_id)
}

#[tauri::command]
pub async fn ledger_delete_entry(
    state: State<'_, AppState>,
    entry_id: i64,
    reason: Option<String>,
) -> AppResult<DeleteResult> {
    state.core.guard()?;
    state.core.ledger_delete_entry(entry_id, reason.as_deref())
}

#[tauri::command]
pub async fn data_reset_preview(state: State<'_, AppState>, scope: ResetScope) -> AppResult<ResetPreview> {
    state.core.guard()?;
    state.core.data_reset_preview(scope)
}

#[tauri::command]
pub async fn data_reset(state: State<'_, AppState>, scope: ResetScope, confirm_text: String) -> AppResult<ResetResult> {
    state.core.guard()?;
    state.core.data_reset(scope, &confirm_text)
}
