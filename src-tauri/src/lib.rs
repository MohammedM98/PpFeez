//! PpFeez Tauri app: wires plugins, state, commands and lifecycle hooks around `ppfeez_core`.

mod commands;
mod error;
mod state;

use ppfeez_core::{Core, CoreConfig};
use state::AppState;
use std::sync::Arc;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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
            // app
            commands::app::app_status,
            commands::app::unlock,
            commands::app::lock,
            commands::app::set_lock_password,
            commands::app::get_settings,
            commands::app::update_settings,
            commands::app::open_data_dir,
            // dashboard
            commands::dashboard::dashboard_summary,
            // customers
            commands::customers::customers_list,
            commands::customers::customer_get,
            commands::customers::customer_create,
            commands::customers::customer_update,
            commands::customers::customer_set_active,
            // transactions
            commands::transactions::txn_list,
            commands::transactions::txn_counts,
            commands::transactions::txn_get,
            commands::transactions::txn_history,
            commands::transactions::txn_preview,
            commands::transactions::txn_create_manual,
            commands::transactions::txn_assign,
            commands::transactions::txn_unassign,
            commands::transactions::txn_set_fee,
            commands::transactions::txn_set_commission,
            commands::transactions::txn_approve,
            commands::transactions::txn_unapprove,
            commands::transactions::txn_set_excluded,
            commands::transactions::txn_set_note,
            commands::transactions::txn_bulk,
            // ledger & refunds
            commands::ledger::ledger_balances,
            commands::ledger::ledger_entries,
            commands::ledger::ledger_add_payout,
            commands::ledger::ledger_add_adjustment,
            commands::ledger::ledger_reverse_entry,
            commands::ledger::ledger_export_csv,
            commands::ledger::ledger_statement,
            commands::ledger::refund_alerts,
            commands::ledger::refund_confirm_reversal,
            commands::ledger::refund_dismiss,
            // mail & pull
            commands::mail::mailbox_list,
            commands::mail::mailbox_create,
            commands::mail::mailbox_update,
            commands::mail::mailbox_set_active,
            commands::mail::mailbox_set_password,
            commands::mail::mailbox_test,
            commands::mail::mailbox_delete,
            commands::mail::pull_start,
            commands::mail::pull_cancel,
            commands::mail::pull_runs_list,
            // emails
            commands::emails::emails_list,
            commands::emails::email_get,
            commands::emails::email_reparse,
            commands::emails::email_set_ignored,
            // backup
            commands::backup::backup_now,
            commands::backup::backup_list,
            commands::backup::backup_restore,
            // excel
            commands::excel::excel_set_path,
            commands::excel::excel_update,
            commands::excel::excel_export_transactions,
            commands::excel::excel_export_ledger,
            commands::excel::open_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building PpFeez");

    let mut backed_up = false;
    app.run(move |handle, event| {
        // Back up and refresh the Excel file once when the app is about to close (if enabled).
        if let RunEvent::ExitRequested { .. } = event {
            if !backed_up {
                backed_up = true;
                if let Some(state) = handle.try_state::<AppState>() {
                    // Failures never block closing; they are logged.
                    if let Err(e) = state.core.backup_on_close() {
                        eprintln!("backup on close failed: {e}");
                    }
                    if let Err(e) = state.core.excel_on_close() {
                        eprintln!("excel update on close failed: {e}");
                    }
                }
            }
        }
    });
}
