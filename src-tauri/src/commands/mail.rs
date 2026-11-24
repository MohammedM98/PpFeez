use crate::error::AppResult;
use crate::state::AppState;
use ppfeez_core::mail::mailboxes::{Mailbox, MailboxInput, MailboxTestResult};
use ppfeez_core::mail::pull::{PullRange, PullRun};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn mailbox_list(state: State<'_, AppState>) -> AppResult<Vec<Mailbox>> {
    state.core.guard()?;
    state.core.mailbox_list()
}

#[tauri::command]
pub async fn mailbox_create(state: State<'_, AppState>, input: MailboxInput) -> AppResult<Mailbox> {
    state.core.guard()?;
    state.core.mailbox_create(input)
}

#[tauri::command]
pub async fn mailbox_update(state: State<'_, AppState>, id: i64, input: MailboxInput) -> AppResult<Mailbox> {
    state.core.guard()?;
    state.core.mailbox_update(id, input)
}

#[tauri::command]
pub async fn mailbox_set_active(state: State<'_, AppState>, id: i64, active: bool) -> AppResult<Mailbox> {
    state.core.guard()?;
    state.core.mailbox_set_active(id, active)
}

#[tauri::command]
pub async fn mailbox_set_password(state: State<'_, AppState>, id: i64, password: String) -> AppResult<()> {
    state.core.guard()?;
    state.core.mailbox_set_password(id, &password)
}

/// `{ id }` tests a saved mailbox; `{ input }` tests unsaved settings (onboarding).
#[tauri::command]
pub async fn mailbox_test(
    state: State<'_, AppState>,
    id: Option<i64>,
    input: Option<MailboxInput>,
) -> AppResult<MailboxTestResult> {
    state.core.guard()?;
    let core = state.core.clone();
    // Network I/O: keep it off the async runtime's worker.
    tauri::async_runtime::spawn_blocking(move || core.mailbox_test(id, input)).await.map_err(crate::error::runtime)?
}

#[tauri::command]
pub async fn mailbox_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    state.core.guard()?;
    state.core.mailbox_delete(id)
}

/// Start a pull (`range` defaults to `{ kind: 'new' }`) and return immediately; progress arrives as `pull://progress` events and the
/// end as `pull://finished`.
#[tauri::command]
pub async fn pull_start(
    app: AppHandle,
    state: State<'_, AppState>,
    mailbox_id: i64,
    range: Option<PullRange>,
) -> AppResult<PullRun> {
    state.core.guard()?;
    let (run, cancel) = state.core.pull_start(mailbox_id, range)?;
    let core = state.core.clone();
    let run_id = run.id;
    std::thread::spawn(move || {
        let progress_app = app.clone();
        let finished = core.pull_execute(run_id, &cancel, &move |r: &PullRun| {
            let _ = progress_app.emit("pull://progress", r);
        });
        let _ = app.emit("pull://finished", &finished);
    });
    Ok(run)
}

#[tauri::command]
pub async fn pull_cancel(state: State<'_, AppState>, run_id: i64) -> AppResult<()> {
    state.core.guard()?;
    state.core.pull_cancel(run_id)
}

#[tauri::command]
pub async fn pull_runs_list(state: State<'_, AppState>, limit: Option<i64>) -> AppResult<Vec<PullRun>> {
    state.core.guard()?;
    state.core.pull_runs_list(limit.unwrap_or(50))
}
