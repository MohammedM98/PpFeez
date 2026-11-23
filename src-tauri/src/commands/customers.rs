use crate::error::AppResult;
use crate::state::AppState;
use ppfeez_core::customers::{Customer, CustomerInput};
use tauri::State;

#[tauri::command]
pub async fn customers_list(
    state: State<'_, AppState>,
    search: Option<String>,
    active: Option<bool>,
) -> AppResult<Vec<Customer>> {
    state.core.guard()?;
    state.core.customers_list(search.as_deref(), active)
}

#[tauri::command]
pub async fn customer_get(state: State<'_, AppState>, id: i64) -> AppResult<Customer> {
    state.core.guard()?;
    state.core.customer_get(id)
}

#[tauri::command]
pub async fn customer_create(state: State<'_, AppState>, input: CustomerInput) -> AppResult<Customer> {
    state.core.guard()?;
    state.core.customer_create(input)
}

#[tauri::command]
pub async fn customer_update(state: State<'_, AppState>, id: i64, input: CustomerInput) -> AppResult<Customer> {
    state.core.guard()?;
    state.core.customer_update(id, input)
}

#[tauri::command]
pub async fn customer_set_active(state: State<'_, AppState>, id: i64, active: bool) -> AppResult<Customer> {
    state.core.guard()?;
    state.core.customer_set_active(id, active)
}
