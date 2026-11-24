// Copied verbatim from docs/UI-CONTRACT.md §3. Change the contract first, then this file.
// Command signatures are documented as comments; typed wrappers live in ./api.ts.

// ===== عام =====
export type Minor = number;            // integer minor units
export type Currency = string;         // "USD", "EUR", ...
export type IsoDate = string;          // ISO-8601 UTC
export type Period = { from?: string; to?: string }; // YYYY-MM-DD
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
export type Money = { minor: Minor; currency: Currency };
export type BulkResult = { ok: number[]; failed: { id: number; code: ErrorCode; messageAr: string }[] };

export type ErrorCode =
  | 'locked' | 'wrong_password' | 'too_many_attempts'
  | 'not_found' | 'validation' | 'invalid_amount'
  | 'invalid_transition' | 'fee_required' | 'commission_exceeds_net'
  | 'customer_inactive' | 'duplicate'
  | 'already_reversed' | 'has_dependents'
  | 'imap_auth' | 'imap_connect' | 'imap_disabled' | 'pull_running' | 'invalid_range'
  | 'backup_failed' | 'restore_failed'
  | 'file_locked' | 'no_export_path' | 'export_failed'
  | 'internal';
export type AppError = { code: ErrorCode; messageAr: string; field?: string };

// ===== التطبيق والإعدادات =====
export type AppStatus = {
  version: string;
  locked: boolean;          // true => اعرض شاشة القفل
  lockEnabled: boolean;
  onboardingDone: boolean;  // false => اعرض المعالج
  dataDir: string;
  lockedUntil?: IsoDate;    // بعد 5 محاولات خاطئة
};
export type Theme = 'dark' | 'light' | 'system';
export type Settings = {
  theme: Theme;
  defaultCommissionBps: number;
  feeEstimateEnabled: boolean;
  feeEstimateBps: number;
  feeEstimateFixedMinor: Minor;      // بعملة المعاملة نفسها
  backupDir: string | null;
  backupOnClose: boolean;
  backupKeep: number;
  autoLockMinutes: number | null;
  onboardingDone: boolean;
  excelExportPath: string | null;     // الملف الرئيسي (SPEC §6.8)
  excelLastExportedAt: IsoDate | null;
  excelUpdateOnClose: boolean;
  autoCheckUpdates: boolean;          // SPEC §6.9، افتراضي true
  extraPaypalDomains: string[];       // SPEC §5.6، نطاقات يضيفها المدير
  builtinPaypalDomains: string[];     // للقراءة فقط (update_settings يتجاهله)
};

// app_status(): AppStatus
// unlock({ password }): AppStatus                          throws wrong_password | too_many_attempts
// lock(): void
// set_lock_password({ current?: string, next: string | null }): void   // null = تعطيل القفل
// get_settings(): Settings
// update_settings({ patch: Partial<Settings> }): Settings
// open_data_dir(): void

// ===== لوحة التحكم =====
export type CurrencySummary = {
  currency: Currency;
  grossMinor: Minor;            // إجمالي الوارد (معاملات payment في الفترة، غير المستبعدة)
  feeMinor: Minor;              // الرسوم المعروفة
  commissionMinor: Minor;       // عمولتي من المعتمد في الفترة
  owedToCustomersMinor: Minor;  // مجموع أرصدة العملاء الحالية (لا يتأثر بالفترة)
  paidOutMinor: Minor;          // الدفعات في الفترة (موجب)
};
export type DashboardSummary = {
  counts: { unassigned: number; needsFee: number; pendingApproval: number; refundAlerts: number; needsReview: number; unknownPaypalDomains: number };
  byCurrency: CurrencySummary[];
  topCustomers: { customerId: number; name: string; balance: Money }[]; // أعلى 5 لكل عملة
  lastPull: PullRun | null;
};
// dashboard_summary({ period }): DashboardSummary

// ===== العملاء =====
export type Customer = {
  id: number;
  name: string;
  phone: string | null;
  defaultCommissionBps: number;
  notes: string | null;
  isActive: boolean;
  balances: Money[];          // رصيد لكل عملة (سالب = عليه)
  pendingCount: number;       // معاملات بانتظار الموافقة
  createdAt: IsoDate;
};
export type CustomerInput = {
  name: string; phone?: string | null; defaultCommissionBps: number; notes?: string | null; isActive?: boolean;
};
// customers_list({ search?: string, active?: boolean }): Customer[]
// customer_get({ id }): Customer
// customer_create({ input: CustomerInput }): Customer          throws duplicate (field: name)
// customer_update({ id, input: CustomerInput }): Customer
// customer_set_active({ id, active: boolean }): Customer

// ===== المعاملات =====
export type TxnStatus = 'unassigned' | 'pending_approval' | 'approved' | 'excluded';
export type TxnType = 'payment' | 'refund' | 'reversal';
export type CommissionMode = 'percent' | 'fixed';
export type Transaction = {
  id: number;
  source: 'email' | 'manual';
  paypalTxnId: string;
  relatedTxnId: string | null;
  type: TxnType;
  payerName: string | null;
  payerEmail: string | null;
  payerNote: string | null;
  currency: Currency;
  grossMinor: Minor;
  feeMinor: Minor | null;        // null => "تحتاج رسوم"
  netMinor: Minor | null;
  feeIsEstimated: boolean;
  occurredAt: IsoDate;
  status: TxnStatus;
  customer: { id: number; name: string } | null;
  commissionMode: CommissionMode | null;
  commissionBps: number | null;
  commissionMinor: Minor | null;
  customerAmountMinor: Minor | null;
  assignedAt: IsoDate | null;
  approvedAt: IsoDate | null;
  note: string | null;
  mailbox: { id: number; label: string } | null;
  rawEmailId: number | null;
  refundedBy: { id: number; type: TxnType; grossMinor: Minor }[]; // استردادات مرتبطة
  allowedActions: TxnAction[];   // ما يُعرض في قائمة ⋯ (القلب هو المرجع)
  needsReview: boolean;          // SPEC §5.3: من المحلّل العام، لا يُعتمد قبل التأكيد
  reviewReasonAr: string | null;
  holdStatus: 'pending_echeck' | 'on_hold' | null;
};
export type TxnAction =
  | 'assign' | 'unassign' | 'set_fee' | 'set_commission' | 'approve'
  | 'unapprove' | 'exclude' | 'include' | 'edit_note' | 'confirm_review' | 'edit_details';
export type TxnFilter = {
  status?: TxnStatus | 'all';
  search?: string;               // المرسل، الإيميل، رقم المعاملة، ملاحظة المرسل
  currency?: Currency;
  mailboxId?: number;
  customerId?: number;
  period?: Period;
  needsFeeOnly?: boolean;
  needsReviewOnly?: boolean;
  type?: TxnType;
};
export type TxnSortKey = 'occurredAt' | 'payerName' | 'grossMinor' | 'feeMinor' | 'netMinor' | 'customerAmountMinor' | 'status';
export type TxnSort = { key: TxnSortKey; dir: 'asc' | 'desc' };
export type TxnListResult = Page<Transaction> & {
  totals: { currency: Currency; grossMinor: Minor; feeMinor: Minor; netMinor: Minor; customerAmountMinor: Minor; count: number }[]; // للمعروض بالفلتر (كل الصفحات)
};
export type TxnCounts = Record<TxnStatus | 'all' | 'needsFee' | 'needsReview', number>;
export type ManualTxnInput = {
  occurredAt: string;            // YYYY-MM-DD HH:mm بتوقيت الجهاز
  payerName?: string; payerEmail?: string; payerNote?: string;
  currency: Currency;
  grossText: string;
  feeText?: string;              // فارغ => تحتاج رسوم
  paypalTxnId?: string;          // فارغ => MANUAL-…
  note?: string;
  rawEmailId?: number;           // عند الإنشاء من رسالة فاشلة
};
export type FeeInput =
  | { kind: 'fee'; feeText: string }
  | { kind: 'net'; netText: string }
  | { kind: 'zero' }
  | { kind: 'accept_estimate' };
export type CommissionInput =
  | { mode: 'percent'; bps: number }
  | { mode: 'fixed'; amountText: string };
export type TxnPreview = {        // معاينة بلا حفظ
  feeMinor: Minor | null;         // الرسوم الناتجة (مهمة حين يُدخل الصافي: kind 'net')
  netMinor: Minor | null; commissionMinor: Minor | null; customerAmountMinor: Minor | null;
  feeEstimateMinor: Minor | null; // إن كان التقدير مفعّلاً والرسوم فارغة
  error?: AppError;
};
export type HistoryItem = { id: number; action: string; labelAr: string; details: Record<string, unknown>; createdAt: IsoDate };

// txn_list({ filter: TxnFilter, sort: TxnSort, page: number, pageSize: number }): TxnListResult
// txn_counts({ filter: Omit<TxnFilter,'status'> }): TxnCounts
// txn_get({ id }): Transaction
// txn_history({ id }): HistoryItem[]
// txn_preview({ id, fee?: FeeInput, commission?: CommissionInput, customerId?: number }): TxnPreview
// txn_create_manual({ input: ManualTxnInput }): Transaction
// txn_assign({ id, customerId, commission?: CommissionInput, approve?: boolean }): Transaction
// txn_unassign({ id }): Transaction
// txn_set_fee({ id, fee: FeeInput }): Transaction
// txn_set_commission({ id, commission: CommissionInput }): Transaction
// txn_approve({ id }): Transaction                    throws fee_required | invalid_transition
// txn_unapprove({ id, reason: string }): Transaction
// txn_set_excluded({ id, excluded: boolean }): Transaction
// txn_set_note({ id, note: string | null }): Transaction
// txn_edit_details({ id, input: { payerName?: string; payerEmail?: string; currency?: Currency; grossText?: string; occurredAt?: string } }): Transaction  // فقط needsReview أو غير مخصّصة
// txn_confirm_review({ id }): Transaction                    // يزيل needsReview
// txn_bulk({ action: 'assign'|'approve'|'unassign'|'exclude', ids: number[], customerId?: number, commission?: CommissionInput }): BulkResult

// ===== الدفتر =====
export type LedgerType = 'credit' | 'payout' | 'adjustment' | 'reversal';
export type PayoutMethod = 'cash' | 'bank' | 'usdt' | 'paypal' | 'other';
export type LedgerEntry = {
  id: number;
  customerId: number;
  currency: Currency;
  type: LedgerType;
  amountMinor: Minor;            // موجب = له، سالب = عليه/دُفع
  runningBalanceMinor: Minor;    // يحسبه القلب
  transactionId: number | null;
  reversesEntryId: number | null;
  reversedByEntryId: number | null; // إن كان معكوساً => اعرضه مشطوباً
  payoutMethod: PayoutMethod | null;
  reference: string | null;
  description: string;
  entryDate: string;             // YYYY-MM-DD
  createdAt: IsoDate;
};
export type BalanceCard = { currency: Currency; creditsMinor: Minor; debitsMinor: Minor; balanceMinor: Minor };
export type LedgerView = { openingBalanceMinor: Minor; entries: LedgerEntry[]; closingBalanceMinor: Minor };
export type PayoutInput = { currency: Currency; amountText: string; entryDate: string; method: PayoutMethod; reference?: string; description?: string; confirmOverdraw?: boolean };
export type AdjustmentInput = { currency: Currency; amountText: string; direction: 'credit' | 'debit'; entryDate: string; description: string };
export type RefundAlert = {
  refundTxn: Transaction;
  originalTxn: Transaction;
  suggestedReversalMinor: Minor;  // سالب
  customer: { id: number; name: string };
};

// ledger_balances({ customerId }): BalanceCard[]
// ledger_entries({ customerId, currency, period?: Period }): LedgerView
// ledger_add_payout({ customerId, input: PayoutInput }): LedgerEntry   throws validation (code 'validation', field 'overdraw') إن تجاوزت الرصيد بلا confirmOverdraw
// ledger_add_adjustment({ customerId, input: AdjustmentInput }): LedgerEntry
// ledger_reverse_entry({ entryId, reason }): LedgerEntry               throws already_reversed
// ledger_export_csv({ customerId, currency, period?, path }): void     // path من نافذة الحفظ (plugin-dialog)
// ledger_statement({ customerId, currency, period? }): { customer: Customer; view: LedgerView; generatedAt: IsoDate } // للطباعة/PDF من الواجهة
// refund_alerts(): RefundAlert[]
// refund_confirm_reversal({ refundTxnId, amountText?: string }): LedgerEntry   // بلا amountText => المقترح
// refund_dismiss({ refundTxnId }): void

// ===== البريد والسحب =====
export type Mailbox = {
  id: number; label: string; email: string; host: string; port: number; folder: string;
  isActive: boolean; hasPassword: boolean; lastPulledAt: IsoDate | null; lastUid: number;
  running: boolean;
};
export type MailboxInput = { label: string; email: string; host?: string; port?: number; folder?: string; password?: string };
export type PullStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type PullRange =                       // SPEC §5.5
  | { kind: 'new' }                           // منذ آخر سحب (الافتراضي)
  | { kind: 'last_days'; days: number }       // 1..3650 (الواجهة تعرض 7/30/90)
  | { kind: 'between'; from: string; to: string } // YYYY-MM-DD شاملة بتوقيت الجهاز
  | { kind: 'all' };
export type PullRun = {
  id: number; mailboxId: number; mailboxLabel: string; status: PullStatus;
  totalCount: number; fetchedCount: number; newTransactionsCount: number;
  duplicateCount: number; ignoredCount: number; failedCount: number;
  error: string | null; startedAt: IsoDate; finishedAt: IsoDate | null;
  range: PullRange;
};
// mailbox_list(): Mailbox[]
// mailbox_create({ input: MailboxInput }): Mailbox
// mailbox_update({ id, input: MailboxInput }): Mailbox
// mailbox_set_password({ id, password }): void
// mailbox_set_active({ id, active: boolean }): Mailbox   // "إيقاف"/تفعيل البريد (SPEC §6.7)؛ السحب يُرفض لبريد موقوف
// mailbox_test({ id } | { input: MailboxInput }): { ok: true; folderCount: number }   throws imap_auth | imap_connect | imap_disabled
// mailbox_delete({ id }): void                   throws has_dependents
// pull_start({ mailboxId, range?: PullRange }): PullRun   // بلا range => { kind: 'new' }   throws pull_running | invalid_range
// pull_cancel({ runId }): void
// pull_runs_list({ limit }): PullRun[]
// events:
//   'pull://progress' payload: PullRun   (بعد كل دفعة)
//   'pull://finished' payload: PullRun

// ===== الرسائل =====
export type ParseStatus = 'parsed' | 'failed' | 'ignored';
export type RawEmailSummary = {
  id: number; mailboxLabel: string; fromAddr: string; subject: string; receivedAt: IsoDate;
  parseStatus: ParseStatus; parseReason: string | null; parseReasonAr: string | null;
  transactionId: number | null;
};
export type RawEmail = RawEmailSummary & { bodyHtml: string | null; bodyText: string | null; parserName: string | null };
// emails_list({ status: ParseStatus, search?: string, page, pageSize }): Page<RawEmailSummary>
// email_get({ id }): RawEmail       // bodyHtml يُعرض في iframe sandbox بلا سكربتات ولا موارد خارجية
// email_reparse({ ids }): BulkResult
// email_set_ignored({ id }): void
// paypal_domain_trust({ domain }): { domain: string; reparsed: BulkResult }   // SPEC §5.6: يضيفه لـ extraPaypalDomains ويعيد تحليل رسائله المتجاهلة بسبب unknown_paypal_domain
// unknown_paypal_domains(): { domain: string; count: number }[]                // لتنبيه لوحة التحكم

// ===== النسخ الاحتياطي =====
export type BackupFile = { path: string; createdAt: IsoDate; sizeBytes: number };
// backup_now(): BackupFile           throws backup_failed (مثلاً لا مجلد محدد)
// backup_list(): BackupFile[]
// backup_restore({ path }): void      // يأخذ نسخة من الحالية ثم يعيد تشغيل التطبيق

// ===== Excel (SPEC §6.8) =====
export type ExcelExportResult = { path: string; sheets: number; rows: number; exportedAt: IsoDate };
// excel_set_path({ path }): Settings                    // المسار من نافذة الحفظ
// excel_update(): ExcelExportResult                     // يعيد كتابة الملف الرئيسي   throws no_export_path | file_locked | export_failed
// excel_export_transactions({ filter: TxnFilter, sort: TxnSort, path }): ExcelExportResult
// excel_export_ledger({ customerId, currency?: Currency, period?: Period, path }): ExcelExportResult  // بلا currency => ورقة لكل عملة
// open_path({ path }): void                             // فتح الملف في Excel
