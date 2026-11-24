// Command handlers for mockIPC. Shapes follow docs/UI-CONTRACT.md §3.
import { emit } from '@tauri-apps/api/event';
import type {
  AppError, BalanceCard, BulkResult, CommissionInput, Customer, CustomerInput, DashboardSummary, ErrorCode,
  FeeInput, LedgerEntry, LedgerView, ManualTxnInput, Money, Page, Period, PullRun, RawEmailSummary,
  RefundAlert, Transaction, TxnAction, TxnCounts, TxnFilter, TxnListResult, TxnPreview, TxnSort, AdjustmentInput, PayoutInput,
  MailboxInput, ParseStatus, PullRange, TxnLocation, TxnSearchHit,
} from '@/lib/contract';
import { decimalsOf, formatMinor } from '@/lib/money';
import { creditDescription, halfUp, ltr, seed, type Db, type LedgerRow, type TxnRow } from './db';

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
  if (t.type !== 'payment') return t.status === 'excluded' ? ['include', 'edit_note', 'delete'] : ['exclude', 'edit_note', 'delete'];
  const review: TxnAction[] = t.needsReview ? ['confirm_review', 'edit_details'] : [];
  switch (t.status) {
    case 'unassigned': return [...review, 'assign', 'set_fee', ...(t.needsReview ? [] : ['edit_details' as const]), 'exclude', 'edit_note', 'delete'];
    case 'pending_approval': {
      const a: TxnAction[] = [...review, 'set_fee', 'set_commission'];
      if (!t.needsReview && t.holdStatus !== 'pending_echeck' && t.feeMinor !== null && (t.customerAmountMinor ?? 0) > 0) a.push('approve');
      a.push('unassign', 'edit_note', 'delete');
      return a;
    }
    case 'approved': return ['unapprove', 'edit_note', 'delete'];
    case 'excluded': return ['include', 'edit_note', 'delete'];
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
  if (f.ids?.length && !f.ids.includes(t.id)) return false;
  if (f.currency && t.currency !== f.currency) return false;
  if (f.mailboxId && t.mailboxId !== f.mailboxId) return false;
  if (f.customerId && t.customerId !== f.customerId) return false;
  if (f.needsFeeOnly && t.feeMinor !== null) return false;
  if (f.needsReviewOnly && !t.needsReview) return false;
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

/** SPEC 6.3 global search: every status; id, payer, e-mail, note, or an amount typed as text. */
function txnSearchAll(query: string, limit = 50): TxnSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const amount = q.replace(/,/g, '');
  const isAmount = /^-?\d+(\.\d{1,2})?$/.test(amount);
  const hits = db.txns.filter((t) => {
    const hay = [t.payerName, t.payerEmail, t.paypalTxnId, t.payerNote].filter(Boolean).join(' ').toLowerCase();
    if (hay.includes(q)) return true;
    if (!isAmount) return false;
    return [t.grossMinor, t.netMinor, t.customerAmountMinor].some((m) => m !== null && formatMinor(m, t.currency).replace(/,/g, '') === (amount.includes('.') || decimalsOf(t.currency) === 0 ? amount : `${amount}.00`));
  });
  hits.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  return hits.slice(0, limit).map((t) => {
    const c = customerName(t.customerId);
    const location: TxnLocation = t.status === 'excluded' ? { kind: 'excluded' }
      : (t.status === 'pending_approval' || t.status === 'approved') && c ? { kind: 'customer', customerId: c.id, customerName: c.name, status: t.status }
      : { kind: 'inbox' };
    return { txn: view(t), location };
  });
}

function txnCounts(filter: Omit<TxnFilter, 'status'>): TxnCounts {
  const rows = db.txns.filter((t) => matches(t, filter));
  const c: TxnCounts = { all: rows.length, unassigned: 0, pending_approval: 0, approved: 0, excluded: 0, needsFee: 0, needsReview: 0 };
  for (const t of rows) {
    c[t.status]++;
    if (t.needsReview) c.needsReview++;
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
/** SPEC 4.7: payouts, adjustments and their manual reversals can be deleted; credits are managed from the transaction. */
function deletability(e: LedgerRow): Pick<LedgerEntry, 'deletable' | 'notDeletableReasonAr'> {
  if (e.type === 'credit') return { deletable: false, notDeletableReasonAr: 'قيد اعتماد: يُدار من المعاملة (إلغاء الاعتماد أو حذف المعاملة)' };
  if (e.transactionId !== null) return { deletable: false, notDeletableReasonAr: 'مرتبط بمعاملة: يُدار منها' };
  if (e.reversesEntryId !== null) {
    const orig = db.ledger.find((x) => x.id === e.reversesEntryId);
    if (orig?.type === 'credit') return { deletable: false, notDeletableReasonAr: 'قيد إلغاء اعتماد: يُدار من المعاملة' };
  }
  return { deletable: true, notDeletableReasonAr: null };
}
const asEntry = (e: LedgerRow, running = e.runningBalanceMinor): LedgerEntry => ({ ...e, runningBalanceMinor: running, ...deletability(e) });

function addLedger(e: Partial<LedgerRow> & Pick<LedgerRow, 'customerId' | 'currency' | 'type' | 'amountMinor' | 'description' | 'entryDate'>): LedgerEntry {
  const entry: LedgerRow = {
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

function withRunning(entry: LedgerRow): LedgerEntry {
  let bal = 0;
  for (const e of ordered(entry.customerId, entry.currency)) {
    bal += e.amountMinor;
    if (e.id === entry.id) return asEntry(e, bal);
  }
  return asEntry(entry);
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
    out.push(asEntry(e, bal));
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

// ---------- delete helpers (SPEC 4.7) ----------
function takeBackup() {
  if (!db.settings.backupDir) return null;
  const f = { path: `${db.settings.backupDir}\\ppfeez-${nowIso().slice(0, 19).replace(/[:T]/g, '-')}-before-delete.db`, createdAt: nowIso(), sizeBytes: 1_490_944 };
  db.backups.unshift(f);
  return f;
}

/** An entry and its reversal pair, both ways. */
function entryGroup(e: LedgerRow): LedgerRow[] {
  const pair = e.reversedByEntryId !== null ? db.ledger.find((x) => x.id === e.reversedByEntryId) : undefined;
  return pair ? [e, pair] : [e];
}

function effectsOf(entries: LedgerRow[]) {
  const m = new Map<string, { customerId: number; customerName: string; currency: string; balanceDeltaMinor: number }>();
  for (const e of entries) {
    const k = `${e.customerId}|${e.currency}`;
    const x = m.get(k) ?? { customerId: e.customerId, customerName: db.customers.find((c) => c.id === e.customerId)?.name ?? '—', currency: e.currency, balanceDeltaMinor: 0 };
    x.balanceDeltaMinor -= e.amountMinor;
    m.set(k, x);
  }
  return [...m.values()].filter((x) => x.balanceDeltaMinor !== 0);
}

function resetPreview(s: { transactions: boolean; customers: boolean; mailboxes: boolean; settings: boolean }) {
  const notes: string[] = [];
  if (s.customers && !s.transactions) notes.push('المعاملات تبقى وترجع كلها غير مخصّصة');
  if (s.transactions) notes.push('يُعاد السحب من بداية كل بريد في المرة القادمة');
  if (s.mailboxes) notes.push('تُحذف كلمات مرور التطبيقات من خزنة ويندوز');
  if (s.settings) notes.push('الإعدادات تعود للافتراضي ويظهر معالج الإعداد. كلمة القفل تبقى');
  return {
    transactions: s.transactions ? db.txns.length : 0, rawEmails: s.transactions ? db.emails.length : 0, pullRuns: s.transactions ? db.pullRuns.length : 0,
    customers: s.customers ? db.customers.length : 0, ledgerEntries: s.customers ? db.ledger.length : 0, mailboxes: s.mailboxes ? db.mailboxes.length : 0, notes,
  };
}

// ---------- PayPal domains (SPEC 5.6) ----------
const domainOf = (addr: string) => (addr.split('@')[1] ?? '').toLowerCase();

function unknownDomains() {
  const m = new Map<string, number>();
  for (const e of db.emails.filter((x) => x.parseStatus === 'ignored' && x.parseReason === 'unknown_paypal_domain')) {
    const d = domainOf(e.fromAddr);
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return [...m.entries()].map(([domain, count]) => ({ domain, count }));
}

function trusted(domain: string) {
  return [...db.settings.builtinPaypalDomains, ...db.settings.extraPaypalDomains].some((d) => domain === d || domain.endsWith('.' + d));
}

/** Re-parse saved emails; an ignored one from a now-trusted domain becomes a transaction to review. */
function reparse(ids: number[]): BulkResult {
  const res: BulkResult = { ok: [], failed: [] };
  for (const id of ids) {
    const e = db.emails.find((x) => x.id === id);
    if (!e) { res.failed.push({ id, code: 'not_found', messageAr: 'الرسالة غير موجودة' }); continue; }
    if (e.parseReason === 'deleted_by_user') {
      const tid = Math.max(0, ...db.txns.map((t) => t.id)) + 1;
      db.txns.push({
        id: tid, source: 'email', paypalTxnId: `RE${String(e.id).padStart(5, '0')}PARSED${tid}`, relatedTxnId: null, type: 'payment',
        payerName: e.subject.replace(/^.*from /, '') || null, payerEmail: null, payerNote: null, currency: 'USD', grossMinor: 10000, feeMinor: null, netMinor: null,
        feeIsEstimated: false, occurredAt: e.receivedAt, status: 'unassigned', customerId: null, commissionMode: null, commissionBps: null, commissionMinor: null,
        customerAmountMinor: null, assignedAt: null, approvedAt: null, note: null, mailboxId: 1, rawEmailId: e.id, refundHandled: false,
        needsReview: false, reviewReasonAr: null, holdStatus: null,
      });
      Object.assign(e, { parseStatus: 'parsed', parseReason: null, parseReasonAr: null, transactionId: tid });
      res.ok.push(id);
    } else if (e.parseReason === 'unknown_paypal_domain' && trusted(domainOf(e.fromAddr))) {
      const tid = Math.max(...db.txns.map((t) => t.id)) + 1;
      db.txns.push({
        id: tid, source: 'email', paypalTxnId: `9EG${String(tid).padStart(3, '0')}41KT77210${id % 10}`, relatedTxnId: null, type: 'payment',
        payerName: e.subject.includes('Omar') ? 'Omar Nabil' : 'Hany Saad', payerEmail: null, payerNote: null, currency: 'EGP', grossMinor: 250000 + (id % 7) * 1000,
        feeMinor: null, netMinor: null, feeIsEstimated: false, occurredAt: e.receivedAt, status: 'unassigned', customerId: null, commissionMode: null,
        commissionBps: null, commissionMinor: null, customerAmountMinor: null, assignedAt: null, approvedAt: null, note: null, mailboxId: 1,
        rawEmailId: e.id, refundHandled: false, needsReview: true, reviewReasonAr: 'صيغة غير معروفة — راجع المبلغ والعملة والمرسل', holdStatus: null,
      });
      Object.assign(e, { parseStatus: 'parsed', parseReason: null, parseReasonAr: null, transactionId: tid, parserName: 'generic' });
      res.ok.push(id);
    } else {
      res.failed.push({ id, code: 'validation', messageAr: e.parseReason === 'unknown_paypal_domain' ? 'النطاق غير موثوق بعد' : 'ما زال القالب غير معروف' });
    }
  }
  return res;
}

// ---------- dashboard ----------
function dashboard(period: Period): DashboardSummary {
  const inP = (d: string) => (!period.from || d >= period.from) && (!period.to || d <= period.to);
  const curs = [...new Set(db.txns.map((t) => t.currency))].sort();
  const counts = txnCounts({});
  return {
    counts: { unassigned: counts.unassigned, needsFee: counts.needsFee, pendingApproval: counts.pending_approval, refundAlerts: refundAlerts().length, needsReview: counts.needsReview, unknownPaypalDomains: unknownDomains().reduce((n, d) => n + d.count, 0) },
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

const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function validateRange(r: PullRange) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (r.kind === 'last_days' && !(Number.isInteger(r.days) && r.days >= 1 && r.days <= 3650)) fail('invalid_range', 'عدد الأيام بين 1 و3650', 'range');
  if (r.kind === 'between') {
    if (!day.test(r.from) || !day.test(r.to)) fail('invalid_range', 'تاريخ غير صالح', 'range');
    if (r.from > r.to) fail('invalid_range', 'تاريخ البداية بعد تاريخ النهاية', 'range');
    if (r.to > localToday()) fail('invalid_range', 'لا يمكن السحب من تاريخ في المستقبل', 'range');
  }
}

function pullStart(mailboxId: number, range: PullRange = { kind: 'new' }): PullRun {
  if (runningPull) fail('pull_running', 'يوجد سحب قيد التشغيل');
  validateRange(range);
  const mb = db.mailboxes.find((m) => m.id === mailboxId) ?? fail('not_found', 'البريد غير موجود');
  if (!mb.isActive) fail('imap_disabled', 'هذا البريد موقوف');
  if (!mb.hasPassword) fail('imap_auth', 'لا توجد كلمة مرور تطبيق لهذا البريد');
  // a wider range reads more mail; the numbers are only there to make the progress bar believable
  const total = range.kind === 'all' ? 64 : range.kind === 'last_days' ? Math.min(60, 8 + Math.ceil(range.days / 3)) : range.kind === 'between' ? 32 : 24;
  const empty = new URLSearchParams(location.search).get('pullEmpty') === '1';
  const run: PullRun = { id: ++db.seq, mailboxId, mailboxLabel: mb.label, status: 'running', range, totalCount: empty ? 0 : total - (total % 4), fetchedCount: 0, newTransactionsCount: 0, duplicateCount: 0, ignoredCount: 0, failedCount: 0, error: null, startedAt: nowIso(), finishedAt: null };
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
  if (empty) {
    clearInterval(timer);
    setTimeout(() => {
      run.status = 'done'; run.finishedAt = nowIso(); mb.lastPulledAt = run.finishedAt; runningPull = null;
      void emit('pull://finished', { ...run });
    }, 600);
  }
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
      assignedAt: null, approvedAt: null, note: null, mailboxId, rawEmailId: null, refundHandled: false, needsReview: false, reviewReasonAr: null, holdStatus: null,
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
        .map(customerView)
        .filter((c) => a.hasPending === undefined || (c.pendingCount > 0) === a.hasPending);
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
    case 'txn_search_all': return txnSearchAll(String(a.query ?? ''), a.limit ?? 50);
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
        commissionMinor: null, customerAmountMinor: null, assignedAt: null, approvedAt: null, note: i.note || null, mailboxId: null, rawEmailId: i.rawEmailId ?? null, refundHandled: false, needsReview: false, reviewReasonAr: null, holdStatus: null,
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
    case 'txn_confirm_review': {
      const t = getTxn(a.id);
      if (!t.needsReview) fail('invalid_transition', 'المعاملة لا تحتاج مراجعة');
      t.needsReview = false; t.reviewReasonAr = null;
      log(t, 'review_confirmed', 'أُكّدت البيانات بعد المراجعة');
      return view(t);
    }
    case 'txn_edit_details': {
      const t = getTxn(a.id);
      if (!(t.needsReview || t.status === 'unassigned')) fail('invalid_transition', 'التعديل متاح لغير المخصّصة أو التي تحتاج مراجعة');
      const i = a.input as { payerName?: string; payerEmail?: string; currency?: string; grossText?: string; occurredAt?: string };
      if (i.currency !== undefined && !/^[A-Z]{3}$/.test(i.currency)) fail('validation', 'رمز العملة ثلاثة أحرف لاتينية', 'currency');
      if (i.currency) t.currency = i.currency;
      if (i.grossText !== undefined) t.grossMinor = parseAmount(i.grossText, t.currency, 'grossText');
      if (i.occurredAt) {
        const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/.exec(i.occurredAt) ?? fail('validation', 'التاريخ غير صالح', 'occurredAt');
        t.occurredAt = new Date(`${m[1]}T${m[2]}:${m[3]}:00`).toISOString();
      }
      if (i.payerName !== undefined) t.payerName = i.payerName || null;
      if (i.payerEmail !== undefined) t.payerEmail = i.payerEmail || null;
      recompute(t);
      log(t, 'details_edited', 'عُدّلت بيانات المعاملة');
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
      return addLedger({ customerId: al.customer.id, currency: al.originalTxn.currency, type: 'reversal', amountMinor: amt, transactionId: r.id, reference: r.paypalTxnId, description: `استرداد للمعاملة ${ltr(al.originalTxn.paypalTxnId)}`, entryDate: nowIso().slice(0, 10) });
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
    case 'mailbox_set_active': {
      const m = db.mailboxes.find((x) => x.id === a.id) ?? fail('not_found', 'البريد غير موجود');
      m.isActive = a.active;
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
    case 'pull_start': return pullStart(a.mailboxId, a.range ?? undefined);
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
    case 'email_reparse': return reparse(a.ids as number[]);
    case 'unknown_paypal_domains': return unknownDomains();
    case 'paypal_domain_trust': {
      const domain = String(a.domain ?? '').trim().toLowerCase();
      if (!/^paypal\.[a-z.]{2,}$/.test(domain)) fail('validation', 'نطاق غير صالح', 'domain');
      if (!db.settings.extraPaypalDomains.includes(domain)) db.settings.extraPaypalDomains.push(domain);
      const ids = db.emails.filter((e) => e.parseReason === 'unknown_paypal_domain' && domainOf(e.fromAddr).endsWith(domain)).map((e) => e.id);
      return { domain, reparsed: reparse(ids) };
    }
    case 'email_set_ignored': { const e = db.emails.find((x) => x.id === a.id)!; e.parseStatus = 'ignored'; e.parseReasonAr = 'تجاهلها المدير'; e.parseReason = 'manual'; return null; }

    // backup
    // ---------- delete (SPEC 4.7) ----------
    case 'txn_delete_preview': {
      const rows = (a.ids as number[]).map(getTxn);
      const entries = db.ledger.filter((e) => e.transactionId !== null && rows.some((t) => t.id === e.transactionId) || rows.some((t) => db.ledger.some((c) => c.transactionId === t.id && c.id === e.reversesEntryId)));
      return { count: rows.length, approvedCount: rows.filter((t) => t.status === 'approved').length, ledgerEntryCount: entries.length, effects: effectsOf(entries) };
    }
    case 'txn_delete': {
      const ids = a.ids as number[];
      const backup = ids.length > 1 ? takeBackup() : null;
      const res: BulkResult = { ok: [], failed: [] };
      for (const id of ids) {
        const t = db.txns.find((x) => x.id === id);
        if (!t) { res.failed.push({ id, code: 'not_found', messageAr: 'المعاملة غير موجودة' }); continue; }
        const credits = db.ledger.filter((e) => e.transactionId === id).map((e) => e.id);
        db.ledger = db.ledger.filter((e) => !credits.includes(e.id) && !(e.reversesEntryId !== null && credits.includes(e.reversesEntryId)));
        db.txns = db.txns.filter((x) => x.id !== id);
        const em = db.emails.find((e) => e.transactionId === id);
        if (em) Object.assign(em, { parseStatus: 'ignored', parseReason: 'deleted_by_user', parseReasonAr: 'حُذفت يدوياً', transactionId: null });
        res.ok.push(id);
      }
      return { ...res, backup };
    }
    case 'customer_delete_preview': {
      const c = db.customers.find((x) => x.id === a.id) ?? fail('not_found', 'العميل غير موجود');
      const own = db.txns.filter((t) => t.customerId === c.id);
      return { assignedCount: own.length, approvedCount: own.filter((t) => t.status === 'approved').length, ledgerEntryCount: db.ledger.filter((e) => e.customerId === c.id).length, balances: customerView(c).balances };
    }
    case 'customer_delete': {
      const c = db.customers.find((x) => x.id === a.id) ?? fail('not_found', 'العميل غير موجود');
      if (a.confirmName !== c.name) fail('confirm_mismatch', 'الاسم لا يطابق اسم العميل', 'confirmName');
      const backup = takeBackup();
      for (const t of db.txns.filter((x) => x.customerId === c.id)) {
        Object.assign(t, { status: 'unassigned', customerId: null, commissionMode: null, commissionBps: null, commissionMinor: null, customerAmountMinor: null, assignedAt: null, approvedAt: null });
        log(t, 'unassigned', `أُلغي التخصيص بحذف العميل ${c.name}`);
      }
      db.ledger = db.ledger.filter((e) => e.customerId !== c.id);
      db.customers = db.customers.filter((x) => x.id !== c.id);
      return { backup };
    }
    case 'ledger_delete_preview': {
      const e = db.ledger.find((x) => x.id === a.entryId) ?? fail('not_found', 'القيد غير موجود');
      const group = entryGroup(e);
      const before = balanceOf(e.customerId, e.currency);
      return { entries: group.map((x) => withRunning(x)), balanceBeforeMinor: before, balanceAfterMinor: before - group.reduce((s, x) => s + x.amountMinor, 0) };
    }
    case 'ledger_delete_entry': {
      const e = db.ledger.find((x) => x.id === a.entryId) ?? fail('not_found', 'القيد غير موجود');
      const d = deletability(e);
      if (!d.deletable) fail('not_deletable', d.notDeletableReasonAr ?? 'لا يمكن حذف هذا القيد');
      const backup = takeBackup();
      const ids = entryGroup(e).map((x) => x.id);
      db.ledger = db.ledger.filter((x) => !ids.includes(x.id));
      // deleting a reversal alone makes the original active again
      for (const x of db.ledger) if (x.reversedByEntryId !== null && ids.includes(x.reversedByEntryId)) x.reversedByEntryId = null;
      return { backup };
    }
    case 'data_reset_preview': return resetPreview(a.scope);
    case 'data_reset': {
      if (a.confirmText !== 'حذف') fail('confirm_mismatch', 'اكتب «حذف» للتأكيد', 'confirmText');
      if (!db.settings.backupDir) fail('backup_failed', 'اختر مجلد النسخ الاحتياطي أولاً: النسخة إلزامية قبل الحذف');
      const backup = takeBackup()!;
      const s = a.scope as { transactions: boolean; customers: boolean; mailboxes: boolean; settings: boolean };
      if (s.transactions) { db.txns = []; db.emails = []; db.pullRuns = []; db.history = []; for (const m of db.mailboxes) { m.lastUid = 0; m.lastPulledAt = null; } }
      if (s.customers) {
        db.ledger = []; db.customers = [];
        for (const t of db.txns) Object.assign(t, { status: t.status === 'excluded' ? 'excluded' : 'unassigned', customerId: null, commissionMode: null, commissionBps: null, commissionMinor: null, customerAmountMinor: null, assignedAt: null, approvedAt: null });
      }
      if (s.mailboxes) db.mailboxes = [];
      if (s.settings) {
        const keep = { backupDir: db.settings.backupDir, builtinPaypalDomains: db.settings.builtinPaypalDomains };
        db.settings = { ...seed().settings, ...keep, onboardingDone: false };
        db.status.onboardingDone = false;
      }
      return { backup };
    }

    case 'backup_now': {
      if (!db.settings.backupDir) fail('backup_failed', 'اختر مجلد النسخ الاحتياطي أولاً');
      const f = { path: `${db.settings.backupDir}\\ppfeez-${nowIso().slice(0, 16).replace(/[:T]/g, '-')}.db`, createdAt: nowIso(), sizeBytes: 1_490_944 };
      db.backups.unshift(f);
      return f;
    }
    case 'backup_list': return db.backups;
    case 'backup_restore': return null;

    // excel
    case 'excel_set_path': db.settings.excelExportPath = a.path; return { ...db.settings };
    case 'excel_update': {
      if (!db.settings.excelExportPath) fail('no_export_path', 'اختر مسار ملف Excel أولاً');
      if (new URLSearchParams(location.search).get('excelLocked') === '1') fail('file_locked', 'أغلق الملف في Excel ثم أعد المحاولة');
      db.settings.excelLastExportedAt = nowIso();
      return { path: db.settings.excelExportPath, sheets: 4, rows: db.txns.length + db.ledger.length + db.customers.length + 8, exportedAt: db.settings.excelLastExportedAt };
    }
    case 'excel_export_transactions': return { path: a.path, sheets: 1, rows: txnList(a.filter ?? {}, a.sort, 1, 100000).total + 1, exportedAt: nowIso() };
    case 'excel_export_ledger': return { path: a.path, sheets: a.currency ? 1 : balances(a.customerId).length, rows: db.ledger.filter((e) => e.customerId === a.customerId).length, exportedAt: nowIso() };
    case 'open_path': return null;

    // plugins
    case 'plugin:dialog|open': return a.options?.directory ? 'D:\\Backups\\PpFeez' : 'D:\\Backups\\PpFeez\\ppfeez-2026-11-22-2310.db';
    case 'plugin:dialog|save': {
      const name = String(a.options?.defaultPath ?? 'export.csv');
      return `C:\\Users\\Mohammed\\Documents\\${name}`;
    }
    case 'plugin:opener|open_url': case 'plugin:opener|open_path': return null;
  }
  console.warn('[mock] unhandled command', cmd, a);
  return fail('internal', `أمر غير معروف في الوضع التجريبي: ${cmd}`);
}
