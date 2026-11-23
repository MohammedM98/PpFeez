use crate::error::AppResult;
use crate::state::AppState;
use ppfeez_core::backup::BackupFile;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn backup_now(state: State<'_, AppState>) -> AppResult<BackupFile> {
    state.core.guard()?;
    state.core.backup_now()
}

#[tauri::command]
pub async fn backup_list(state: State<'_, AppState>) -> AppResult<Vec<BackupFile>> {
    state.core.guard()?;
    state.core.backup_list()
}

/// Takes a backup of the current data, restores the file, then restarts the app.
#[tauri::command]
pub async fn backup_restore(app: AppHandle, state: State<'_, AppState>, path: PathBuf) -> AppResult<()> {
    state.core.guard()?;
    state.core.backup_restore(&path)?;
    app.restart();
}
