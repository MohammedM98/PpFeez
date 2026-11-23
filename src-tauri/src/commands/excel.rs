use crate::error::{runtime, AppResult};
use crate::state::AppState;
use ppfeez_core::excel::ExcelExportResult;
use ppfeez_core::settings::Settings;
use ppfeez_core::transactions::{Period, TxnFilter, TxnSort};
use ppfeez_core::AppError;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn excel_set_path(state: State<'_, AppState>, path: String) -> AppResult<Settings> {
    state.core.guard()?;
    state.core.excel_set_path(&path)
}

#[tauri::command]
pub async fn excel_update(state: State<'_, AppState>) -> AppResult<ExcelExportResult> {
    state.core.guard()?;
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || core.excel_update()).await.map_err(runtime)?
}

#[tauri::command]
pub async fn excel_export_transactions(
    state: State<'_, AppState>,
    filter: TxnFilter,
    sort: Option<TxnSort>,
    path: PathBuf,
) -> AppResult<ExcelExportResult> {
    state.core.guard()?;
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.excel_export_transactions(&filter, sort.unwrap_or_default(), &path)
    })
    .await
    .map_err(runtime)?
}

#[tauri::command]
pub async fn excel_export_ledger(
    state: State<'_, AppState>,
    customer_id: i64,
    currency: Option<String>,
    period: Option<Period>,
    path: PathBuf,
) -> AppResult<ExcelExportResult> {
    state.core.guard()?;
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.excel_export_ledger(customer_id, currency.as_deref(), period.as_ref(), &path)
    })
    .await
    .map_err(runtime)?
}

/// Open an exported file (`.xlsx` or `.csv`) with its default application.
#[tauri::command]
pub async fn open_path(app: AppHandle, state: State<'_, AppState>, path: PathBuf) -> AppResult<()> {
    state.core.guard()?;
    let allowed = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("xlsx") || e.eq_ignore_ascii_case("csv"))
        .unwrap_or(false);
    if !allowed {
        return Err(AppError::validation("path", "يمكن فتح ملفات Excel أو CSV فقط"));
    }
    if !path.is_file() {
        return Err(AppError::not_found("الملف"));
    }
    app.opener().open_path(path.display().to_string(), None::<&str>).map_err(runtime)
}
