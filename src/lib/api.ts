// The only place the UI talks to the backend (docs/UI-CONTRACT.md §1).
// Pages import `api` and never call `invoke` themselves.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type {
  AdjustmentInput, AppError, AppStatus, BackupFile, BalanceCard, BulkResult, CommissionInput,
  Customer, CustomerInput, DashboardSummary, ErrorCode, FeeInput, HistoryItem, LedgerEntry,
  LedgerView, Mailbox, MailboxInput, ManualTxnInput, Page, PayoutInput, Period, PullRun,
  RawEmail, RawEmailSummary, ParseStatus, RefundAlert, Settings, Transaction, TxnCounts,
  TxnFilter, TxnListResult, TxnPreview, TxnSort, Currency, ExcelExportResult, PullRange,
  DeleteEffect, ResetScope, ResetPreview, Money, TxnSearchHit, CustomerExcel, CustomerExcelItemRef, CustomerExcelPreview,
  CustomerSummary, StatementFilter, StatementRow, PayoutSelection, PayoutPreparation, PayoutDetails, Payout, Minor,
} from './contract';

const KNOWN_CODES = new Set<ErrorCode>([
  'locked', 'wrong_password', 'too_many_attempts', 'not_found', 'validation', 'invalid_amount',
  'invalid_transition', 'fee_required', 'commission_exceeds_net', 'customer_inactive', 'duplicate',
  'already_reversed', 'has_dependents', 'imap_auth', 'imap_connect', 'imap_disabled', 'pull_running', 'invalid_range',
  'backup_failed', 'restore_failed', 'not_deletable', 'confirm_mismatch', 'file_locked', 'no_export_path', 'excel_layout', 'export_failed', 'internal',
]);

export class ApiError extends Error implements AppError {
  code: ErrorCode;
  messageAr: string;
  field?: string;
  constructor(e: AppError) {
    super(e.messageAr);
    this.code = e.code;
    this.messageAr = e.messageAr;
    this.field = e.field;
  }
}

export function toAppError(raw: unknown): ApiError {
  if (raw instanceof ApiError) return raw;
  if (raw && typeof raw === 'object' && 'code' in raw) {
    const r = raw as Partial<AppError>;
    if (r.code && KNOWN_CODES.has(r.code)) {
      return new ApiError({ code: r.code, messageAr: r.messageAr ?? 'حدث خطأ غير متوقع', field: r.field });
    }
  }
  return new ApiError({ code: 'internal', messageAr: typeof raw === 'string' ? raw : 'حدث خطأ غير متوقع' });
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const api = {
  // app & settings
  appStatus: () => call<AppStatus>('app_status'),
  unlock: (password: string) => call<AppStatus>('unlock', { password }),
  lock: () => call<void>('lock'),
  setLockPassword: (next: string | null, current?: string) => call<void>('set_lock_password', { current, next }),
  getSettings: () => call<Settings>('get_settings'),
  updateSettings: (patch: Partial<Settings>) => call<Settings>('update_settings', { patch }),
  openDataDir: () => call<void>('open_data_dir'),

  // dashboard
  dashboardSummary: (period: Period) => call<DashboardSummary>('dashboard_summary', { period }),

  // customers
  customersList: (q: { search?: string; active?: boolean; hasPending?: boolean } = {}) => call<Customer[]>('customers_list', q),
  customerGet: (id: number) => call<Customer>('customer_get', { id }),
  customerCreate: (input: CustomerInput) => call<Customer>('customer_create', { input }),
  customerUpdate: (id: number, input: CustomerInput) => call<Customer>('customer_update', { id, input }),
  customerSetActive: (id: number, active: boolean) => call<Customer>('customer_set_active', { id, active }),

  // transactions
  txnList: (filter: TxnFilter, sort: TxnSort, page: number, pageSize: number) =>
    call<TxnListResult>('txn_list', { filter, sort, page, pageSize }),
  txnCounts: (filter: Omit<TxnFilter, 'status'>) => call<TxnCounts>('txn_counts', { filter }),
  /** SPEC 6.3: every status, with where each transaction lives */
  txnSearchAll: (query: string, limit?: number) => call<TxnSearchHit[]>('txn_search_all', { query, limit }),
  txnGet: (id: number) => call<Transaction>('txn_get', { id }),
  txnHistory: (id: number) => call<HistoryItem[]>('txn_history', { id }),
  txnPreview: (q: { id: number; fee?: FeeInput; commission?: CommissionInput; customerId?: number }) =>
    call<TxnPreview>('txn_preview', q),
  txnCreateManual: (input: ManualTxnInput) => call<Transaction>('txn_create_manual', { input }),
  txnAssign: (id: number, customerId: number, commission?: CommissionInput, approve?: boolean) =>
    call<Transaction>('txn_assign', { id, customerId, commission, approve }),
  txnUnassign: (id: number) => call<Transaction>('txn_unassign', { id }),
  txnSetFee: (id: number, fee: FeeInput) => call<Transaction>('txn_set_fee', { id, fee }),
  txnSetCommission: (id: number, commission: CommissionInput) => call<Transaction>('txn_set_commission', { id, commission }),
  txnApprove: (id: number) => call<Transaction>('txn_approve', { id }),
  txnUnapprove: (id: number, reason: string) => call<Transaction>('txn_unapprove', { id, reason }),
  txnSetExcluded: (id: number, excluded: boolean) => call<Transaction>('txn_set_excluded', { id, excluded }),
  txnSetNote: (id: number, note: string | null) => call<Transaction>('txn_set_note', { id, note }),
  txnEditDetails: (id: number, input: { payerName?: string; payerEmail?: string; currency?: Currency; grossText?: string; occurredAt?: string }) =>
    call<Transaction>('txn_edit_details', { id, input }),
  txnConfirmReview: (id: number) => call<Transaction>('txn_confirm_review', { id }),
  txnBulk: (q: { action: 'assign' | 'approve' | 'unassign' | 'exclude'; ids: number[]; customerId?: number; commission?: CommissionInput }) =>
    call<BulkResult>('txn_bulk', q),

  // ledger
  ledgerBalances: (customerId: number) => call<BalanceCard[]>('ledger_balances', { customerId }),
  ledgerEntries: (customerId: number, currency: Currency, period?: Period) =>
    call<LedgerView>('ledger_entries', { customerId, currency, period }),
  ledgerAddPayout: (customerId: number, input: PayoutInput) => call<LedgerEntry>('ledger_add_payout', { customerId, input }),
  ledgerAddAdjustment: (customerId: number, input: AdjustmentInput) => call<LedgerEntry>('ledger_add_adjustment', { customerId, input }),
  ledgerReverseEntry: (entryId: number, reason: string) => call<LedgerEntry>('ledger_reverse_entry', { entryId, reason }),
  ledgerExportCsv: (customerId: number, currency: Currency, path: string, period?: Period) =>
    call<void>('ledger_export_csv', { customerId, currency, period, path }),
  ledgerStatement: (customerId: number, currency: Currency, period?: Period) =>
    call<{ customer: Customer; view: LedgerView; generatedAt: string }>('ledger_statement', { customerId, currency, period }),
  refundAlerts: () => call<RefundAlert[]>('refund_alerts'),
  refundConfirmReversal: (refundTxnId: number, amountText?: string) =>
    call<LedgerEntry>('refund_confirm_reversal', { refundTxnId, amountText }),
  refundDismiss: (refundTxnId: number) => call<void>('refund_dismiss', { refundTxnId }),

  // mail & pull
  mailboxList: () => call<Mailbox[]>('mailbox_list'),
  mailboxCreate: (input: MailboxInput) => call<Mailbox>('mailbox_create', { input }),
  mailboxUpdate: (id: number, input: MailboxInput) => call<Mailbox>('mailbox_update', { id, input }),
  mailboxSetPassword: (id: number, password: string) => call<void>('mailbox_set_password', { id, password }),
  mailboxSetActive: (id: number, active: boolean) => call<Mailbox>('mailbox_set_active', { id, active }),
  mailboxTest: (q: { id: number } | { input: MailboxInput }) => call<{ ok: true; folderCount: number }>('mailbox_test', q),
  mailboxDelete: (id: number) => call<void>('mailbox_delete', { id }),
  pullStart: (mailboxId: number, range?: PullRange) => call<PullRun>('pull_start', { mailboxId, range }),
  pullCancel: (runId: number) => call<void>('pull_cancel', { runId }),
  pullRunsList: (limit: number) => call<PullRun[]>('pull_runs_list', { limit }),

  // emails
  emailsList: (q: { status: ParseStatus; search?: string; page: number; pageSize: number }) =>
    call<Page<RawEmailSummary>>('emails_list', q),
  emailGet: (id: number) => call<RawEmail>('email_get', { id }),
  emailReparse: (ids: number[]) => call<BulkResult>('email_reparse', { ids }),
  emailSetIgnored: (id: number) => call<void>('email_set_ignored', { id }),
  paypalDomainTrust: (domain: string) => call<{ domain: string; reparsed: BulkResult }>('paypal_domain_trust', { domain }),
  unknownPaypalDomains: () => call<{ domain: string; count: number }[]>('unknown_paypal_domains'),

  // backup
  backupNow: () => call<BackupFile>('backup_now'),
  backupList: () => call<BackupFile[]>('backup_list'),
  backupRestore: (path: string) => call<void>('backup_restore', { path }),

  // delete (SPEC 4.7)
  txnDeletePreview: (ids: number[]) => call<{ count: number; approvedCount: number; ledgerEntryCount: number; effects: DeleteEffect[] }>('txn_delete_preview', { ids }),
  txnDelete: (ids: number[], reason?: string) => call<BulkResult & { backup: BackupFile | null }>('txn_delete', { ids, reason }),
  customerDeletePreview: (id: number) => call<{ assignedCount: number; approvedCount: number; ledgerEntryCount: number; balances: Money[] }>('customer_delete_preview', { id }),
  customerDelete: (id: number, confirmName: string) => call<{ backup: BackupFile | null }>('customer_delete', { id, confirmName }),
  ledgerDeletePreview: (entryId: number) => call<{ entries: LedgerEntry[]; balanceBeforeMinor: number; balanceAfterMinor: number }>('ledger_delete_preview', { entryId }),
  ledgerDeleteEntry: (entryId: number, reason?: string) => call<{ backup: BackupFile | null }>('ledger_delete_entry', { entryId, reason }),
  dataResetPreview: (scope: ResetScope) => call<ResetPreview>('data_reset_preview', { scope }),
  dataReset: (scope: ResetScope, confirmText: string) => call<{ backup: BackupFile }>('data_reset', { scope, confirmText }),

  // excel (SPEC 6.8)
  excelSetPath: (path: string) => call<Settings>('excel_set_path', { path }),
  excelUpdate: () => call<ExcelExportResult>('excel_update'),
  excelExportTransactions: (filter: TxnFilter, sort: TxnSort, path: string) => call<ExcelExportResult>('excel_export_transactions', { filter, sort, path }),
  excelExportLedger: (customerId: number, path: string, currency?: Currency, period?: Period) =>
    call<ExcelExportResult>('excel_export_ledger', { customerId, currency, period, path }),
  openPath: (path: string) => call<void>('open_path', { path }),

  // statement and linked payouts (SPEC 4.8, 6.5)
  customerSummary: (customerId: number, currency: Currency) => call<CustomerSummary>('customer_summary', { customerId, currency }),
  customerStatement: (customerId: number, currency: Currency, filter?: StatementFilter) =>
    call<{ openingBalanceMinor: Minor; rows: StatementRow[]; closingBalanceMinor: Minor }>('customer_statement', { customerId, currency, filter }),
  payoutPrepare: (customerId: number, currency: Currency, selection: PayoutSelection) =>
    call<PayoutPreparation>('payout_prepare', { customerId, currency, selection }),
  payoutCreate: (input: {
    customerId: number; currency: Currency; txnIds: number[]; returnedEntryIds: number[]; amountText?: string; differenceReason?: string;
    date: string; details: PayoutDetails; status: 'draft' | 'sent'; matchedConfirmed: true;
  }) => call<Payout>('payout_create', input),
  payoutMarkSent: (payoutId: number, date?: string) => call<Payout>('payout_mark_sent', { payoutId, date }),
  payoutUpdateDetails: (payoutId: number, details: PayoutDetails) => call<Payout>('payout_update_details', { payoutId, details }),
  payoutCancel: (payoutId: number, reason: string) => call<Payout>('payout_cancel', { payoutId, reason }),
  payoutsList: (customerId: number, currency: Currency) => call<Payout[]>('payouts_list', { customerId, currency }),
  payoutDefaults: (customerId: number) => call<PayoutDetails | null>('payout_defaults', { customerId }),
  payoutPlatformSuggestions: () => call<string[]>('payout_platform_suggestions'),
  txnSetMatched: (ids: number[], matched: boolean) => call<BulkResult>('txn_set_matched', { ids, matched }),

  // the customer's Excel statement (SPEC 6.8.2)
  customerExcelGet: (customerId: number) => call<CustomerExcel | null>('customer_excel_get', { customerId }),
  customerExcelCreate: (customerId: number, path: string, includeExisting: boolean) =>
    call<{ path: string; added: number; sheets: string[] }>('customer_excel_create', { customerId, path, includeExisting }),
  customerExcelLink: (customerId: number, path: string) => call<CustomerExcel>('customer_excel_link', { customerId, path }),
  customerExcelUnlink: (customerId: number) => call<void>('customer_excel_unlink', { customerId }),
  customerExcelSetDefault: (customerId: number, addToExcelByDefault: boolean) =>
    call<CustomerExcel>('customer_excel_set_default', { customerId, addToExcelByDefault }),
  customerExcelPreview: (customerId: number, items: CustomerExcelItemRef[]) =>
    call<CustomerExcelPreview>('customer_excel_preview', { customerId, items }),
  // auto-sync and export status (SPEC 6.8.3)
  customerExcelSetAuto: (customerId: number, autoSync: boolean) => call<CustomerExcel>('customer_excel_set_auto', { customerId, autoSync }),
  customerExcelSendUnexported: (customerId: number) =>
    call<{ path: string; added: number; skippedDuplicates: number; stillPending: number }>('customer_excel_send_unexported', { customerId }),
  customerExcelUnexportedSummary: () =>
    call<{ customerId: number; customerName: string; pending: number; notExported: number; lastError: AppError | null }[]>('customer_excel_unexported_summary'),
  customerExcelAdd: (customerId: number, items: CustomerExcelItemRef[]) =>
    call<{ path: string; added: number; skippedDuplicates: number; sheets: string[] }>('customer_excel_add', { customerId, items }),
};

export const events = {
  onPullProgress: (fn: (run: PullRun) => void): Promise<UnlistenFn> => listen<PullRun>('pull://progress', (e) => fn(e.payload)),
  onPullFinished: (fn: (run: PullRun) => void): Promise<UnlistenFn> => listen<PullRun>('pull://finished', (e) => fn(e.payload)),
  /** after each background write to a customer's Excel statement (SPEC 6.8.3) */
  onCustomerExcelSynced: (fn: (e: { customerId: number; added: number; pending: number; error: AppError | null }) => void): Promise<UnlistenFn> =>
    listen<{ customerId: number; added: number; pending: number; error: AppError | null }>('customer-excel://synced', (e) => fn(e.payload)),
};

// Native dialogs and links (plugin-dialog / plugin-opener, contract §4).

export const native = {
  saveCsv: (defaultPath: string) => saveDialog({ defaultPath, filters: [{ name: 'CSV', extensions: ['csv'] }] }),
  saveXlsx: (defaultPath: string) => saveDialog({ defaultPath, filters: [{ name: 'Excel', extensions: ['xlsx'] }] }),
  pickFolder: () => openDialog({ directory: true, multiple: false }) as Promise<string | null>,
  pickXlsx: () => openDialog({ multiple: false, filters: [{ name: 'Excel', extensions: ['xlsx'] }] }) as Promise<string | null>,
  pickBackupFile: () => openDialog({ multiple: false, filters: [{ name: 'PpFeez backup', extensions: ['db', 'sqlite', 'bak'] }] }) as Promise<string | null>,
  openUrl: (url: string) => openUrl(url),
};
