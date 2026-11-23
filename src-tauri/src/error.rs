//! Commands return the core's `AppError`, which serializes to the contract's
//! `{ code, messageAr, field? }`.

pub use ppfeez_core::{AppError, AppResult};

/// Error for failures of the Tauri runtime itself (paths, dialogs, opener).
pub fn runtime(e: impl std::fmt::Display) -> AppError {
    AppError::internal(e)
}
