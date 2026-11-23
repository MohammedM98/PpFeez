//! Shared application state managed by Tauri.

use ppfeez_core::Core;
use std::sync::Arc;

pub struct AppState {
    pub core: Arc<Core>,
}
