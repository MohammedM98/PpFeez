use crate::error::{runtime, AppResult};
use crate::state::AppState;
use ppfeez_core::lock::AppStatus;
use ppfeez_core::settings::{Settings, SettingsPatch};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn app_status(state: State<'_, AppState>) -> AppResult<AppStatus> {
    state.core.app_status()
}

#[tauri::command]
pub async fn unlock(state: State<'_, AppState>, password: String) -> AppResult<AppStatus> {
    state.core.unlock(&password)
}

#[tauri::command]
pub async fn lock(state: State<'_, AppState>) -> AppResult<()> {
    state.core.lock()
}

#[tauri::command]
pub async fn set_lock_password(
    state: State<'_, AppState>,
    current: Option<String>,
    next: Option<String>,
) -> AppResult<()> {
    state.core.guard()?;
    state.core.set_lock_password(current.as_deref(), next.as_deref())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    state.core.guard()?;
    state.core.get_settings()
}

#[tauri::command]
pub async fn update_settings(state: State<'_, AppState>, patch: SettingsPatch) -> AppResult<Settings> {
    state.core.guard()?;
    state.core.update_settings(patch)
}

#[tauri::command]
pub async fn open_data_dir(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    state.core.guard()?;
    let dir = state.core.data_dir().display().to_string();
    app.opener().open_path(dir, None::<&str>).map_err(runtime)
}
