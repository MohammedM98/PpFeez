use crate::error::AppResult;
use crate::state::AppState;
use ppfeez_core::emails::{Page, ParseStatus, RawEmail, RawEmailSummary};
use ppfeez_core::transactions::BulkResult;
use tauri::State;

#[tauri::command]
pub async fn emails_list(
    state: State<'_, AppState>,
    status: ParseStatus,
    search: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<RawEmailSummary>> {
    state.core.guard()?;
    state.core.emails_list(status, search.as_deref(), page.unwrap_or(1), page_size.unwrap_or(50))
}

#[tauri::command]
pub async fn email_get(state: State<'_, AppState>, id: i64) -> AppResult<RawEmail> {
    state.core.guard()?;
    state.core.email_get(id)
}

#[tauri::command]
pub async fn email_reparse(state: State<'_, AppState>, ids: Vec<i64>) -> AppResult<BulkResult> {
    state.core.guard()?;
    state.core.email_reparse(&ids)
}

#[tauri::command]
pub async fn email_set_ignored(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    state.core.guard()?;
    state.core.email_set_ignored(id)
}
