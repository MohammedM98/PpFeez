// Command handlers for mockIPC. Shapes follow docs/UI-CONTRACT.md §3.
import { emit } from '@tauri-apps/api/event';
import type {
  AppError, BalanceCard, BulkResult, CommissionInput, Customer, CustomerInput, DashboardSummary, ErrorCode,
  FeeInput, LedgerEntry, LedgerView, ManualTxnInput, Money, Page, Period, PullRun, RawEmailSummary,
  RefundAlert, Transaction, TxnAction, TxnCounts, TxnFilter, TxnListResult, TxnPreview, TxnSort, AdjustmentInput, PayoutInput,
  MailboxInput, ParseStatus, PullRange, TxnLocation, TxnSearchHit, CustomerExcel, CustomerExcelItemRef, CustomerExcelPreview, ExcelStatus,
  Payout, PayoutPreparation, PayoutSelection, CustomerSummary, StatementFilter, StatementRow, CustomerExcelFile, ExcelStart,
} from '@/lib/contract';
import { amountTextToMinor2, decimalsOf, formatMinor } from '@/lib/money';
import { creditDescription, halfUp, ltr, seed, type CustomerExcelRow, type Db, type LedgerRow, type PayoutRow, type TxnRow } from './db';

let db: Db = seed();
// Excel append mode (SPEC 6.8.1): which PayPal ids the main file already has, and rows changed since
// the last update (the seed's file was written yesterday, before the last few changes)
let excelExported = new Set<string>();
let excelUpdates = 0;
function seedExcel() {
  excelExported = new Set(db.txns.filter((t) => t.occurredAt < daysAgoIso(1)).map((t) => t.paypalTxnId));
  excelUpdates = 2;
}
const daysAgoIso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
seedExcel();
export function resetDb(next?: Partial<Db['status']>) {
  db = seed();
  seedExcel();
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

/** refunds and reversals (few), looked up once per change of the list rather than once per row */
let refundCache: { n: TxnRow[]; len: number; rows: TxnRow[] } | null = null;
function refundRows() {
  if (!refundCache || refundCache.n !== db.txns || refundCache.len !== db.txns.length) refundCache = { n: db.txns, len: db.txns.length, rows: db.txns.filter((r) => r.type !== 'payment') };
  return refundCache.rows;
}

function view(t: TxnRow): Transaction {
  const c = customerName(t.customerId);
  const mb = t.mailboxId ? db.mailboxes.find((m) => m.id === t.mailboxId) : null;
  const { customerId: _c, mailboxId: _m, refundHandled: _r, ...rest } = t;
  return {
    ...rest,
    customer: c ? { id: c.id, name: c.name } : null,
    mailbox: mb ? { id: mb.id, label: mb.label } : null,
    refundedBy: refundRows().filter((r) => r.relatedTxnId === t.paypalTxnId).map((r) => ({ id: r.id, type: r.type, grossMinor: r.grossMinor })),
    allowedActions: allowedActions(t),
    payout: payoutOf(t.id),
    inCustomerExcel: !!t.customerId && inExcel(t.customerId, 'txn', t.id),
    excelStatus: excelStatusOf(t.customerId, 'txn', t.id),
    changedAfterExcel: t.status !== 'approved' && Object.values(db.customerExcel).some((x) => x.items.some((i) => i.kind === 'txn' && i.id === t.id)),
  };
}

/** In the file already (a pending item still has to be written, so it is not a duplicate). */
const inExcel = (customerId: number, kind: 'txn' | 'ledger' | 'payout', id: number) =>
  !!db.customerExcel[customerId]?.items.some((i) => i.kind === kind && i.id === id && i.status === 'exported');
/** SPEC 6.8.3 per-row status: exported / pending (could not be written yet) / not exported. */
function excelStatusOf(customerId: number | null, kind: 'txn' | 'ledger' | 'payout', id: number): ExcelStatus {
  const it = customerId === null ? undefined : db.customerExcel[customerId]?.items.find((i) => i.kind === kind && i.id === id);
  return it ? it.status : 'not_exported';
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
  // SPEC 4.8: the next transfer number for this customer and currency (never reused)
  const k = `${t.customerId}:${t.currency}`;
  t.customerSeq = db.txnSeq[k] = (db.txnSeq[k] ?? 0) + 1;
  addLedger({ customerId: t.customerId!, currency: t.currency, type: 'credit', amountMinor: t.customerAmountMinor!, transactionId: t.id, reference: t.paypalTxnId, description: creditDescription(t), entryDate: nowIso().slice(0, 10) });
  log(t, 'approved', 'اعتُمدت وأُضيف قيد للعميل');
  syncEvent(t.customerId, { kind: 'txn', id: t.id });
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
  t.assignedAt = null; t.approvedAt = null; t.customerSeq = null; // the number stays a gap
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
const asEntry = (e: LedgerRow, running = e.runningBalanceMinor): LedgerEntry => ({ ...e, runningBalanceMinor: running, ...deletability(e), inCustomerExcel: inExcel(e.customerId, 'ledger', e.id), excelStatus: excelStatusOf(e.customerId, 'ledger', e.id) });

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
  // a reversal of something already in the file is written there too (SPEC 6.8.3)
  const payout = db.payouts.find((x) => x.ledgerEntryId === e.id);
  const wasExported = e.type === 'credit' && e.transactionId !== null ? inExcel(e.customerId, 'txn', e.transactionId)
    : payout ? inExcel(e.customerId, 'payout', payout.id) : inExcel(e.customerId, 'ledger', e.id);
  if (wasExported) syncEvent(e.customerId, { kind: 'ledger', id: r.id });
  return r;
}

function customerView(c: Db['customers'][number]): Customer {
  const curs = [...new Set(db.ledger.filter((e) => e.customerId === c.id).map((e) => e.currency))].sort();
  return {
    ...c,
    balances: curs.map<Money>((currency) => ({ currency, minor: balanceOf(c.id, currency) })),
    pendingCount: db.txns.filter((t) => t.customerId === c.id && t.status === 'pending_approval').length,
    excel: excelView(c.id),
  };
}

// ---------------------------------------------------------------- linked payouts and the statement (SPEC 4.8, 6.5)
const livePayouts = () => db.payouts.filter((p) => p.status !== 'cancelled');
function payoutOf(txnId: number) {
  const p = livePayouts().find((x) => x.txnIds.includes(txnId));
  return p ? { id: p.id, seq: p.seq, status: p.status as 'draft' | 'sent' } : null;
}
const sumOf = (xs: TxnRow[], f: (t: TxnRow) => number | null) => xs.reduce((n, t) => n + (f(t) ?? 0), 0);

function payoutView(p: PayoutRow): Payout {
  const cumulative = db.payouts
    .filter((x) => x.customerId === p.customerId && x.currency === p.currency && x.status === 'sent' && x.seq <= p.seq)
    .reduce((n, x) => n + x.amountMinor, 0);
  return {
    id: p.id, customerId: p.customerId, currency: p.currency, seq: p.seq, status: p.status, amountMinor: p.amountMinor, dueMinor: p.dueMinor,
    date: p.date, rangeLabel: p.rangeLabel, details: { ...p.details }, txnCount: p.txnIds.length, cumulativePaidMinor: cumulative,
    ledgerEntryId: p.ledgerEntryId, itemIds: { txns: [...p.txnIds], ledger: [...p.ledgerIds] }, inCustomerExcel: inExcel(p.customerId, 'payout', p.id),
    excelStatus: excelStatusOf(p.customerId, 'payout', p.id), createdAt: p.createdAt,
  };
}

/** "(13-40)", "(99-119) بدون 113", "(5)" */
function rangeLabelOf(seqs: number[]): string {
  if (!seqs.length) return '()';
  const sorted = [...seqs].sort((a, b) => a - b);
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  const missing: number[] = [];
  for (let n = lo; n <= hi; n++) if (!sorted.includes(n)) missing.push(n);
  return `(${lo === hi ? lo : `${lo}-${hi}`})${missing.length ? ` بدون ${missing.join('، ')}` : ''}`;
}

function payoutPrepare(customerId: number, currency: string, sel: PayoutSelection): PayoutPreparation {
  const approved = db.txns.filter((t) => t.customerId === customerId && t.currency === currency && t.status === 'approved' && t.customerSeq !== null)
    .sort((a, b) => a.customerSeq! - b.customerSeq!);
  let found: TxnRow[];
  const missingSeqs: number[] = [];
  if (sel.kind === 'range') {
    found = approved.filter((t) => t.customerSeq! >= sel.from && t.customerSeq! <= sel.to);
    for (let n = sel.from; n <= sel.to; n++) if (!found.some((t) => t.customerSeq === n)) missingSeqs.push(n);
  } else if (sel.kind === 'ids') found = approved.filter((t) => sel.txnIds.includes(t.id));
  else found = approved.filter((t) => !payoutOf(t.id));
  const alreadyPaid = found.filter((t) => payoutOf(t.id)).map((t) => ({ txn: view(t), payoutSeq: payoutOf(t.id)!.seq }));
  const held = found.filter((t) => !payoutOf(t.id) && t.holdStatus !== null);
  const included = found.filter((t) => !payoutOf(t.id) && t.holdStatus === null);
  const gross = sumOf(included, (t) => t.grossMinor), net = sumOf(included, (t) => t.netMinor), commission = sumOf(included, (t) => t.commissionMinor);
  // returns (negative lines) not yet settled by a payout are deducted from the next one
  const settled = new Set(livePayouts().flatMap((p) => p.ledgerIds));
  const returned = db.ledger.filter((e) => e.customerId === customerId && e.currency === currency && e.type === 'adjustment' && e.amountMinor < 0
    && e.description.startsWith('مرتجع') && e.reversedByEntryId === null && !settled.has(e.id));
  const returns = returned.reduce((n, e) => n + e.amountMinor, 0);
  return {
    included: included.map(view), returned: returned.map((e) => withRunning(e)), alreadyPaid, excludedHeld: held.map(view), missingSeqs,
    foundCount: found.length, countedCount: included.length, returnedCount: returned.length,
    grossMinor: gross, netPaypalMinor: net, commissionMinor: commission, dueMinor: sumOf(included, (t) => t.customerAmountMinor) + returns,
    rangeLabel: rangeLabelOf(included.map((t) => t.customerSeq!)),
  };
}

function payoutLedger(p: PayoutRow): LedgerEntry {
  const e = addLedger({
    customerId: p.customerId, currency: p.currency, type: 'payout', amountMinor: -p.amountMinor, payoutMethod: p.details.method,
    reference: p.details.reference ?? null, description: `دفعة ${p.seq} ${p.rangeLabel}`, entryDate: p.date,
  });
  p.ledgerEntryId = e.id;
  syncEvent(p.customerId, { kind: 'payout', id: p.id });
  return e;
}

function payoutCreate(a: Args): Payout {
  if (a.matchedConfirmed !== true) fail('validation', 'أكّد أنك راجعت الحوالات وأنها مطابقة', 'matched');
  const ids: number[] = a.txnIds ?? [];
  if (!ids.length) fail('validation', 'لا حوالات في هذه الدفعة', 'txnIds');
  const overlap = ids.map((id) => [id, payoutOf(id)] as const).filter(([, p]) => p);
  if (overlap.length) fail('validation', `مدفوعة سابقاً في الدفعة ${overlap[0][1]!.seq}`, 'overlap');
  const rows = ids.map(getTxn);
  if (rows.some((t) => t.customerId !== a.customerId || t.currency !== a.currency || t.status !== 'approved')) fail('invalid_transition', 'كل حوالات الدفعة يجب أن تكون معتمدة لهذا العميل وبهذه العملة');
  const returnedIds: number[] = a.returnedEntryIds ?? [];
  const dueMinor = sumOf(rows, (t) => t.customerAmountMinor) + db.ledger.filter((e) => returnedIds.includes(e.id)).reduce((n, e) => n + e.amountMinor, 0);
  let amountMinor = dueMinor;
  if (a.amountText?.trim()) {
    const m = amountTextToMinor2(String(a.amountText).replace(/,/g, '').trim());
    if (m === null || m <= 0) fail('invalid_amount', 'أدخل مبلغاً صحيحاً', 'amount');
    amountMinor = m!;
  }
  if (amountMinor !== dueMinor && !a.differenceReason?.trim()) fail('validation', 'المبلغ يختلف عن المستحق؛ اكتب السبب', 'difference_reason');
  const seq = 1 + Math.max(0, ...db.payouts.filter((p) => p.customerId === a.customerId && p.currency === a.currency).map((p) => p.seq));
  const p: PayoutRow = {
    id: ++db.seq, customerId: a.customerId, currency: a.currency, seq, status: a.status === 'draft' ? 'draft' : 'sent', amountMinor, dueMinor,
    date: a.date, rangeLabel: rangeLabelOf(rows.map((t) => t.customerSeq!)), details: { ...a.details }, txnIds: ids, ledgerIds: a.returnedEntryIds ?? [],
    ledgerEntryId: null, createdAt: nowIso(), differenceReason: a.differenceReason?.trim() || null,
  };
  db.payouts.push(p);
  if (p.status === 'sent') payoutLedger(p);
  for (const t of rows) log(t, 'payout', p.status === 'sent' ? `تم الإرسال — دفعة ${seq}` : `مسجلة في الدفعة ${seq}`);
  return payoutView(p);
}

function getPayout(id: number) {
  return db.payouts.find((p) => p.id === id) ?? fail('not_found', 'الدفعة غير موجودة');
}

function customerSummary(customerId: number, currency: string): CustomerSummary {
  const approved = db.txns.filter((t) => t.customerId === customerId && t.currency === currency && t.status === 'approved' && t.holdStatus === null);
  const sent = db.ledger.filter((e) => e.customerId === customerId && e.currency === currency && e.type === 'payout' && e.reversedByEntryId === null)
    .reduce((n, e) => n - e.amountMinor, 0);
  return {
    currency, netCompletedMinor: sumOf(approved, (t) => t.customerAmountMinor), sentMinor: sent, remainingMinor: balanceOf(customerId, currency),
    notPaidCount: approved.filter((t) => payoutOf(t.id)?.status !== 'sent').length, grossBeforeCommissionMinor: sumOf(approved, (t) => t.netMinor),
    commissionMinor: sumOf(approved, (t) => t.commissionMinor), txnCount: approved.length,
    paidCount: approved.filter((t) => payoutOf(t.id)?.status === 'sent').length,
  };
}

/** The ledger in order, transfers and linked payouts shown as themselves; recorded payouts sit at their date without moving the balance. */
function customerStatement(customerId: number, currency: string, filter: StatementFilter = {}) {
  const rows: (StatementRow & { date: string })[] = [];
  let bal = 0;
  const drafts = db.payouts.filter((p) => p.customerId === customerId && p.currency === currency && p.status === 'draft');
  for (const e of ordered(customerId, currency)) {
    bal += e.amountMinor;
    const t = e.type === 'credit' && e.transactionId !== null ? db.txns.find((x) => x.id === e.transactionId) : undefined;
    const p = db.payouts.find((x) => x.ledgerEntryId === e.id);
    if (t && t.status === 'approved' && t.customerId === customerId && e.reversedByEntryId === null) rows.push({ kind: 'txn', txn: view(t), runningBalanceMinor: bal, date: e.entryDate });
    else if (p) rows.push({ kind: 'payout', payout: payoutView(p), runningBalanceMinor: bal, date: e.entryDate });
    else rows.push({ kind: 'entry', entry: asEntry(e, bal), runningBalanceMinor: bal, date: e.entryDate });
  }
  for (const p of drafts) {
    const at = rows.findIndex((r) => r.date > p.date);
    const prev = at === -1 ? rows[rows.length - 1] : rows[at - 1];
    const row = { kind: 'payout' as const, payout: payoutView(p), runningBalanceMinor: prev?.runningBalanceMinor ?? 0, date: p.date };
    if (at === -1) rows.push(row); else rows.splice(at, 0, row);
  }
  const from = filter.period?.from, to = filter.period?.to;
  let opening = 0;
  const inPeriod = rows.filter((r) => {
    if (from && r.date < from) { opening = r.runningBalanceMinor; return false; }
    return !(to && r.date > to);
  });
  const show = filter.show ?? 'all';
  const shown = inPeriod.filter((r) =>
    show === 'all' ? true
      : show === 'not_exported' ? (r.kind === 'txn' ? r.txn.excelStatus : r.kind === 'payout' ? (r.payout.status === 'sent' ? r.payout.excelStatus : 'exported') : r.entry.type === 'credit' || db.payouts.some((p) => p.ledgerEntryId === r.entry.id) ? 'exported' : r.entry.excelStatus) !== 'exported'
      : show === 'payouts' ? r.kind === 'payout' || (r.kind === 'entry' && r.entry.type === 'payout')
        : r.kind === 'txn' && (show === 'paid' ? !!r.txn.payout : !r.txn.payout));
  return {
    openingBalanceMinor: opening,
    rows: shown.map(({ date: _d, ...r }) => r as StatementRow),
    closingBalanceMinor: inPeriod.length ? inPeriod[inPeriod.length - 1].runningBalanceMinor : opening,
  };
}

// ---------------------------------------------------------------- customer Excel statement (SPEC 6.8.2)
function excelView(customerId: number): CustomerExcel | null {
  const x = db.customerExcel[customerId];
  if (!x) return null;
  const exported = x.items.filter((i) => i.status === 'exported' && !i.covered).length;
  const pending = x.items.filter((i) => i.status === 'pending').length;
  const notExported = excelAllItems(customerId).filter((r) => !x.items.some((i) => i.kind === r.kind && i.id === r.id)).length;
  return {
    path: x.path, updatedAt: x.updatedAt, exists: true, addToExcelByDefault: x.addToExcelByDefault,
    autoSync: x.autoSync, exportedCount: exported, pendingCount: pending, notExportedCount: notExported, lastError: excelLastError[customerId] ?? null,
    currentFileId: x.id, filesCount: 1 + (db.customerFiles[customerId]?.length ?? 0),
  };
}

// ---- several files per customer (SPEC 6.8.4)
/** the file to write: the given one from the customer's list, or the current one */
function fileRow(customerId: number, fileId?: number) {
  const cur = db.customerExcel[customerId];
  if (fileId === undefined || cur?.id === fileId) return cur ?? fail('no_export_path', 'لا ملف Excel مرتبط بهذا العميل');
  return (db.customerFiles[customerId] ?? []).find((f) => f.id === fileId) ?? fail('not_found', 'الملف غير موجود في قائمة ملفات العميل');
}
const inFileList = (customerId: number, path: string) =>
  db.customerExcel[customerId]?.path === path || (db.customerFiles[customerId] ?? []).some((f) => f.path === path);
function takeFromList(customerId: number, path: string) {
  const f = (db.customerFiles[customerId] ?? []).find((x) => x.path === path);
  if (f) db.customerFiles[customerId] = db.customerFiles[customerId].filter((x) => x !== f);
  return f;
}
function newFileRow(path: string, startMode: CustomerExcelRow['startMode'], startValue: string | null, label: string | null): CustomerExcelRow {
  return { id: ++db.seq, label, startMode, startValue, createdAt: nowIso(), path, updatedAt: nowIso(), addToExcelByDefault: true, autoSync: true, linkedAt: nowIso(), items: [] };
}
/** the new current file; the previous current one goes to the top of the list */
function makeCurrent(customerId: number, row: CustomerExcelRow) {
  const prev = db.customerExcel[customerId];
  if (prev && prev !== row) (db.customerFiles[customerId] ??= []).unshift(prev);
  db.customerExcel[customerId] = row;
}
function fileView(f: CustomerExcelRow, isCurrent: boolean): CustomerExcelFile {
  return {
    id: f.id, path: f.path, label: f.label, isCurrent, exists: true, startMode: f.startMode, startValue: f.startValue,
    exportedCount: f.items.filter((i) => i.status === 'exported' && !i.covered).length, updatedAt: f.updatedAt, createdAt: f.createdAt,
  };
}

// ---- auto-sync (SPEC 6.8.3): written in the background after each money event
/** `?customerExcelLocked=1` (or setExcelLocked from a test): the file is open in Excel */
let excelLocked = new URLSearchParams(location.search).get('customerExcelLocked') === '1';
export const setExcelLocked = (v: boolean) => { excelLocked = v; };
const excelLastError: Record<number, AppError | null> = {};
const LOCKED: AppError = { code: 'file_locked', messageAr: 'الملف مفتوح في Excel. أغلقه وسيُرسل ما بانتظار التصدير.' };

/** Writes what is pending for this customer; returns what happened (used by events and "send now"). */
function flushPending(customerId: number) {
  const x = db.customerExcel[customerId];
  if (!x) return { added: 0, pending: 0, error: null as AppError | null };
  const pending = x.items.filter((i) => i.status === 'pending');
  if (excelLocked) { excelLastError[customerId] = LOCKED; return { added: 0, pending: pending.length, error: LOCKED }; }
  for (const i of pending) { i.status = 'exported'; i.exportedAt = nowIso(); }
  x.updatedAt = nowIso();
  excelLastError[customerId] = null;
  return { added: pending.length, pending: 0, error: null };
}

/** A money event happened: queue its row and write in the background (the money action is already saved). */
function syncEvent(customerId: number | null, ref: CustomerExcelItemRef) {
  if (customerId === null) return;
  const x = db.customerExcel[customerId];
  if (!x || !x.autoSync) return;
  const l = excelLine(customerId, ref);
  if ('reasonAr' in l || x.items.some((i) => i.kind === ref.kind && i.id === ref.id)) return;
  x.items.push({ kind: ref.kind, id: ref.id, currency: l.currency, date: l.date, status: 'pending', exportedAt: null });
  setTimeout(() => {
    const r = flushPending(customerId);
    void emit('customer-excel://synced', { customerId, ...r });
  }, 300);
}

type ExcelLine = CustomerExcelPreview['toAdd'][number];
function excelLine(customerId: number, ref: CustomerExcelItemRef): ExcelLine | CustomerExcelPreview['notAllowed'][number] {
  if (ref.kind === 'payout') {
    const p = db.payouts.find((x) => x.id === ref.id);
    if (!p || p.customerId !== customerId) return { kind: 'payout', id: ref.id, reasonAr: 'دفعة عميل آخر' };
    if (p.status !== 'sent') return { kind: 'payout', id: ref.id, reasonAr: p.status === 'draft' ? 'الدفعة مسجلة ولم تُرسل بعد' : 'الدفعة ملغاة' };
    return { kind: 'payout', id: p.id, date: p.date, labelAr: `دفعة ${p.seq} ${p.rangeLabel}`, currency: p.currency, amountMinor: -p.amountMinor };
  }
  const r = { kind: ref.kind, id: ref.id };
  if (ref.kind === 'txn') {
    const t = db.txns.find((x) => x.id === ref.id);
    if (!t) return { ...r, reasonAr: 'المعاملة غير موجودة' };
    if (t.customerId !== customerId) return { ...r, reasonAr: 'معاملة عميل آخر' };
    if (t.status !== 'approved') return { ...r, reasonAr: 'غير معتمدة؛ يُضاف للكشف ما اعتُمد فقط' };
    return { ...r, date: t.occurredAt.slice(0, 10), labelAr: `حوالة${t.customerSeq !== null ? ` #${t.customerSeq}` : ''} من ${t.payerName || t.payerEmail}`, currency: t.currency, amountMinor: t.customerAmountMinor ?? 0 };
  }
  const e = db.ledger.find((x) => x.id === ref.id);
  if (!e) return { ...r, reasonAr: 'القيد غير موجود' };
  if (e.customerId !== customerId) return { ...r, reasonAr: 'قيد عميل آخر' };
  if (e.type === 'credit') return { ...r, reasonAr: 'قيد اعتماد؛ أضف الحوالة نفسها من «معتمدة»' };
  return { ...r, date: e.entryDate, labelAr: e.description, currency: e.currency, amountMinor: e.amountMinor };
}

function excelPreview(customerId: number, items: CustomerExcelItemRef[], fileId?: number): CustomerExcelPreview {
  const out: CustomerExcelPreview = { toAdd: [], duplicates: [], notAllowed: [], olderThanLastRow: 0 };
  const x = db.customerExcel[customerId] || fileId ? fileRow(customerId, fileId) : undefined;
  // duplicates are checked per file (SPEC 6.8.4)
  const inExcel = (_c: number, kind: string, id: number) => !!x?.items.some((i) => i.kind === kind && i.id === id && i.status === 'exported');
  const last = x?.items.reduce((m, i) => (i.date > m ? i.date : m), '') ?? '';
  for (const ref of items) {
    const line = excelLine(customerId, ref);
    if ('reasonAr' in line) out.notAllowed.push(line);
    else if (inExcel(customerId, ref.kind, ref.id)) out.duplicates.push(line);
    else {
      out.toAdd.push(line);
      if (last && line.date < last) out.olderThanLastRow++;
    }
  }
  // statement order, whatever the selection order (SPEC 6.8.3): by date, the day's transfers by their #
  out.toAdd.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : statementRank(a) - statementRank(b)));
  return out;
}

function statementRank(l: { kind: string; id: number }) {
  if (l.kind === 'txn') return db.txns.find((t) => t.id === l.id)?.customerSeq ?? 0;
  return 1e6 + l.id;
}

function excelAdd(customerId: number, items: CustomerExcelItemRef[], fileId?: number) {
  const x = fileRow(customerId, fileId);
  if (excelLocked) fail('file_locked', 'أغلق الملف في Excel ثم أعد المحاولة');
  const p = excelPreview(customerId, items, fileId);
  if (items.length && !p.toAdd.length && !p.duplicates.length) fail('validation', p.notAllowed[0]?.reasonAr ?? 'لا شيء يمكن إضافته', 'items');
  for (const l of p.toAdd) {
    const ref = { kind: l.kind, id: l.id };
    const it = x.items.find((i) => i.kind === ref.kind && i.id === ref.id);
    if (it) { it.status = 'exported'; it.exportedAt = nowIso(); }
    else x.items.push({ kind: ref.kind, id: ref.id, currency: l.currency, date: l.date, status: 'exported', exportedAt: nowIso() });
  }
  excelLastError[customerId] = null;
  x.updatedAt = nowIso();
  return { path: x.path, added: p.toAdd.length, skippedDuplicates: p.duplicates.length, sheets: [...new Set(x.items.map((i) => `كشف ${i.currency}`))] };
}

/** Everything that can go into a statement today: approved transfers, and ledger lines that are not approval credits. */
function excelAllItems(customerId: number): CustomerExcelItemRef[] {
  const payoutEntries = new Set(db.payouts.map((p) => p.ledgerEntryId).filter((x) => x !== null));
  return [
    ...db.txns.filter((t) => t.customerId === customerId && t.status === 'approved').map((t) => ({ kind: 'txn' as const, id: t.id })),
    ...db.payouts.filter((p) => p.customerId === customerId && p.status === 'sent').map((p) => ({ kind: 'payout' as const, id: p.id })),
    ...db.ledger.filter((e) => e.customerId === customerId && e.type !== 'credit' && !payoutEntries.has(e.id)).map((e) => ({ kind: 'ledger' as const, id: e.id })),
  ];
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
        needsReview: false, reviewReasonAr: null, holdStatus: null, customerSeq: null, matched: false,
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
        rawEmailId: e.id, refundHandled: false, needsReview: true, reviewReasonAr: 'صيغة غير معروفة — راجع المبلغ والعملة والمرسل', holdStatus: null, customerSeq: null, matched: false,
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
      assignedAt: null, approvedAt: null, note: null, mailboxId, rawEmailId: null, refundHandled: false, needsReview: false, reviewReasonAr: null, holdStatus: null, customerSeq: null, matched: false,
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
    case 'customer_summary': return customerSummary(a.customerId, a.currency);
    case 'customer_statement': return customerStatement(a.customerId, a.currency, a.filter);
    case 'payout_prepare': return payoutPrepare(a.customerId, a.currency, a.selection);
    case 'payout_create': return payoutCreate(a);
    case 'payout_mark_sent': {
      const p = getPayout(a.payoutId);
      if (p.status !== 'draft') fail('invalid_transition', 'الدفعة ليست مسجلة بانتظار الإرسال');
      p.status = 'sent';
      if (a.date) p.date = a.date;
      payoutLedger(p);
      return payoutView(p);
    }
    case 'payout_update_details': { const p = getPayout(a.payoutId); p.details = { ...p.details, ...a.details }; return payoutView(p); }
    case 'payout_cancel': {
      const p = getPayout(a.payoutId);
      if (p.status === 'cancelled') fail('invalid_transition', 'الدفعة ملغاة أصلاً');
      if (!a.reason?.trim()) fail('validation', 'السبب إلزامي', 'reason');
      if (p.ledgerEntryId !== null) reverseEntry(p.ledgerEntryId, `إلغاء الدفعة ${p.seq}: ${a.reason}`);
      p.status = 'cancelled';
      return payoutView(p);
    }
    case 'payouts_list': return db.payouts.filter((p) => p.customerId === a.customerId && p.currency === a.currency).sort((x, y) => x.seq - y.seq).map(payoutView);
    case 'payout_defaults': {
      const last = [...db.payouts].filter((p) => p.customerId === a.customerId).sort((x, y) => y.id - x.id)[0];
      return last ? { ...last.details, reference: null, note: null } : null;
    }
    case 'payout_platform_suggestions': return [...new Set(['Binance', 'OKX', 'Bybit', ...db.payouts.map((p) => p.details.platform).filter(Boolean) as string[]])];
    case 'txn_set_matched': {
      const ok: number[] = [];
      for (const id of a.ids ?? []) { const t = db.txns.find((x) => x.id === id); if (t) { t.matched = !!a.matched; ok.push(id); } }
      return { ok, failed: [] };
    }
    case 'customer_excel_get': return excelView(a.customerId);
    case 'customer_excel_set_auto': {
      const x = db.customerExcel[a.customerId] ?? fail('no_export_path', 'لا ملف Excel مرتبط بهذا العميل');
      x.autoSync = !!a.autoSync;
      return excelView(a.customerId);
    }
    case 'customer_excel_send_unexported': {
      const x = fileRow(a.customerId, a.fileId);
      if (excelLocked) { excelLastError[a.customerId] = LOCKED; fail('file_locked', LOCKED.messageAr); }
      const missing = excelAllItems(a.customerId).filter((r) => !x.items.some((i) => i.kind === r.kind && i.id === r.id));
      const pendingBefore = x.items.filter((i) => i.status === 'pending').length;
      const r = excelAdd(a.customerId, missing, a.fileId);
      if (x === db.customerExcel[a.customerId]) flushPending(a.customerId);
      else for (const i of x.items) if (i.status === 'pending') { i.status = 'exported'; i.exportedAt = nowIso(); }
      return { path: r.path, added: r.added + pendingBefore, skippedDuplicates: r.skippedDuplicates, stillPending: 0 };
    }
    case 'customer_excel_unexported_summary':
      return Object.keys(db.customerExcel).map(Number).flatMap((cid) => {
        const v = excelView(cid);
        const c = db.customers.find((x) => x.id === cid);
        return v && c && v.pendingCount + v.notExportedCount > 0
          ? [{ customerId: cid, customerName: c.name, pending: v.pendingCount, notExported: v.notExportedCount, lastError: v.lastError }] : [];
      });
    case 'customer_excel_create': {
      if (inFileList(a.customerId, a.path)) fail('validation', 'هذا الملف في قائمة ملفات العميل أصلاً', 'path');
      makeCurrent(a.customerId, newFileRow(a.path, 'all', null, null));
      if (!a.includeExisting) return { path: a.path, added: 0, sheets: [] };
      const r = excelAdd(a.customerId, excelAllItems(a.customerId));
      return { path: r.path, added: r.added, sheets: r.sheets };
    }
    case 'customer_excel_link': {
      // ?wrongStatement=1: the chosen file is not this customer's statement
      if (new URLSearchParams(location.search).get('wrongStatement') === '1') fail('excel_layout', 'هذا الملف ليس كشف حساب أنشأه البرنامج لهذا العميل.');
      const listed = takeFromList(a.customerId, a.path);
      makeCurrent(a.customerId, listed ?? newFileRow(a.path, 'all', null, null));
      return excelView(a.customerId);
    }
    case 'customer_excel_unlink': {
      // the list of files stays (SPEC 6.8.4); only "current" goes
      const x = db.customerExcel[a.customerId];
      if (x) (db.customerFiles[a.customerId] ??= []).unshift(x);
      delete db.customerExcel[a.customerId];
      return null;
    }
    case 'customer_excel_files': {
      const cur = db.customerExcel[a.customerId];
      return [...(cur ? [cur] : []), ...(db.customerFiles[a.customerId] ?? [])].map((f) => fileView(f, f === cur));
    }
    case 'customer_excel_new_file': {
      if (inFileList(a.customerId, a.path)) fail('validation', 'هذا الملف في قائمة ملفات العميل أصلاً. اختر اسماً آخر.', 'path');
      const start = a.start as ExcelStart;
      const all = excelAllItems(a.customerId).map((r) => ({ r, l: excelLine(a.customerId, r) })).filter((x): x is { r: CustomerExcelItemRef; l: ExcelLine } => !('reasonAr' in x.l));
      let cutoff: (l: ExcelLine) => boolean = () => false;
      if (start.kind === 'carry_balance') cutoff = () => true;
      if (start.kind === 'from_date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start.date)) fail('validation', 'تاريخ غير صالح', 'start');
        cutoff = (l) => l.date < start.date;
      }
      if (start.kind === 'from_seq') {
        const firsts = db.txns.filter((t) => t.customerId === a.customerId && t.status === 'approved' && t.customerSeq === start.seq);
        if (!firsts.length) fail('validation', `لا حوالة معتمدة برقم #${start.seq}`, 'start');
        const from = new Map(firsts.map((t) => [t.currency, t.occurredAt.slice(0, 10)]));
        cutoff = (l) => { const d = from.get(l.currency); return d === undefined ? true : l.date < d; };
      }
      const row = newFileRow(a.path, start.kind, start.kind === 'from_date' ? start.date : start.kind === 'from_seq' ? String(start.seq) : null, a.label ?? null);
      const covered = start.kind === 'all' ? [] : all.filter((x) => cutoff(x.l));
      row.items = covered.map(({ l }) => ({ kind: l.kind, id: l.id, currency: l.currency, date: l.date, status: 'exported' as const, exportedAt: nowIso(), covered: true }));
      const prev = db.customerExcel[a.customerId];
      if (prev) { row.autoSync = prev.autoSync; row.addToExcelByDefault = prev.addToExcelByDefault; }
      if (a.makeCurrent) makeCurrent(a.customerId, row);
      else (db.customerFiles[a.customerId] ??= []).unshift(row);
      let added = new Set(covered.map(({ l }) => l.currency)).size; // one carried-balance row per currency
      if (start.kind !== 'carry_balance') added += excelAdd(a.customerId, all.filter((x) => !cutoff(x.l)).map((x) => x.r), row.id).added;
      return { file: fileView(row, db.customerExcel[a.customerId] === row), added, sheets: [...new Set(all.map((x) => `كشف ${x.l.currency}`))] };
    }
    case 'customer_excel_set_current': {
      const f = (db.customerFiles[a.customerId] ?? []).find((x) => x.id === a.fileId);
      if (!f && db.customerExcel[a.customerId]?.id !== a.fileId) fail('not_found', 'الملف غير موجود في قائمة ملفات العميل');
      if (f) { db.customerFiles[a.customerId] = db.customerFiles[a.customerId].filter((x) => x !== f); makeCurrent(a.customerId, f); }
      return excelView(a.customerId);
    }
    case 'customer_excel_item_files': {
      // the files this row was really written to (not lines covered by a carried balance), oldest export first
      const all = [...(db.customerFiles[a.customerId] ?? []), ...(db.customerExcel[a.customerId] ? [db.customerExcel[a.customerId]] : [])];
      return all.flatMap((f) => {
        const it = f.items.find((i) => i.kind === a.item?.kind && i.id === a.item?.id && i.status === 'exported' && !i.covered);
        return it ? [{ fileId: f.id, label: f.label, path: f.path, exportedAt: it.exportedAt ?? f.updatedAt ?? nowIso() }] : [];
      }).sort((x, y) => (x.exportedAt < y.exportedAt ? -1 : 1));
    }
    case 'customer_excel_remove_file': {
      if (db.customerExcel[a.customerId]?.id === a.fileId) fail('invalid_transition', 'لا يُزال الملف الحالي. اجعل ملفاً آخر هو الحالي أولاً.');
      db.customerFiles[a.customerId] = (db.customerFiles[a.customerId] ?? []).filter((x) => x.id !== a.fileId);
      return null;
    }
    case 'customer_excel_set_default': {
      const x = db.customerExcel[a.customerId] ?? fail('no_export_path', 'لا ملف Excel مرتبط بهذا العميل');
      x.addToExcelByDefault = !!a.addToExcelByDefault;
      return excelView(a.customerId);
    }
    case 'customer_excel_preview': return excelPreview(a.customerId, a.items ?? [], a.fileId);
    case 'customer_excel_add': return excelAdd(a.customerId, a.items ?? [], a.fileId);
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
        commissionMinor: null, customerAmountMinor: null, assignedAt: null, approvedAt: null, note: i.note || null, mailboxId: null, rawEmailId: i.rawEmailId ?? null, refundHandled: false, needsReview: false, reviewReasonAr: null, holdStatus: null, customerSeq: null, matched: false,
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
      const paid = addLedger({ customerId: a.customerId, currency: i.currency, type: 'payout', amountMinor: -amt, payoutMethod: i.method, reference: i.reference || null, description: i.description || ['دفعة', i.platform].filter(Boolean).join(' — '), entryDate: i.entryDate });
      syncEvent(a.customerId, { kind: 'ledger', id: paid.id });
      return paid;
    }
    case 'ledger_add_adjustment': {
      const i = a.input as AdjustmentInput;
      if (!i.description?.trim()) fail('validation', 'الوصف إلزامي', 'description');
      const amt = parseAmount(i.amountText, i.currency);
      const adj = addLedger({ customerId: a.customerId, currency: i.currency, type: 'adjustment', amountMinor: i.direction === 'credit' ? amt : -amt, description: i.description, entryDate: i.entryDate });
      syncEvent(a.customerId, { kind: 'ledger', id: adj.id });
      return adj;
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
      delete db.customerExcel[c.id]; // the file itself is not touched
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
      const rows = db.txns.length + db.ledger.length + db.customers.length + 8;
      // SPEC 6.8.1 append mode: new transactions are added, existing rows only get the program's columns
      if (db.settings.excelMode === 'append') {
        // ?excelLayout=1: the owner renamed a column the program writes to
        if (new URLSearchParams(location.search).get('excelLayout') === '1') fail('excel_layout', 'لم أجد عمود «العميل» في ورقة المعاملات. أعد العنوان كما كان أو اختر «إعادة كتابة كاملة».');
        const created = !db.settings.excelLastExportedAt;
        const fresh = db.txns.filter((t) => !excelExported.has(t.paypalTxnId));
        if (created) for (const t of db.txns) excelExported.add(t.paypalTxnId);
        const added = created ? 0 : fresh.length;
        for (const t of fresh) excelExported.add(t.paypalTxnId);
        const updated = created ? 0 : excelUpdates;
        excelUpdates = 0;
        db.settings.excelLastExportedAt = nowIso();
        return { path: db.settings.excelExportPath, sheets: 4, rows, exportedAt: db.settings.excelLastExportedAt, added, updated, created };
      }
      for (const t of db.txns) excelExported.add(t.paypalTxnId);
      excelUpdates = 0;
      db.settings.excelLastExportedAt = nowIso();
      return { path: db.settings.excelExportPath, sheets: 4, rows, exportedAt: db.settings.excelLastExportedAt, added: 0, updated: 0, created: false };
    }
    case 'excel_export_transactions': return { path: a.path, sheets: 1, rows: txnList(a.filter ?? {}, a.sort, 1, 100000).total + 1, exportedAt: nowIso(), added: 0, updated: 0, created: true };
    case 'excel_export_ledger': return { path: a.path, sheets: a.currency ? 1 : balances(a.customerId).length, rows: db.ledger.filter((e) => e.customerId === a.customerId).length, exportedAt: nowIso(), added: 0, updated: 0, created: true };
    case 'open_path': return null;

    // plugins
    case 'plugin:dialog|open': {
      if (a.options?.directory) return 'D:\\Backups\\PpFeez';
      const xlsx = (a.options?.filters as { extensions: string[] }[] | undefined)?.some((f) => f.extensions.includes('xlsx'));
      return xlsx ? 'D:\\العملاء\\كشف حساب.xlsx' : 'D:\\Backups\\PpFeez\\ppfeez-2026-11-22-2310.db';
    }
    case 'plugin:dialog|save': {
      const name = String(a.options?.defaultPath ?? 'export.csv');
      return `C:\\Users\\Mohammed\\Documents\\${name}`;
    }
    case 'plugin:opener|open_url': case 'plugin:opener|open_path': return null;
  }
  console.warn('[mock] unhandled command', cmd, a);
  return fail('internal', `أمر غير معروف في الوضع التجريبي: ${cmd}`);
}
