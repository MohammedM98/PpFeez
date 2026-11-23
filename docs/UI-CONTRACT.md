# PpFeez — عقد الواجهة ⇄ القلب (UI Contract)

هذا الملف هو **الحدّ الفاصل** بين جلستي العمل:

| الجلسة | تملك | لا تلمس |
|---|---|---|
| **القلب (Backend)** | `src-tauri/**` (Rust، القاعدة، البريد، الأوامر) | `src/**`، `e2e/**`، ملفات الواجهة في الجذر |
| **الواجهة (UI)** | `src/**`، `e2e/**`، `index.html`، `package.json`، `vite.config.ts`، `tsconfig*.json`، إعدادات Tailwind/المكوّنات | `src-tauri/**` |

- الفرع المشترك: **`desktop`**. قبل كل push: `git pull --rebase origin desktop`.
- `src/lib/contract.ts` يُكتب حرفياً من القسم 3 أدناه، وتملكه جلسة الواجهة. أي تغيير في العقد يُعدَّل **هنا أولاً** ثم في الجهتين، ويُذكر في رسالة الـ commit بعبارة `contract:`.
- المواصفات الكاملة (القواعد المحاسبية، السلوك) في `docs/SPEC.md`. عند أي تعارض في **الشكل** فهذا الملف هو المرجع؛ وفي **القواعد** فـ SPEC هو المرجع.

---

## 1. الربط التقني

- خادم تطوير الواجهة: Vite على المنفذ **1420** (`strictPort: true`)، والبناء إلى **`dist/`**.
- `src-tauri/tauri.conf.json`: `build.devUrl = "http://localhost:1420"`، `build.frontendDist = "../dist"`، `beforeDevCommand = "npm run dev"`، `beforeBuildCommand = "npm run build"`.
- الواجهة تستدعي القلب **فقط** عبر `src/lib/api.ts` (غلاف حول `invoke` من `@tauri-apps/api/core`). لا `invoke` مباشر في الصفحات.
- الأحداث عبر `listen` من `@tauri-apps/api/event`.
- **وضع المتصفح بلا Tauri**: الواجهة تعمل بـ `npm run dev` في المتصفح العادي باستخدام `mockIPC` من `@tauri-apps/api/mocks` وبيانات وهمية في `src/mocks/` (تُفعَّل حين `!window.__TAURI_INTERNALS__`). هكذا تُصمَّم الواجهة كاملة قبل جاهزية القلب.
- أسماء الأوامر snake_case، ومعاملاتها تُرسل camelCase (سلوك Tauri الافتراضي)، وكل الحقول المعادة camelCase (`#[serde(rename_all = "camelCase")]`).

## 2. اصطلاحات البيانات

- **المبالغ**: `number` صحيح بأصغر وحدة (سنت) + `currency` (ISO-4217). الواجهة لا تجري حسابات مالية أبداً؛ تعرض وتنسّق فقط. المعاينة الحية في نافذة التخصيص تستدعي `txn_preview`.
- **إدخال المبالغ**: الواجهة ترسل النص كما كتبه المستخدم (`"95.50"`) في حقول `…Text`، والقلب يحلّله ويعيد خطأ `invalid_amount` إن لزم.
- **النسب**: basis points (`2500` = 25%).
- **التواريخ**: نص ISO-8601 UTC. الفترات `{ from?: string; to?: string }` بصيغة `YYYY-MM-DD` (شاملة، بتوقيت الجهاز).
- **الأخطاء**: كل أمر قد يرمي `AppError`؛ الواجهة تعرض `messageAr` في toast، وتستخدم `code` للسلوك الخاص.

## 3. الأنواع والأوامر (`src/lib/contract.ts`)

```ts
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
  | 'imap_auth' | 'imap_connect' | 'imap_disabled' | 'pull_running'
  | 'backup_failed' | 'restore_failed' | 'internal';
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
  counts: { unassigned: number; needsFee: number; pendingApproval: number; refundAlerts: number };
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
};
export type TxnAction =
  | 'assign' | 'unassign' | 'set_fee' | 'set_commission' | 'approve'
  | 'unapprove' | 'exclude' | 'include' | 'edit_note';
export type TxnFilter = {
  status?: TxnStatus | 'all';
  search?: string;               // المرسل، الإيميل، رقم المعاملة، ملاحظة المرسل
  currency?: Currency;
  mailboxId?: number;
  customerId?: number;
  period?: Period;
  needsFeeOnly?: boolean;
  type?: TxnType;
};
export type TxnSortKey = 'occurredAt' | 'payerName' | 'grossMinor' | 'feeMinor' | 'netMinor' | 'customerAmountMinor' | 'status';
export type TxnSort = { key: TxnSortKey; dir: 'asc' | 'desc' };
export type TxnListResult = Page<Transaction> & {
  totals: { currency: Currency; grossMinor: Minor; feeMinor: Minor; netMinor: Minor; customerAmountMinor: Minor; count: number }[]; // للمعروض بالفلتر (كل الصفحات)
};
export type TxnCounts = Record<TxnStatus | 'all' | 'needsFee', number>;
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
export type PullRun = {
  id: number; mailboxId: number; mailboxLabel: string; status: PullStatus;
  totalCount: number; fetchedCount: number; newTransactionsCount: number;
  duplicateCount: number; ignoredCount: number; failedCount: number;
  error: string | null; startedAt: IsoDate; finishedAt: IsoDate | null;
};
// mailbox_list(): Mailbox[]
// mailbox_create({ input: MailboxInput }): Mailbox
// mailbox_update({ id, input: MailboxInput }): Mailbox
// mailbox_set_password({ id, password }): void
// mailbox_set_active({ id, active: boolean }): Mailbox   // "إيقاف"/تفعيل البريد (SPEC §6.7)؛ السحب يُرفض لبريد موقوف
// mailbox_test({ id } | { input: MailboxInput }): { ok: true; folderCount: number }   throws imap_auth | imap_connect | imap_disabled
// mailbox_delete({ id }): void                   throws has_dependents
// pull_start({ mailboxId }): PullRun              throws pull_running
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

// ===== النسخ الاحتياطي =====
export type BackupFile = { path: string; createdAt: IsoDate; sizeBytes: number };
// backup_now(): BackupFile           throws backup_failed (مثلاً لا مجلد محدد)
// backup_list(): BackupFile[]
// backup_restore({ path }): void      // يأخذ نسخة من الحالية ثم يعيد تشغيل التطبيق
```

## 4. ما تحتاجه الواجهة من إضافات Tauri

يضيفها القلب في `src-tauri` ويفعّل صلاحياتها في `capabilities/`:
- `@tauri-apps/plugin-dialog` — اختيار مجلد النسخ، مسار حفظ CSV، ملف الاستعادة.
- `@tauri-apps/plugin-opener` — فتح روابط Google لإنشاء كلمة مرور التطبيق، وفتح مجلد البيانات.
- الطباعة/PDF: الواجهة تعرض صفحة كشف الحساب وتستدعي `window.print()`.

## 5. متطلبات الواجهة الثابتة (غير قابلة للنقاش في جلسة التصميم)

- عربية فقط، `dir="rtl"`، الشريط الجانبي على اليمين.
- الأرقام لاتينية، والمبالغ تُعرض داخل `<bdi dir="ltr">` بالشكل `1,250.00 USD` (العملات بلا كسور: `JPY, HUF, TWD`).
- وضع داكن وفاتح وحسب النظام.
- النافذة بحد أدنى 1100×700.
- كل عملية تمسّ المال (اعتماد، إلغاء اعتماد، دفعة، تسوية، عكس قيد، استعادة نسخة) تطلب تأكيداً يعرض المبلغ.
- الشاشات وما تعرضه وتفعله: `docs/SPEC.md` القسم 6. **الشكل والأسلوب والألوان والخطوط والتخطيط** متروكة لجلسة التصميم وصاحب المشروع.
