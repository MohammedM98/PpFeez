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
  | 'imap_auth' | 'imap_connect' | 'imap_disabled' | 'pull_running' | 'invalid_range'
  | 'not_deletable' | 'confirm_mismatch' | 'excel_layout'
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
export type Theme = 'dark' | 'light' | 'system' | 'high_contrast';
export type Accent = 'blue' | 'emerald' | 'violet' | 'amber' | 'rose' | 'slate';   // SPEC §6.10
export type Density = 'comfortable' | 'regular' | 'compact';
export type Settings = {
  theme: Theme;
  accent: Accent;                     // SPEC §6.10، افتراضي 'blue'
  density: Density;                   // افتراضي 'regular'
  uiScale: number;                    // 90..150، افتراضي 100
  uiPrefs: string;                    // JSON تملكه الواجهة وحدها (أعمدة الجداول، طرق العرض المحفوظة، الشريط الجانبي...)؛ القلب يخزنه كما هو (حد 256KB)
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
  excelMode: 'append' | 'rewrite';    // SPEC §6.8.1، افتراضي 'append'
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
  excel: CustomerExcel | null; // SPEC §6.8.2
};
export type CustomerInput = {
  name: string; phone?: string | null; defaultCommissionBps: number; notes?: string | null; isActive?: boolean;
};
// customers_list({ search?: string, active?: boolean, hasPending?: boolean }): Customer[]
// customer_get({ id }): Customer
// customer_create({ input: CustomerInput }): Customer          throws duplicate (field: name)
// customer_update({ id, input: CustomerInput }): Customer
// customer_set_active({ id, active: boolean }): Customer
// customer_delete_preview({ id }): { assignedCount: number; approvedCount: number; ledgerEntryCount: number; balances: Money[] }   // SPEC §4.7
// customer_delete({ id, confirmName: string }): { backup: BackupFile | null }        throws confirm_mismatch

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
  inCustomerExcel: boolean;      // SPEC §6.8.2
  excelStatus: ExcelStatus;      // SPEC §6.8.3
  changedAfterExcel: boolean;    // أُضيفت ثم أُلغي اعتمادها
  customerSeq: number | null;    // SPEC §4.8: رقم الحوالة # لدى العميل (للمعتمدة)
  matched: boolean;              // المطابقة
  payout: { id: number; seq: number; status: 'draft' | 'sent' } | null;  // تم الإرسال؟
};
export type TxnAction =
  | 'assign' | 'unassign' | 'set_fee' | 'set_commission' | 'approve'
  | 'unapprove' | 'exclude' | 'include' | 'edit_note' | 'confirm_review' | 'edit_details' | 'delete' | 'set_matched';
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
  ids?: number[];                // يقصر النتيجة على هذه المعاملات: إجماليات تأكيد الاعتماد الجماعي لكل عملة (SPEC 6.5) من totals
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

// txn_list({ filter: TxnFilter, sort: TxnSort, page: number, pageSize: number }): TxnListResult   // pageSize حتى 500 (للتمرير الافتراضي)
//   الوارد (SPEC §6.3): filter.status = 'unassigned' | 'excluded' بلا customerId. صفحة العميل: customerId + status = 'pending_approval' | 'approved'.
export type TxnLocation =
  | { kind: 'inbox' } | { kind: 'excluded' }
  | { kind: 'customer'; customerId: number; customerName: string; status: 'pending_approval' | 'approved' };
export type TxnSearchHit = { txn: Transaction; location: TxnLocation };
// txn_search_all({ query: string, limit?: number }): TxnSearchHit[]   // كل الحالات؛ رقم المعاملة، المرسل، الإيميل، الملاحظة، أو مبلغ ("71.25")
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
export type DeleteEffect = { customerId: number; customerName: string; currency: Currency; balanceDeltaMinor: Minor }; // سالب = ينقص رصيده
// txn_delete_preview({ ids }): { count: number; approvedCount: number; ledgerEntryCount: number; effects: DeleteEffect[] }   // SPEC §4.7
// txn_delete({ ids, reason?: string }): BulkResult & { backup: BackupFile | null }
// txn_bulk({ action: 'assign'|'approve'|'unassign'|'exclude', ids: number[], customerId?: number, commission?: CommissionInput }): BulkResult

// ===== الدفتر =====
export type LedgerType = 'credit' | 'payout' | 'adjustment' | 'reversal';
export type PayoutMethod = 'usdt' | 'bank' | 'cash' | 'paypal' | 'wise' | 'western_union' | 'other';
export type PayoutDetails = { method: PayoutMethod; platform?: string | null; network?: string | null; destination?: string | null; reference?: string | null; note?: string | null };  // SPEC §4.8
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
  deletable: boolean;               // SPEC §4.7
  inCustomerExcel: boolean;         // SPEC §6.8.2
  excelStatus: ExcelStatus;         // SPEC §6.8.3
  notDeletableReasonAr: string | null;
  payoutMethod: PayoutMethod | null;
  payoutSeq: number | null;      // SPEC §4.9: رقم الدفعة ("دفعة N") لقيد دفعة، مستقلة أو مرتبطة؛ null لغيرها
  reference: string | null;
  description: string;
  entryDate: string;             // YYYY-MM-DD
  createdAt: IsoDate;
};
export type BalanceCard = { currency: Currency; creditsMinor: Minor; debitsMinor: Minor; balanceMinor: Minor };
export type LedgerView = { openingBalanceMinor: Minor; entries: LedgerEntry[]; closingBalanceMinor: Minor };
export type PayoutInput = { currency: Currency; amountText: string; entryDate: string; method: PayoutMethod; platform?: string; network?: string; destination?: string; reference?: string; description?: string; confirmOverdraw?: boolean };  // دفعة مستقلة (SPEC §4.9): description = الملاحظة؛ تأخذ الرقم التالي "دفعة N" وتحفظ آخر طريقة/منصة/شبكة/عنوان للعميل (payout_defaults)
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
// ledger_payout_preview({ customerId, currency, amountText?: string }): { balanceBeforeMinor: Minor; amountMinor: Minor; balanceAfterMinor: Minor; overdraw: boolean }
//   SPEC §4.9: الرصيد قبل/بعد في نافذة "تسجيل دفعة"؛ amountText فارغ ⇒ amountMinor 0؛ نص غير صالح ⇒ invalid_amount (field 'amountText')

// ===== الدفعات المرتبطة وكشف الحساب (SPEC §4.8، §6.5) =====
export type PayoutStatus = 'draft' | 'sent' | 'cancelled';
export type Payout = {
  id: number; customerId: number; currency: Currency; seq: number; status: PayoutStatus;
  amountMinor: Minor; dueMinor: Minor; date: string; rangeLabel: string;
  details: PayoutDetails; txnCount: number; cumulativePaidMinor: Minor;   // التراكمي حتى هذه الدفعة (المرسلة فقط)
  ledgerEntryId: number | null; itemIds: { txns: number[]; ledger: number[] }; inCustomerExcel: boolean; excelStatus: ExcelStatus; createdAt: IsoDate;
};
export type PayoutSelection = { kind: 'unpaid' } | { kind: 'range'; from: number; to: number } | { kind: 'ids'; txnIds: number[] };
export type PayoutPreparation = {
  included: Transaction[]; returned: LedgerEntry[];             // المرتجعات السالبة غير المسوّاة
  alreadyPaid: { txn: Transaction; payoutSeq: number }[];       // تنبيه التداخل (مستبعدة)
  excludedHeld: Transaction[];                                  // معلّقة/محجوزة (مستبعدة)
  missingSeqs: number[];                                        // أرقام غير موجودة في النطاق
  foundCount: number; countedCount: number; returnedCount: number;
  grossMinor: Minor; netPaypalMinor: Minor; commissionMinor: Minor; dueMinor: Minor;
  rangeLabel: string;                                           // "(13-40)" / "(99-119) بدون 113"
};
export type CustomerSummary = {           // الأرقام الثمانية (SPEC §4.8)
  currency: Currency; netCompletedMinor: Minor; sentMinor: Minor; remainingMinor: Minor; notPaidCount: number;
  grossBeforeCommissionMinor: Minor; commissionMinor: Minor; txnCount: number; paidCount: number;
};
export type StatementRow =
  | { kind: 'txn'; txn: Transaction; runningBalanceMinor: Minor }
  | { kind: 'payout'; payout: Payout; runningBalanceMinor: Minor }
  | { kind: 'entry'; entry: LedgerEntry; runningBalanceMinor: Minor };   // تسوية / عكس / دفعة غير مرتبطة
export type StatementFilter = { show?: 'all' | 'transfers' | 'unpaid' | 'paid' | 'payouts' | 'not_exported'; period?: Period };   // not_exported = pending أو not_exported؛ transfers = الحوالات فقط (SPEC §4.9)
// customer_summary({ customerId, currency }): CustomerSummary
// customer_statement({ customerId, currency, filter?: StatementFilter }): { openingBalanceMinor: Minor; rows: StatementRow[]; closingBalanceMinor: Minor }
// payout_prepare({ customerId, currency, selection: PayoutSelection }): PayoutPreparation
// payout_create({ customerId, currency, txnIds: number[], returnedEntryIds: number[], amountText?: string, differenceReason?: string,
//   date: string, details: PayoutDetails, status: 'draft' | 'sent', matchedConfirmed: true }): Payout
//   throws validation (field 'overlap' | 'difference_reason' | 'matched') | invalid_transition
// payout_mark_sent({ payoutId, date?: string }): Payout
// payout_update_details({ payoutId, details: PayoutDetails }): Payout
// payout_cancel({ payoutId, reason: string }): Payout          // يعيد الحوالات غير مدفوعة ويعكس القيد إن كانت مرسلة
// payouts_list({ customerId, currency }): Payout[]
// ===== سجل الدفعات (SPEC §4.9): الدفعات المستقلة (ledger_add_payout) والمرتبطة القديمة في ترقيم واحد =====
export type PayoutRegisterRow = {
  seq: number;                        // "دفعة N" لكل عميل وعملة (ترقيم واحد للنوعين)
  kind: 'standalone' | 'linked';
  ledgerEntryId: number | null;       // قيد الدفتر (المستقلة دائماً؛ المرتبطة بعد الإرسال)
  payoutId: number | null;            // للمرتبطة فقط (للإلغاء عبر payout_cancel)
  date: string; amountMinor: Minor;   // موجب
  method: PayoutMethod; platform: string | null; network: string | null; destination: string | null;
  reference: string | null; note: string | null;   // المستقلة: الوصف إن كتبه المدير
  status: PayoutStatus;               // المستقلة: 'sent'، أو 'cancelled' إن عُكس قيدها
  cumulativePaidMinor: Minor;         // التراكمي المدفوع حتى هذا الصف (المرسلة غير الملغاة فقط)
  rangeLabel: string | null;          // للمرتبطة القديمة فقط
};
// payout_register({ customerId, currency }): PayoutRegisterRow[]   // مرتّبة بالرقم
//   إلغاء دفعة مستقلة: ledger_reverse_entry({ entryId: ledgerEntryId, reason })
// payout_defaults({ customerId }): PayoutDetails | null        // آخر طريقة/منصة/شبكة/عنوان لهذا العميل
// payout_platform_suggestions(): string[]                       // منصات/بنوك استُخدمت سابقاً
// txn_set_matched({ ids: number[], matched: boolean }): BulkResult
// ledger_add_adjustment({ customerId, input: AdjustmentInput }): LedgerEntry
// ledger_reverse_entry({ entryId, reason }): LedgerEntry               throws already_reversed
// ledger_delete_preview({ entryId }): { entries: LedgerEntry[]; balanceBeforeMinor: Minor; balanceAfterMinor: Minor }  // entries = القيد وزوجه إن وُجد
// ledger_delete_entry({ entryId, reason?: string }): { backup: BackupFile | null }   throws not_deletable
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

// ===== بدء من جديد (SPEC §4.7) =====
export type ResetScope = { transactions: boolean; customers: boolean; mailboxes: boolean; settings: boolean };
export type ResetPreview = { transactions: number; rawEmails: number; pullRuns: number; customers: number; ledgerEntries: number; mailboxes: number; notes: string[] };
// data_reset_preview({ scope: ResetScope }): ResetPreview
// data_reset({ scope: ResetScope, confirmText: string }): { backup: BackupFile }   // confirmText يجب أن يكون "حذف"; throws confirm_mismatch | backup_failed

// ===== Excel (SPEC §6.8) =====
export type ExcelExportResult = { path: string; sheets: number; rows: number; exportedAt: IsoDate; added: number; updated: number; created: boolean };  // added/updated لورقة المعاملات في وضع append؛ created = أُنشئ الملف لأول مرة
// excel_set_path({ path }): Settings                    // المسار من نافذة الحفظ
// excel_update(): ExcelExportResult                     // append (افتراضي): يضيف الجديد ويحدّث أعمدة البرنامج ويحفظ تعديلات المدير؛ rewrite: إعادة كتابة   throws no_export_path | file_locked | excel_layout | export_failed
// excel_export_transactions({ filter: TxnFilter, sort: TxnSort, path }): ExcelExportResult
// excel_export_ledger({ customerId, currency?: Currency, period?: Period, path }): ExcelExportResult  // بلا currency => ورقة لكل عملة

// ===== ملف Excel للعميل (SPEC §6.8.2) =====
export type ExcelStatus = 'exported' | 'pending' | 'not_exported';   // SPEC §6.8.3
export type CustomerExcel = { path: string; updatedAt: IsoDate | null; exists: boolean; addToExcelByDefault: boolean;
  autoSync: boolean;   // افتراضي false (SPEC §6.8.3 تحديث)
  fileName: string;    // اسم الملف للعرض في نافذة الإرسال
  exportedCount: number; pendingCount: number; notExportedCount: number; lastError: AppError | null;
  currentFileId: number; filesCount: number };   // القيم كلها للملف الحالي (SPEC §6.8.4)
export type CustomerExcelItemRef = { kind: 'txn' | 'ledger' | 'payout'; id: number };
export type CustomerExcelPreview = {
  toAdd: { kind: 'txn' | 'ledger' | 'payout'; id: number; date: string; labelAr: string; currency: Currency; amountMinor: Minor }[];
  duplicates: { kind: 'txn' | 'ledger' | 'payout'; id: number; date: string; labelAr: string; currency: Currency; amountMinor: Minor }[];
  notAllowed: { kind: 'txn' | 'ledger' | 'payout'; id: number; reasonAr: string }[];   // غير معتمدة، قيد اعتماد، عميل آخر...
  olderThanLastRow: number;
};
// customer_excel_get({ customerId }): CustomerExcel | null
// customer_excel_create({ customerId, path, includeExisting: boolean }): { path: string; added: number; sheets: string[] }
// customer_excel_link({ customerId, path }): CustomerExcel            throws excel_layout (ليس كشفاً لهذا العميل)
// customer_excel_unlink({ customerId }): void
// customer_excel_set_default({ customerId, addToExcelByDefault: boolean }): CustomerExcel   // خيار نافذتي الاعتماد والدفعة (عندما autoSync معطّل)
// customer_excel_set_auto({ customerId, autoSync: boolean }): CustomerExcel                  // SPEC §6.8.3
// customer_excel_send_unexported({ customerId }): { path: string; added: number; skippedDuplicates: number; stillPending: number }   throws file_locked | excel_layout | no_export_path
// customer_excel_unexported_summary(): { customerId: number; customerName: string; pending: number; notExported: number; lastError: AppError | null }[]   // للوحة التحكم
// event 'customer-excel://synced' payload: { customerId: number; added: number; pending: number; error: AppError | null }   // بعد كل كتابة تلقائية
// customer_excel_preview({ customerId, items: CustomerExcelItemRef[] }): CustomerExcelPreview
// ===== أكثر من ملف للعميل (SPEC §6.8.4) =====
export type CustomerExcelFile = { id: number; path: string; label: string | null; isCurrent: boolean; exists: boolean;
  startMode: 'carry_balance' | 'all' | 'from_date' | 'from_seq'; startValue: string | null; exportedCount: number; updatedAt: IsoDate | null; createdAt: IsoDate };
export type ExcelStart = { kind: 'carry_balance' } | { kind: 'all' } | { kind: 'from_date'; date: string } | { kind: 'from_seq'; seq: number };
// customer_excel_files({ customerId }): CustomerExcelFile[]
// customer_excel_new_file({ customerId, path, start: ExcelStart, makeCurrent: boolean, label?: string }): { file: CustomerExcelFile; added: number; sheets: string[] }
// customer_excel_set_current({ customerId, fileId }): CustomerExcel
// customer_excel_remove_file({ customerId, fileId }): void          // من القائمة فقط؛ لا يحذف الملف؛ لا يُزال الحالي
// customer_excel_item_files({ customerId, item: CustomerExcelItemRef }): { fileId: number; label: string | null; path: string; exportedAt: IsoDate }[]   // للتلميح عند الطلب (لا حقل في كل صف)
//   customer_excel_add / customer_excel_preview / customer_excel_send_unexported تقبل fileId?: number (الافتراضي: الملف الحالي)
// customer_excel_add({ customerId, items: CustomerExcelItemRef[] }): { path: string; added: number; skippedDuplicates: number; sheets: string[] }
//   throws no_export_path (لا ملف مرتبط) | file_locked | excel_layout | export_failed
// open_path({ path }): void                             // فتح الملف في Excel
```

## 4. ما تحتاجه الواجهة من إضافات Tauri

يضيفها القلب في `src-tauri` ويفعّل صلاحياتها في `capabilities/`:
- `@tauri-apps/plugin-dialog` — اختيار مجلد النسخ، مسار حفظ CSV و Excel (فلتر `.xlsx`)، ملف الاستعادة.
- `@tauri-apps/plugin-opener` — فتح روابط Google لإنشاء كلمة مرور التطبيق، وفتح مجلد البيانات، وفتح ملف Excel.
- `@tauri-apps/plugin-updater` — `check()` ثم `downloadAndInstall(onEvent)` (SPEC §6.9). الواجهة تستدعيه مباشرة (لا أمر في القلب)، بعد `backup_now`. في وضع المتصفح يُحاكى بـ mock في `src/mocks/`.
- `@tauri-apps/plugin-process` — `relaunch()` بعد التثبيت.
- الطباعة/PDF: الواجهة تعرض صفحة كشف الحساب وتستدعي `window.print()`.

## 5. متطلبات الواجهة الثابتة (غير قابلة للنقاش في جلسة التصميم)

- عربية فقط، `dir="rtl"`، الشريط الجانبي على اليمين.
- الأرقام لاتينية، والمبالغ تُعرض داخل `<bdi dir="ltr">` بالشكل `1,250.00 USD` (العملات بلا كسور: `JPY, HUF, TWD`).
- وضع داكن وفاتح وحسب النظام.
- النافذة بحد أدنى 1100×700.
- كل عملية تمسّ المال (اعتماد، إلغاء اعتماد، دفعة، تسوية، عكس قيد، استعادة نسخة) تطلب تأكيداً يعرض المبلغ.
- الشاشات وما تعرضه وتفعله: `docs/SPEC.md` القسم 6. **الشكل والأسلوب والألوان والخطوط والتخطيط** متروكة لجلسة التصميم وصاحب المشروع.
