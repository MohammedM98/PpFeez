//! PpFeez Tauri app: wires plugins, state, commands and lifecycle hooks around `ppfeez_core`.

mod commands;
mod error;
mod state;

use ppfeez_core::{Core, CoreConfig};
use state::AppState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let version = app.package_info().version.to_string();
            let core = Core::open(CoreConfig::production(&data_dir, &version))
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            app.manage(AppState { core: Arc::new(core) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_status,
            commands::app::unlock,
            commands::app::lock,
            commands::app::set_lock_password,
            commands::app::get_settings,
            commands::app::update_settings,
            commands::app::open_data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PpFeez");
}
