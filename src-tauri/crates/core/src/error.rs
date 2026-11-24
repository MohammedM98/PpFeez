//! Application error shared by every command: `{ code, messageAr, field? }` (UI-CONTRACT §3).

use serde::Serialize;
use std::fmt;

/// Error codes, exactly the `ErrorCode` union of the UI contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Locked,
    WrongPassword,
    TooManyAttempts,
    NotFound,
    Validation,
    InvalidAmount,
    InvalidTransition,
    FeeRequired,
    CommissionExceedsNet,
    CustomerInactive,
    Duplicate,
    AlreadyReversed,
    HasDependents,
    ImapAuth,
    ImapConnect,
    ImapDisabled,
    PullRunning,
    InvalidRange,
    BackupFailed,
    RestoreFailed,
    FileLocked,
    NoExportPath,
    ExportFailed,
    ExcelLayout,
    NotDeletable,
    ConfirmMismatch,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Locked => "locked",
            ErrorCode::WrongPassword => "wrong_password",
            ErrorCode::TooManyAttempts => "too_many_attempts",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Validation => "validation",
            ErrorCode::InvalidAmount => "invalid_amount",
            ErrorCode::InvalidTransition => "invalid_transition",
            ErrorCode::FeeRequired => "fee_required",
            ErrorCode::CommissionExceedsNet => "commission_exceeds_net",
            ErrorCode::CustomerInactive => "customer_inactive",
            ErrorCode::Duplicate => "duplicate",
            ErrorCode::AlreadyReversed => "already_reversed",
            ErrorCode::HasDependents => "has_dependents",
            ErrorCode::ImapAuth => "imap_auth",
            ErrorCode::ImapConnect => "imap_connect",
            ErrorCode::ImapDisabled => "imap_disabled",
            ErrorCode::PullRunning => "pull_running",
            ErrorCode::InvalidRange => "invalid_range",
            ErrorCode::BackupFailed => "backup_failed",
            ErrorCode::RestoreFailed => "restore_failed",
            ErrorCode::FileLocked => "file_locked",
            ErrorCode::NoExportPath => "no_export_path",
            ErrorCode::ExportFailed => "export_failed",
            ErrorCode::ExcelLayout => "excel_layout",
            ErrorCode::NotDeletable => "not_deletable",
            ErrorCode::ConfirmMismatch => "confirm_mismatch",
            ErrorCode::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message_ar: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message_ar: impl Into<String>) -> Self {
        AppError { code, message_ar: message_ar.into(), field: None }
    }

    pub fn with_field(mut self, field: impl Into<String>) -> Self {
        self.field = Some(field.into());
        self
    }

    pub fn validation(field: &str, message_ar: impl Into<String>) -> Self {
        AppError::new(ErrorCode::Validation, message_ar).with_field(field)
    }

    pub fn invalid_amount(field: &str) -> Self {
        AppError::new(ErrorCode::InvalidAmount, "المبلغ غير صالح").with_field(field)
    }

    pub fn not_found(what_ar: &str) -> Self {
        AppError::new(ErrorCode::NotFound, format!("{what_ar} غير موجود"))
    }

    pub fn invalid_transition(message_ar: impl Into<String>) -> Self {
        AppError::new(ErrorCode::InvalidTransition, message_ar)
    }

    pub fn internal(detail: impl fmt::Display) -> Self {
        AppError::new(ErrorCode::Internal, format!("خطأ داخلي: {detail}"))
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message_ar)?;
        if let Some(field) = &self.field {
            write!(f, " ({field})")?;
        }
        Ok(())
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::internal(e)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::internal(e)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::internal(e)
    }
}

/// True when a rusqlite error is a UNIQUE constraint violation.
pub fn is_unique_violation(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                || f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
    )
}
