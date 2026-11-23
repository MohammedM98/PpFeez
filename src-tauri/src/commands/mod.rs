//! Thin Tauri command layer over `ppfeez_core::Core`. Command names, argument names and
//! returned shapes follow docs/UI-CONTRACT.md exactly. Every command except `app_status`
//! and `unlock` refuses to run while the program is locked.

pub mod app;
pub mod backup;
pub mod customers;
pub mod dashboard;
pub mod emails;
pub mod ledger;
pub mod mail;
pub mod transactions;
