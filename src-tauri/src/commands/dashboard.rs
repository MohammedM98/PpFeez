use crate::error::AppResult;
use crate::state::AppState;
use ppfeez_core::dashboard::DashboardSummary;
use ppfeez_core::transactions::Period;
use tauri::State;

#[tauri::command]
pub async fn dashboard_summary(state: State<'_, AppState>, period: Option<Period>) -> AppResult<DashboardSummary> {
    state.core.guard()?;
    state.core.dashboard_summary(&period.unwrap_or_default())
}
