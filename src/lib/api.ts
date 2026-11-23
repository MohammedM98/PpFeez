// The only place the UI talks to the backend (docs/UI-CONTRACT.md §1).
// Pages import `api` and never call `invoke` themselves.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AdjustmentInput, AppError, AppStatus, BackupFile, BalanceCard, BulkResult, CommissionInput,
  Customer, CustomerInput, DashboardSummary, ErrorCode, FeeInput, HistoryItem, LedgerEntry,
  LedgerView, Mailbox, MailboxInput, ManualTxnInput, Page, PayoutInput, Period, PullRun,
  RawEmail, RawEmailSummary, ParseStatus, RefundAlert, Settings, Transaction, TxnCounts,
  TxnFilter, TxnListResult, TxnPreview, TxnSort, Currency,
} from './contract';

const KNOWN_CODES = new Set<ErrorCode>([
  'locked', 'wrong_password', 'too_many_attempts', 'not_found', 'validation', 'invalid_amount',
  'invalid_transition', 'fee_required', 'commission_exceeds_net', 'customer_inactive', 'duplicate',
  'already_reversed', 'has_dependents', 'imap_auth', 'imap_connect', 'imap_disabled', 'pull_running',
  'backup_failed', 'restore_failed', 'internal',
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
  customersList: (q: { search?: string; active?: boolean } = {}) => call<Customer[]>('customers_list', q),
  customerGet: (id: number) => call<Customer>('customer_get', { id }),
  customerCreate: (input: CustomerInput) => call<Customer>('customer_create', { input }),
  customerUpdate: (id: number, input: CustomerInput) => call<Customer>('customer_update', { id, input }),
  customerSetActive: (id: number, active: boolean) => call<Customer>('customer_set_active', { id, active }),

  // transactions
  txnList: (filter: TxnFilter, sort: TxnSort, page: number, pageSize: number) =>
    call<TxnListResult>('txn_list', { filter, sort, page, pageSize }),
  txnCounts: (filter: Omit<TxnFilter, 'status'>) => call<TxnCounts>('txn_counts', { filter }),
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
  mailboxTest: (q: { id: number } | { input: MailboxInput }) => call<{ ok: true; folderCount: number }>('mailbox_test', q),
  mailboxDelete: (id: number) => call<void>('mailbox_delete', { id }),
  pullStart: (mailboxId: number) => call<PullRun>('pull_start', { mailboxId }),
  pullCancel: (runId: number) => call<void>('pull_cancel', { runId }),
  pullRunsList: (limit: number) => call<PullRun[]>('pull_runs_list', { limit }),

  // emails
  emailsList: (q: { status: ParseStatus; search?: string; page: number; pageSize: number }) =>
    call<Page<RawEmailSummary>>('emails_list', q),
  emailGet: (id: number) => call<RawEmail>('email_get', { id }),
  emailReparse: (ids: number[]) => call<BulkResult>('email_reparse', { ids }),
  emailSetIgnored: (id: number) => call<void>('email_set_ignored', { id }),

  // backup
  backupNow: () => call<BackupFile>('backup_now'),
  backupList: () => call<BackupFile[]>('backup_list'),
  backupRestore: (path: string) => call<void>('backup_restore', { path }),
};

export const events = {
  onPullProgress: (fn: (run: PullRun) => void): Promise<UnlistenFn> => listen<PullRun>('pull://progress', (e) => fn(e.payload)),
  onPullFinished: (fn: (run: PullRun) => void): Promise<UnlistenFn> => listen<PullRun>('pull://finished', (e) => fn(e.payload)),
};
