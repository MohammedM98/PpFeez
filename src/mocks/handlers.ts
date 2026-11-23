// Command handlers for mockIPC. Shapes follow docs/UI-CONTRACT.md §3.
import { emit } from '@tauri-apps/api/event';
import type {
  AppError, BalanceCard, BulkResult, CommissionInput, Customer, CustomerInput, DashboardSummary, ErrorCode,
  FeeInput, LedgerEntry, LedgerView, ManualTxnInput, Money, Page, Period, PullRun, RawEmailSummary,
  RefundAlert, Transaction, TxnAction, TxnCounts, TxnFilter, TxnListResult, TxnPreview, TxnSort, AdjustmentInput, PayoutInput,
  MailboxInput, ParseStatus,
} from '@/lib/contract';
import { creditDescription, halfUp, seed, type Db, type TxnRow } from './db';

let db: Db = seed();
export function resetDb(next?: Partial<Db['status']>) {
  db = seed();
  if (next) Object.assign(db.status, next);
}
export function getDb() {
  return db;
}

const fail = (code: ErrorCode, messageAr: string, field?: string): never => {
  const e: AppError = { code, messageAr, ...(field ? { field } : {}) };
  throw e;
};
const nowIso = () => new Date().toISOString();
const ZERO_DEC = new Set(['JPY', 'HUF', 'TWD']);

function parseAmount(text: string | undefined, currency: string, field = 'amount'): number {
  const t = (text ?? '').trim().replace(/,/g, '');
  const d = ZERO_DEC.has(currency) ? 0 : 2;
  const re = d === 0 ? /^(\d+)$/ : /^(\d+)(?:\.(\d{1,2}))?$/;
  const m = re.exec(t);
  if (!m) return fail('invalid_amount', 'المبلغ غير صالح', field);
  return Number(m[1]) * 10 ** d + Number((m[2] ?? '').padEnd(d, '0') || 0);
}

// ---------- transactions ----------
function customerName(id: number | null) {
  return id === null ? null : db.customers.find((c) => c.id === id) ?? null;
}

function allowedActions(t: TxnRow): TxnAction[] {
  if (t.type !== 'payment') return t.status === 'excluded' ? ['include', 'edit_note'] : ['exclude', 'edit_note'];
  switch (t.status) {
    case 'unassigned': return ['assign', 'set_fee', 'exclude', 'edit_note'];
    case 'pending_approval': {
      const a: TxnAction[] = ['set_fee', 'set_commission'];
      if (t.feeMinor !== null && (t.customerAmountMinor ?? 0) > 0) a.push('approve');
      a.push('unassign', 'edit_note');
      return a;
    }
    case 'approved': return ['unapprove', 'edit_note'];
    case 'excluded': return ['include', 'edit_note'];
  }
}

function view(t: TxnRow): Transaction {
  const c = customerName(t.customerId);
  const mb = t.mailboxId ? db.mailboxes.find((m) => m.id === t.mailboxId) : null;
  const { customerId: _c, mailboxId: _m, refundHandled: _r, ...rest } = t;
  return {
    ...rest,
    customer: c ? { id: c.id, name: c.name } : null,
    mailbox: mb ? { id: mb.id, label: mb.label } : null,
    refundedBy: db.txns.filter((r) => r.type !== 'payment' && r.relatedTxnId === t.paypalTxnId).map((r) => ({ id: r.id, type: r.type, grossMinor: r.grossMinor })),
    allowedActions: allowedActions(t),
  };
}

function getTxn(id: number) {
  return db.txns.find((t) => t.id === id) ?? fail('not_found', 'المعاملة غير موجودة');
}

function recompute(t: TxnRow) {
  t.netMinor = t.feeMinor === null ? null : t.grossMinor - t.feeMinor;
  if (t.commissionMode === null || t.netMinor === null) {
    t.commissionMinor = t.commissionMode === 'fixed' ? t.commissionMinor : null;
    t.customerAmountMinor = null;
    return;
  }
  if (t.commissionMode === 'percent') t.commissionMinor = halfUp(t.netMinor, t.commissionBps ?? 0);
  t.customerAmountMinor = t.netMinor - (t.commissionMinor ?? 0);
}

function log(t: TxnRow, action: string, labelAr: string, details: Record<string, unknown> = {}) {
  db.history.push({ txnId: t.id, id: ++db.seq, action, labelAr, details, createdAt: nowIso() });
}

function applyFee(t: TxnRow, fee: FeeInput, dry = false): Pick<TxnRow, 'feeMinor'> {
  let feeMinor: number;
  switch (fee.kind) {
    case 'zero': feeMinor = 0; break;
    case 'fee': feeMinor = parseAmount(fee.feeText, t.currency, 'fee'); break;
    case 'net': feeMinor = t.grossMinor - parseAmount(fee.netText, t.currency, 'net'); break;
    case 'accept_estimate': {
      const est = estimate(t);
      feeMinor = est ?? fail('validation', 'لا يوجد تقدير للرسوم');
      break;
    }
  }
  if (feeMinor < 0 || feeMinor > t.grossMinor) fail('validation', 'الرسوم يجب أن تكون بين صفر والمبلغ الأصلي', 'fee');
  if (!dry) {
    t.feeMinor = feeMinor;
    t.feeIsEstimated = false;
    recompute(t);
  }
  return { feeMinor };
}

function estimate(t: TxnRow): number | null {
  if (!db.settings.feeEstimateEnabled) return null;
  return halfUp(t.grossMinor, db.settings.feeEstimateBps) + db.settings.feeEstimateFixedMinor;
}

function applyCommission(t: TxnRow, c: CommissionInput) {
  if (c.mode === 'percent') {
    if (c.bps < 0 || c.bps > 10000) fail('validation', 'النسبة بين 0 و100', 'commission');
    t.commissionMode = 'percent';
    t.commissionBps = c.bps;
  } else {
    const amt = parseAmount(c.amountText, t.currency, 'commission');
    if (t.netMinor !== null && amt > t.netMinor) fail('commission_exceeds_net', 'العمولة أكبر من الصافي', 'commission');
    t.commissionMode = 'fixed';
    t.commissionBps = null;
    t.commissionMinor = amt;
  }
  recompute(t);
}

function matches(t: TxnRow, f: Omit<TxnFilter, 'status'>) {
  if (f.currency && t.currency !== f.currency) return false;
  if (f.mailboxId && t.mailboxId !== f.mailboxId) return false;
  if (f.customerId && t.customerId !== f.customerId) return false;
  if (f.needsFeeOnly && t.feeMinor !== null) return false;
  if (f.type && t.type !== f.type) return false;
  const day = t.occurredAt.slice(0, 10);
  if (f.period?.from && day < f.period.from) return false;
  if (f.period?.to && day > f.period.to) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = [t.payerName, t.payerEmail, t.paypalTxnId, t.payerNote].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function txnList(filter: TxnFilter, sort: TxnSort, page: number, pageSize: number): TxnListResult {
  const rows = db.txns.filter((t) => matches(t, filter) && (!filter.status || filter.status === 'all' || t.status === filter.status));
  const dir = sort.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[sort.key as keyof TxnRow] as string | number | null;
    const bv = b[sort.key as keyof TxnRow] as string | number | null;
    if (av === bv) return b.id - a.id;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av < bv ? -1 : 1) * dir;
  });
  const totals = new Map<string, TxnListResult['totals'][number]>();
  for (const t of rows) {
    const x = totals.get(t.currency) ?? { currency: t.currency, grossMinor: 0, feeMinor: 0, netMinor: 0, customerAmountMinor: 0, count: 0 };
    x.grossMinor += t.grossMinor; x.feeMinor += t.feeMinor ?? 0; x.netMinor += t.netMinor ?? 0; x.customerAmountMinor += t.customerAmountMinor ?? 0; x.count++;
    totals.set(t.currency, x);
  }
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize).map(view),
    total: rows.length, page, pageSize,
    totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

function txnCounts(filter: Omit<TxnFilter, 'status'>): TxnCounts {
  const rows = db.txns.filter((t) => matches(t, filter));
  const c: TxnCounts = { all: rows.length, unassigned: 0, pending_approval: 0, approved: 0, excluded: 0, needsFee: 0 };
  for (const t of rows) {
    c[t.status]++;
    if (t.feeMinor === null && t.status !== 'excluded') c.needsFee++;
  }
  return c;
}

function assign(id: number, customerId: number, commission?: CommissionInput, approve?: boolean) {
  const t = getTxn(id);
  if (t.status !== 'unassigned' || t.type !== 'payment') fail('invalid_transition', 'لا يمكن تخصيص هذه المعاملة');
  const c = db.customers.find((x) => x.id === customerId) ?? fail('not_found', 'العميل غير موجود');
  if (!c.isActive) fail('customer_inactive', 'العميل معطّل');
  t.customerId = c.id;
  t.status = 'pending_approval';
  t.assignedAt = nowIso();
  t.commissionMode = 'percent';
  t.commissionBps = c.defaultCommissionBps;
  recompute(t);
  if (commission) applyCommission(t, commission);
  log(t, 'assigned', `خُصّصت لـ ${c.name}`);
  if (approve) approveTxn(t.id);
  return view(t);
}

function approveTxn(id: number) {
  const t = getTxn(id);
  if (t.status !== 'pending_approval') fail('invalid_transition', 'المعاملة ليست بانتظار الموافقة');
  if (t.feeMinor === null) fail('fee_required', 'أدخل رسوم PayPal قبل الاعتماد');
  if ((t.customerAmountMinor ?? 0) <= 0) fail('validation', 'المبلغ المستحق للعميل يجب أن يكون أكبر من صفر');
  t.status = 'approved';
  t.approvedAt = nowIso();
  addLedger({ customerId: t.customerId!, currency: t.currency, type: 'credit', amountMinor: t.customerAmountMinor!, transactionId: t.id, reference: t.paypalTxnId, description: creditDescription(t), entryDate: nowIso().slice(0, 10) });
  log(t, 'approved', 'اعتُمدت وأُضيف قيد للعميل');
  return view(t);
}

function unapprove(id: number, reason: string) {
  const t = getTxn(id);
  if (t.status !== 'approved') fail('invalid_transition', 'المعاملة غير معتمدة');
  if (!reason?.trim()) fail('validation', 'السبب إلزامي', 'reason');
  const credit = db.ledger.find((e) => e.transactionId === t.id && e.type === 'credit' && e.reversedByEntryId === null);
  if (credit) reverseEntry(credit.id, reason);
  t.status = 'unassigned';
  t.customerId = null; t.commissionMode = null; t.commissionBps = null; t.commissionMinor = null; t.customerAmountMinor = null;
  t.assignedAt = null; t.approvedAt = null;
  log(t, 'unapproved', `أُلغي الاعتماد: ${reason}`);
  return view(t);
}

// ---------- ledger ----------
function addLedger(e: Partial<LedgerEntry> & Pick<LedgerEntry, 'customerId' | 'currency' | 'type' | 'amountMinor' | 'description' | 'entryDate'>): LedgerEntry {
  const entry: LedgerEntry = {
    id: ++db.seq, runningBalanceMinor: 0, transactionId: null, reversesEntryId: null, reversedByEntryId: null,
    payoutMethod: null, reference: null, createdAt: nowIso(), ...e,
  };
  db.ledger.push(entry);
  return withRunning(entry);
}

function ordered(customerId: number, currency: string) {
  return db.ledger
    .filter((e) => e.customerId === customerId && e.currency === currency)
    .sort((a, b) => (a.entryDate === b.entryDate ? a.id - b.id : a.entryDate < b.entryDate ? -1 : 1));
}

function withRunning(entry: LedgerEntry): LedgerEntry {
  let bal = 0;
  for (const e of ordered(entry.customerId, entry.currency)) {
    bal += e.amountMinor;
    if (e.id === entry.id) return { ...e, runningBalanceMinor: bal };
  }
  return entry;
}

function balanceOf(customerId: number, currency: string) {
  return db.ledger.filter((e) => e.customerId === customerId && e.currency === currency).reduce((s, e) => s + e.amountMinor, 0);
}

function balances(customerId: number): BalanceCard[] {
  const curs = [...new Set(db.ledger.filter((e) => e.customerId === customerId).map((e) => e.currency))].sort();
  return curs.map((currency) => {
    let credits = 0, debits = 0;
    for (const e of db.ledger.filter((x) => x.customerId === customerId && x.currency === currency)) {
      if (e.amountMinor >= 0) credits += e.amountMinor; else debits += -e.amountMinor;
    }
    return { currency, creditsMinor: credits, debitsMinor: debits, balanceMinor: credits - debits };
  });
}

function entries(customerId: number, currency: string, period?: Period): LedgerView {
  let bal = 0, opening = 0;
  const out: LedgerEntry[] = [];
  for (const e of ordered(customerId, currency)) {
    bal += e.amountMinor;
    if (period?.from && e.entryDate < period.from) { opening = bal; continue; }
    if (period?.to && e.entryDate > period.to) continue;
    out.push({ ...e, runningBalanceMinor: bal });
  }
  const closing = out.length ? out[out.length - 1].runningBalanceMinor : opening;
  return { openingBalanceMinor: opening, entries: out, closingBalanceMinor: closing };
}

function reverseEntry(entryId: number, reason: string): LedgerEntry {
  const e = db.ledger.find((x) => x.id === entryId) ?? fail('not_found', 'القيد غير موجود');
  if (e.reversedByEntryId !== null || e.reversesEntryId !== null) fail('already_reversed', 'هذا القيد معكوس مسبقاً');
  if (!reason?.trim()) fail('validation', 'السبب إلزامي', 'reason');
  const r = addLedger({ customerId: e.customerId, currency: e.currency, type: 'reversal', amountMinor: -e.amountMinor, reversesEntryId: e.id, description: `عكس: ${e.description} — ${reason}`, entryDate: nowIso().slice(0, 10) });
  e.reversedByEntryId = r.id;
  return r;
}

function customerView(c: Db['customers'][number]): Customer {
  const curs = [...new Set(db.ledger.filter((e) => e.customerId === c.id).map((e) => e.currency))].sort();
  return {
    ...c,
    balances: curs.map<Money>((currency) => ({ currency, minor: balanceOf(c.id, currency) })),
    pendingCount: db.txns.filter((t) => t.customerId === c.id && t.status === 'pending_approval').length,
  };
}

function refundAlerts(): RefundAlert[] {
  const out: RefundAlert[] = [];
  for (const r of db.txns.filter((t) => t.type !== 'payment' && !t.refundHandled)) {
    const o = db.txns.find((t) => t.paypalTxnId === r.relatedTxnId);
    if (!o || o.status !== 'approved' || !o.customerId) continue;
    const c = customerName(o.customerId)!;
    const full = Math.abs(r.grossMinor) >= o.grossMinor;
    const suggested = full ? -o.customerAmountMinor! : -Math.floor((Math.abs(r.grossMinor) * o.customerAmountMinor! + Math.floor(o.grossMinor / 2)) / o.grossMinor);
    out.push({ refundTxn: view(r), originalTxn: view(o), suggestedReversalMinor: suggested, customer: { id: c.id, name: c.name } });
  }
  return out;
}

// ---------- dashboard ----------
function dashboard(period: Period): DashboardSummary {
  const inP = (d: string) => (!period.from || d >= period.from) && (!period.to || d <= period.to);
  const curs = [...new Set(db.txns.map((t) => t.currency))].sort();
  const counts = txnCounts({});
  return {
    counts: { unassigned: counts.unassigned, needsFee: counts.needsFee, pendingApproval: counts.pending_approval, refundAlerts: refundAlerts().length },
    byCurrency: curs.map((currency) => {
      const pay = db.txns.filter((t) => t.currency === currency && t.type === 'payment' && t.status !== 'excluded' && inP(t.occurredAt.slice(0, 10)));
      return {
        currency,
        grossMinor: pay.reduce((s, t) => s + t.grossMinor, 0),
        feeMinor: pay.reduce((s, t) => s + (t.feeMinor ?? 0), 0),
        commissionMinor: db.txns.filter((t) => t.currency === currency && t.status === 'approved' && inP((t.approvedAt ?? '').slice(0, 10))).reduce((s, t) => s + (t.commissionMinor ?? 0), 0),
        owedToCustomersMinor: db.customers.reduce((s, c) => s + balanceOf(c.id, currency), 0),
        paidOutMinor: -db.ledger.filter((e) => e.currency === currency && e.type === 'payout' && e.reversedByEntryId === null && inP(e.entryDate)).reduce((s, e) => s + e.amountMinor, 0),
      };
    }),
    topCustomers: curs.flatMap((currency) =>
      db.customers.map((c) => ({ customerId: c.id, name: c.name, balance: { currency, minor: balanceOf(c.id, currency) } }))
        .filter((x) => x.balance.minor !== 0).sort((a, b) => b.balance.minor - a.balance.minor).slice(0, 5)),
    lastPull: db.pullRuns[0] ?? null,
  };
}

// ---------- pull ----------
let runningPull: { run: PullRun; timer: ReturnType<typeof setInterval> } | null = null;

function pullStart(mailboxId: number): PullRun {
  if (runningPull) fail('pull_running', 'يوجد سحب قيد التشغيل');
  const mb = db.mailboxes.find((m) => m.id === mailboxId) ?? fail('not_found', 'البريد غير موجود');
  if (!mb.isActive) fail('imap_disabled', 'هذا البريد موقوف');
  if (!mb.hasPassword) fail('imap_auth', 'لا توجد كلمة مرور تطبيق لهذا البريد');
  const run: PullRun = { id: ++db.seq, mailboxId, mailboxLabel: mb.label, status: 'running', totalCount: 24, fetchedCount: 0, newTransactionsCount: 0, duplicateCount: 0, ignoredCount: 0, failedCount: 0, error: null, startedAt: nowIso(), finishedAt: null };
  db.pullRuns.unshift(run);
  const timer = setInterval(() => {
    run.fetchedCount = Math.min(run.totalCount, run.fetchedCount + 4);
    const step = run.fetchedCount / 4;
    if (step % 3 === 1) run.newTransactionsCount++;
    else if (step % 3 === 2) run.ignoredCount++;
    else run.duplicateCount++;
    void emit('pull://progress', { ...run });
    if (run.fetchedCount >= run.totalCount) {
      clearInterval(timer);
      run.status = 'done';
      run.finishedAt = nowIso();
      mb.lastPulledAt = run.finishedAt;
      addPulledTxns(run.newTransactionsCount, mb.id);
      runningPull = null;
      void emit('pull://finished', { ...run });
    }
  }, 700);
  runningPull = { run, timer };
  setTimeout(() => void emit('pull://progress', { ...run }), 50);
  return { ...run };
}

function addPulledTxns(n: number, mailboxId: number) {
  const names = [['Grace Lee', 'grace.lee@gmail.com', 'USD', 6400], ['Pierre Dubois', 'p.dubois@free.fr', 'EUR', 9000], ['Elif Şahin', 'elif.sahin@gmail.com', 'TRY', 310000], ['Ryan Clark', 'ryan.clark@aol.com', 'USD', 12500]] as const;
  for (let i = 0; i < n; i++) {
    const [payer, email, cur, gross] = names[i % names.length];
    const id = Math.max(...db.txns.map((t) => t.id)) + 1;
    db.txns.push({
      id, source: 'email', paypalTxnId: `${Math.random().toString(36).slice(2, 10).toUpperCase()}${id}PULL`, relatedTxnId: null, type: 'payment',
      payerName: payer, payerEmail: email, payerNote: null, currency: cur, grossMinor: gross, feeMinor: null, netMinor: null, feeIsEstimated: false,
      occurredAt: nowIso(), status: 'unassigned', customerId: null, commissionMode: null, commissionBps: null, commissionMinor: null, customerAmountMinor: null,
      assignedAt: null, approvedAt: null, note: null, mailboxId, rawEmailId: null, refundHandled: false,
    });
  }
}

// ---------- router ----------
type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function handle(cmd: string, a: Args = {}): unknown {
  switch (cmd) {
    // app
    case 'app_status': return { ...db.status };
    case 'unlock': {
      if (db.status.lockedUntil && new Date(db.status.lockedUntil) > new Date()) fail('too_many_attempts', 'محاولات كثيرة، انتظر قليلاً');
      if (a.password !== db.lockPassword) {
        db.failedAttempts++;
        if (db.failedAttempts >= 5) {
          db.failedAttempts = 0;
          db.status.lockedUntil = new Date(Date.now() + 30000).toISOString();
          fail('too_many_attempts', 'خمس محاولات خاطئة، انتظر 30 ثانية');
        }
        fail('wrong_password', 'كلمة المرور غير صحيحة');
      }
      db.failedAttempts = 0;
      db.status.locked = false;
      db.status.lockedUntil = undefined;
      return { ...db.status };
    }
    case 'lock': if (db.status.lockEnabled) db.status.locked = true; return null;
    case 'set_lock_password':
      if (db.lockPassword && db.status.onboardingDone && a.current !== db.lockPassword) fail('wrong_password', 'كلمة المرور الحالية غير صحيحة', 'current');
      db.lockPassword = a.next ?? null;
      db.status.lockEnabled = a.next != null;
      return null;
    case 'get_settings': return { ...db.settings };
    case 'update_settings':
      Object.assign(db.settings, a.patch);
      if (a.patch?.onboardingDone !== undefined) db.status.onboardingDone = a.patch.onboardingDone;
      return { ...db.settings };
    case 'open_data_dir': return null;

    case 'dashboard_summary': return dashboard(a.period ?? {});

    // customers
    case 'customers_list': {
      const q = (a.search ?? '').trim().toLowerCase();
      return db.customers
        .filter((c) => (a.active === undefined || c.isActive === a.active) && (!q || c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q)))
        .map(customerView);
    }
    case 'customer_get': return customerView(db.customers.find((c) => c.id === a.id) ?? fail('not_found', 'العميل غير موجود'));
    case 'customer_create': case 'customer_update': {
      const input = a.input as CustomerInput;
      const name = input.name?.trim();
      if (!name) fail('validation', 'الاسم إلزامي', 'name');
      if (db.customers.some((c) => c.name === name && c.id !== a.id)) fail('duplicate', 'يوجد عميل بهذا الاسم', 'name');
      if (input.defaultCommissionBps < 0 || input.defaultCommissionBps > 10000) fail('validation', 'العمولة بين 0 و100', 'defaultCommissionBps');
      if (cmd === 'customer_create') {
        const c = { id: Math.max(0, ...db.customers.map((x) => x.id)) + 1, name, phone: input.phone || null, defaultCommissionBps: input.defaultCommissionBps, notes: input.notes || null, isActive: input.isActive ?? true, createdAt: nowIso() };
        db.customers.push(c);
        return customerView(c);
      }
      const c = db.customers.find((x) => x.id === a.id) ?? fail('not_found', 'العميل غير موجود');
      Object.assign(c, { name, phone: input.phone || null, defaultCommissionBps: input.defaultCommissionBps, notes: input.notes || null, isActive: input.isActive ?? c.isActive });
      return customerView(c);
    }
    case 'customer_set_active': {
      const c = db.customers.find((x) => x.id === a.id) ?? fail('not_found', 'العميل غير موجود');
      c.isActive = a.active;
      return customerView(c);
    }

    // transactions
    case 'txn_list': return txnList(a.filter ?? {}, a.sort ?? { key: 'occurredAt', dir: 'desc' }, a.page ?? 1, a.pageSize ?? 50);
    case 'txn_counts': return txnCounts(a.filter ?? {});
    case 'txn_get': return view(getTxn(a.id));
    case 'txn_history': return db.history.filter((h) => h.txnId === a.id).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)).map(({ txnId: _t, ...h }) => h);
    case 'txn_preview': {
      const t = { ...getTxn(a.id) };
      try {
        if (a.customerId) {
          const c = db.customers.find((x) => x.id === a.customerId);
          if (c && t.status === 'unassigned') { t.commissionMode = 'percent'; t.commissionBps = c.defaultCommissionBps; }
        }
        if (a.fee) applyFee(t, a.fee);
        if (a.commission) applyCommission(t, a.commission);
        else recompute(t);
        const out: TxnPreview = { feeMinor: t.feeMinor, netMinor: t.netMinor, commissionMinor: t.commissionMinor, customerAmountMinor: t.customerAmountMinor, feeEstimateMinor: t.feeMinor === null ? estimate(t) : null };
        return out;
      } catch (e) {
        return { feeMinor: null, netMinor: null, commissionMinor: null, customerAmountMinor: null, feeEstimateMinor: null, error: e as AppError } satisfies TxnPreview;
      }
    }
    case 'txn_create_manual': {
      const i = a.input as ManualTxnInput;
      if (!i.currency) fail('validation', 'العملة إلزامية', 'currency');
      const gross = parseAmount(i.grossText, i.currency, 'gross');
      const fee = i.feeText?.trim() ? parseAmount(i.feeText, i.currency, 'fee') : null;
      if (fee !== null && fee > gross) fail('validation', 'الرسوم أكبر من المبلغ', 'fee');
      const pp = i.paypalTxnId?.trim() || `MANUAL-${String(++db.seq).padStart(4, '0')}`;
      if (db.txns.some((t) => t.paypalTxnId === pp)) fail('duplicate', 'رقم المعاملة موجود مسبقاً', 'paypalTxnId');
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/.exec(i.occurredAt ?? '');
      if (!m) fail('validation', 'التاريخ غير صالح', 'occurredAt');
      const id = Math.max(...db.txns.map((t) => t.id)) + 1;
      const t: TxnRow = {
        id, source: 'manual', paypalTxnId: pp, relatedTxnId: null, type: 'payment', payerName: i.payerName || null, payerEmail: i.payerEmail || null, payerNote: i.payerNote || null,
        currency: i.currency, grossMinor: gross, feeMinor: fee, netMinor: fee === null ? null : gross - fee, feeIsEstimated: false,
        occurredAt: new Date(`${m![1]}T${m![2]}:${m![3]}:00`).toISOString(), status: 'unassigned', customerId: null, commissionMode: null, commissionBps: null,
        commissionMinor: null, customerAmountMinor: null, assignedAt: null, approvedAt: null, note: i.note || null, mailboxId: null, rawEmailId: i.rawEmailId ?? null, refundHandled: false,
      };
      db.txns.push(t);
      log(t, 'created', 'أُضيفت يدوياً');
      if (i.rawEmailId) {
        const em = db.emails.find((e) => e.id === i.rawEmailId);
        if (em) { em.transactionId = id; em.parseStatus = 'parsed'; }
      }
      return view(t);
    }
    case 'txn_assign': return assign(a.id, a.customerId, a.commission, a.approve);
    case 'txn_unassign': {
      const t = getTxn(a.id);
      if (t.status !== 'pending_approval') fail('invalid_transition', 'لا يمكن إلغاء التخصيص');
      t.status = 'unassigned'; t.customerId = null; t.commissionMode = null; t.commissionBps = null; t.commissionMinor = null; t.customerAmountMinor = null; t.assignedAt = null;
      log(t, 'unassigned', 'أُلغي التخصيص');
      return view(t);
    }
    case 'txn_set_fee': {
      const t = getTxn(a.id);
      if (t.status === 'approved') fail('invalid_transition', 'المعاملة معتمدة ومقفلة');
      applyFee(t, a.fee);
      log(t, 'fee_set', 'عُدّلت الرسوم');
      return view(t);
    }
    case 'txn_set_commission': {
      const t = getTxn(a.id);
      if (t.status !== 'pending_approval') fail('invalid_transition', 'تعديل العمولة متاح قبل الاعتماد فقط');
      applyCommission(t, a.commission);
      log(t, 'commission_set', 'عُدّلت العمولة');
      return view(t);
    }
    case 'txn_approve': return approveTxn(a.id);
    case 'txn_unapprove': return unapprove(a.id, a.reason);
    case 'txn_set_excluded': {
      const t = getTxn(a.id);
      if (a.excluded && t.status !== 'unassigned') fail('invalid_transition', 'الاستبعاد متاح لغير المخصّصة فقط');
      if (!a.excluded && t.status !== 'excluded') fail('invalid_transition', 'المعاملة ليست مستبعدة');
      t.status = a.excluded ? 'excluded' : 'unassigned';
      log(t, a.excluded ? 'excluded' : 'included', a.excluded ? 'استُبعدت' : 'أُرجعت');
      return view(t);
    }
    case 'txn_set_note': { const t = getTxn(a.id); t.note = a.note; log(t, 'note', 'عُدّلت الملاحظة'); return view(t); }
    case 'txn_bulk': {
      const res: BulkResult = { ok: [], failed: [] };
      for (const id of a.ids as number[]) {
        try {
          if (a.action === 'assign') assign(id, a.customerId, a.commission);
          else if (a.action === 'approve') approveTxn(id);
          else if (a.action === 'unassign') handle('txn_unassign', { id });
          else handle('txn_set_excluded', { id, excluded: true });
          res.ok.push(id);
        } catch (e) {
          const err = e as AppError;
          res.failed.push({ id, code: err.code ?? 'internal', messageAr: err.messageAr ?? 'خطأ' });
        }
      }
      return res;
    }

    // ledger
    case 'ledger_balances': return balances(a.customerId);
    case 'ledger_entries': return entries(a.customerId, a.currency, a.period);
    case 'ledger_add_payout': {
      const i = a.input as PayoutInput;
      const amt = parseAmount(i.amountText, i.currency);
      if (amt <= 0) fail('validation', 'المبلغ يجب أن يكون أكبر من صفر', 'amount');
      if (amt > balanceOf(a.customerId, i.currency) && !i.confirmOverdraw) fail('validation', 'الدفعة أكبر من الرصيد المتاح', 'overdraw');
      return addLedger({ customerId: a.customerId, currency: i.currency, type: 'payout', amountMinor: -amt, payoutMethod: i.method, reference: i.reference || null, description: i.description || 'دفعة', entryDate: i.entryDate });
    }
    case 'ledger_add_adjustment': {
      const i = a.input as AdjustmentInput;
      if (!i.description?.trim()) fail('validation', 'الوصف إلزامي', 'description');
      const amt = parseAmount(i.amountText, i.currency);
      return addLedger({ customerId: a.customerId, currency: i.currency, type: 'adjustment', amountMinor: i.direction === 'credit' ? amt : -amt, description: i.description, entryDate: i.entryDate });
    }
    case 'ledger_reverse_entry': return reverseEntry(a.entryId, a.reason);
    case 'ledger_export_csv': return null;
    case 'ledger_statement': return { customer: customerView(db.customers.find((c) => c.id === a.customerId)!), view: entries(a.customerId, a.currency, a.period), generatedAt: nowIso() };
    case 'refund_alerts': return refundAlerts();
    case 'refund_confirm_reversal': {
      const al = refundAlerts().find((x) => x.refundTxn.id === a.refundTxnId) ?? fail('not_found', 'لا يوجد تنبيه');
      const amt = a.amountText ? -parseAmount(a.amountText, al.originalTxn.currency) : al.suggestedReversalMinor;
      const r = getTxn(a.refundTxnId);
      r.refundHandled = true; r.status = 'excluded';
      return addLedger({ customerId: al.customer.id, currency: al.originalTxn.currency, type: 'reversal', amountMinor: amt, transactionId: r.id, reference: r.paypalTxnId, description: `استرداد للمعاملة ${al.originalTxn.paypalTxnId}`, entryDate: nowIso().slice(0, 10) });
    }
    case 'refund_dismiss': { const r = getTxn(a.refundTxnId); r.refundHandled = true; r.status = 'excluded'; return null; }

    // mail
    case 'mailbox_list': return db.mailboxes.map(({ password: _p, ...m }) => ({ ...m, running: runningPull?.run.mailboxId === m.id }));
    case 'mailbox_create': {
      const i = a.input as MailboxInput;
      if (!i.label?.trim() || !i.email?.includes('@')) fail('validation', 'التسمية والعنوان إلزاميان', 'email');
      const m = { id: ++db.seq, label: i.label, email: i.email, host: i.host ?? 'imap.gmail.com', port: i.port ?? 993, folder: i.folder ?? 'INBOX', isActive: true, hasPassword: !!i.password, lastPulledAt: null, lastUid: 0, password: i.password ?? null };
      db.mailboxes.push(m);
      const { password: _p, ...rest } = m;
      return { ...rest, running: false };
    }
    case 'mailbox_update': {
      const m = db.mailboxes.find((x) => x.id === a.id) ?? fail('not_found', 'البريد غير موجود');
      const i = a.input as MailboxInput & { isActive?: boolean };
      Object.assign(m, { label: i.label, email: i.email, host: i.host ?? m.host, port: i.port ?? m.port, folder: i.folder ?? m.folder });
      if (i.isActive !== undefined) m.isActive = i.isActive;
      if (i.password) { m.password = i.password; m.hasPassword = true; }
      const { password: _p, ...rest } = m;
      return { ...rest, running: false };
    }
    case 'mailbox_set_password': { const m = db.mailboxes.find((x) => x.id === a.id)!; m.password = a.password; m.hasPassword = true; return null; }
    case 'mailbox_test': {
      const pw = a.input ? a.input.password : db.mailboxes.find((x) => x.id === a.id)?.password;
      if (!pw) fail('imap_auth', 'كلمة مرور التطبيق مفقودة أو غير صحيحة');
      if (pw === 'wrong') fail('imap_auth', 'رفض Gmail كلمة مرور التطبيق');
      return { ok: true, folderCount: 7 };
    }
    case 'mailbox_delete': {
      if (db.txns.some((t) => t.mailboxId === a.id)) fail('has_dependents', 'لهذا البريد معاملات، أوقفه بدل حذفه');
      db.mailboxes = db.mailboxes.filter((m) => m.id !== a.id);
      return null;
    }
    case 'pull_start': return pullStart(a.mailboxId);
    case 'pull_cancel': {
      if (runningPull && runningPull.run.id === a.runId) {
        clearInterval(runningPull.timer);
        runningPull.run.status = 'cancelled';
        runningPull.run.finishedAt = nowIso();
        const r = { ...runningPull.run };
        runningPull = null;
        void emit('pull://finished', r);
      }
      return null;
    }
    case 'pull_runs_list': return db.pullRuns.slice(0, a.limit ?? 20).map((r) => ({ ...r }));

    // emails
    case 'emails_list': {
      const q = (a.search ?? '').toLowerCase();
      const rows = db.emails.filter((e) => e.parseStatus === (a.status as ParseStatus) && (!q || `${e.subject} ${e.fromAddr}`.toLowerCase().includes(q)))
        .sort((x, y) => (x.receivedAt < y.receivedAt ? 1 : -1));
      const page = a.page ?? 1, pageSize = a.pageSize ?? 50;
      const items: RawEmailSummary[] = rows.slice((page - 1) * pageSize, page * pageSize).map(({ bodyHtml: _h, bodyText: _t, parserName: _p, ...s }) => s);
      return { items, total: rows.length, page, pageSize } satisfies Page<RawEmailSummary>;
    }
    case 'email_get': return db.emails.find((e) => e.id === a.id) ?? fail('not_found', 'الرسالة غير موجودة');
    case 'email_reparse': {
      const res: BulkResult = { ok: [], failed: [] };
      for (const id of a.ids as number[]) res.failed.push({ id, code: 'validation', messageAr: 'ما زال القالب غير معروف' });
      return res;
    }
    case 'email_set_ignored': { const e = db.emails.find((x) => x.id === a.id)!; e.parseStatus = 'ignored'; e.parseReasonAr = 'تجاهلها المدير'; e.parseReason = 'manual'; return null; }

    // backup
    case 'backup_now': {
      if (!db.settings.backupDir) fail('backup_failed', 'اختر مجلد النسخ الاحتياطي أولاً');
      const f = { path: `${db.settings.backupDir}\\ppfeez-${nowIso().slice(0, 16).replace(/[:T]/g, '-')}.db`, createdAt: nowIso(), sizeBytes: 1_490_944 };
      db.backups.unshift(f);
      return f;
    }
    case 'backup_list': return db.backups;
    case 'backup_restore': return null;

    // plugins
    case 'plugin:dialog|open': return a.options?.directory ? 'D:\\Backups\\PpFeez' : 'D:\\Backups\\PpFeez\\ppfeez-2026-11-22-2310.db';
    case 'plugin:dialog|save': return 'C:\\Users\\Mohammed\\Documents\\statement.csv';
    case 'plugin:opener|open_url': case 'plugin:opener|open_path': return null;
  }
  console.warn('[mock] unhandled command', cmd, a);
  return fail('internal', `أمر غير معروف في الوضع التجريبي: ${cmd}`);
}
