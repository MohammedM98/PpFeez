// In-memory stand-in for the Rust backend, used only in the browser (no Tauri).
// It follows SPEC §4 closely enough for the UI to be designed and tested end to end.
// Money arithmetic here simulates the backend; UI code must never do this.
import type {
  AppStatus, Customer, HistoryItem, LedgerEntry, Mailbox, PullRun, RawEmail, Settings,
  Transaction, TxnAction, TxnStatus, TxnType, CommissionMode, PayoutMethod, LedgerType, BackupFile, PayoutDetails,
} from '@/lib/contract';

export type TxnRow = Omit<Transaction, 'customer' | 'mailbox' | 'refundedBy' | 'allowedActions' | 'inCustomerExcel' | 'changedAfterExcel' | 'payout' | 'excelStatus'> & {
  customerId: number | null;
  mailboxId: number | null;
  refundHandled: boolean; // refund alert confirmed or dismissed
};
export type CustomerRow = Omit<Customer, 'balances' | 'pendingCount' | 'excel'>;
/** Stored entry; deletable/notDeletableReasonAr are computed when read (SPEC 4.7). */
export type LedgerRow = Omit<LedgerEntry, 'deletable' | 'notDeletableReasonAr' | 'inCustomerExcel' | 'excelStatus'>;
/** SPEC 6.8.2: the customer's linked statement file and what was added to it. */
/** SPEC 4.8: a payout covering numbered transfers. */
export type PayoutRow = {
  id: number; customerId: number; currency: string; seq: number; status: 'draft' | 'sent' | 'cancelled';
  amountMinor: number; dueMinor: number; date: string; rangeLabel: string; details: PayoutDetails;
  txnIds: number[]; ledgerIds: number[]; ledgerEntryId: number | null; createdAt: string; differenceReason: string | null;
};
export type CustomerExcelRow = {
  /** SPEC 6.8.4: one of the customer's files; `db.customerExcel` holds the current one, `db.customerFiles` the others */
  id: number; label: string | null; startMode: 'carry_balance' | 'all' | 'from_date' | 'from_seq'; startValue: string | null; createdAt: string;
  path: string; updatedAt: string | null; addToExcelByDefault: boolean;
  /** SPEC 6.8.3: every money event is appended automatically (on by default) */
  autoSync: boolean;
  /** pending = could not be written yet (file open, missing…); exported = in the file */
  /** covered = before the carried balance this file started with: counts as in the file, not as exported */
  items: { kind: 'txn' | 'ledger' | 'payout'; id: number; currency: string; date: string; status: 'pending' | 'exported'; exportedAt: string | null; covered?: boolean }[];
  linkedAt: string;
};

export type Db = {
  status: AppStatus;
  lockPassword: string | null;
  failedAttempts: number;
  settings: Settings;
  customers: CustomerRow[];
  txns: TxnRow[];
  ledger: LedgerRow[];
  history: (HistoryItem & { txnId: number })[];
  mailboxes: (Omit<Mailbox, 'running'> & { password: string | null })[];
  pullRuns: PullRun[];
  emails: RawEmail[];
  backups: BackupFile[];
  customerExcel: Record<number, CustomerExcelRow>;
  /** the customer's other (previous) files, newest first (SPEC 6.8.4) */
  customerFiles: Record<number, CustomerExcelRow[]>;
  payouts: PayoutRow[];
  /** last transfer number given per `${customerId}:${currency}` (a number is never reused) */
  txnSeq: Record<string, number>;
  seq: number;
};

const NOW = Date.now();
const daysAgo = (d: number, h = 10, m = 0) => {
  const t = new Date(NOW - d * 86400000);
  t.setHours(h, m, 0, 0);
  return t.toISOString();
};
const dayStr = (d: number) => daysAgo(d).slice(0, 10);

export function halfUp(net: number, bps: number): number {
  return Math.floor((net * bps + 5000) / 10000);
}

function mkCustomer(id: number, name: string, phone: string | null, bps: number, notes: string | null, active = true, ago = 120): CustomerRow {
  return { id, name, phone, defaultCommissionBps: bps, notes, isActive: active, createdAt: daysAgo(ago) };
}

type Seed = {
  id: number; d: number; h?: number; payer: string; email: string; note?: string | null; cur: string; gross: number;
  fee?: number | null; est?: boolean; status?: TxnStatus; cust?: number | null; bps?: number; mode?: CommissionMode; fixed?: number;
  type?: TxnType; related?: string | null; mb?: number; source?: 'email' | 'manual'; pp: string; myNote?: string | null;
  review?: string; hold?: 'pending_echeck' | 'on_hold';
};

function mkTxn(s: Seed): TxnRow {
  const fee = s.fee === undefined ? null : s.fee;
  const net = fee === null ? null : s.gross - fee;
  const status = s.status ?? 'unassigned';
  const assigned = status === 'pending_approval' || status === 'approved';
  const mode: CommissionMode | null = assigned ? (s.mode ?? 'percent') : null;
  const bps = assigned && mode === 'percent' ? (s.bps ?? 2500) : null;
  let commission: number | null = null;
  if (assigned && net !== null) commission = mode === 'fixed' ? (s.fixed ?? 0) : halfUp(net, bps!);
  return {
    id: s.id,
    source: s.source ?? 'email',
    paypalTxnId: s.pp,
    relatedTxnId: s.related ?? null,
    type: s.type ?? 'payment',
    payerName: s.payer,
    payerEmail: s.email,
    payerNote: s.note ?? null,
    currency: s.cur,
    grossMinor: s.gross,
    feeMinor: fee,
    netMinor: net,
    feeIsEstimated: s.est ?? false,
    occurredAt: daysAgo(s.d, s.h ?? 10, (s.id * 7) % 60),
    status,
    customerId: assigned ? (s.cust ?? null) : null,
    commissionMode: mode,
    commissionBps: bps,
    commissionMinor: commission,
    customerAmountMinor: commission !== null && net !== null ? net - commission : null,
    assignedAt: assigned ? daysAgo(s.d - 0.2) : null,
    approvedAt: status === 'approved' ? daysAgo(Math.max(0, s.d - 1)) : null,
    note: s.myNote ?? null,
    mailboxId: s.source === 'manual' ? null : (s.mb ?? 1),
    rawEmailId: s.source === 'manual' ? null : 1000 + s.id,
    refundHandled: false,
    needsReview: !!s.review,
    reviewReasonAr: s.review ?? null,
    holdStatus: s.hold ?? null,
    customerSeq: null,
    matched: false,
  };
}

export function seed(): Db {
  const customers: CustomerRow[] = [
    mkCustomer(1, 'أحمد يلماز', '+90 532 418 2290', 2500, 'يستلم نقداً في إسطنبول'),
    mkCustomer(2, 'علي حسن', '+964 770 155 3021', 2000, null),
    mkCustomer(3, 'سارة المصري', '+20 100 744 9182', 2500, 'تفضّل التحويل البنكي'),
    mkCustomer(4, 'يوسف الحربي', '+966 55 301 7745', 1500, 'عمولة مخفّضة بالاتفاق'),
    mkCustomer(5, 'مريم خليل', null, 2500, null),
    mkCustomer(6, 'خالد العمري', '+962 79 640 1183', 2500, 'توقف عن العمل معنا', false, 300),
    mkCustomer(8, 'هشام الزعبي', '+962 78 551 2040', 2000, 'يستلم USDT على Binance', true, 90),
  ];

  const T: Seed[] = [
    // unassigned, fresh from mail
    { id: 1, d: 0, h: 9, payer: 'Emily Carter', email: 'emily.carter@gmail.com', note: 'Logo design — final payment', cur: 'USD', gross: 24000, fee: 1056, pp: '7QW41983KD2240145' },
    { id: 2, d: 1, h: 18, payer: 'Lucas Brown', email: 'lucas.b@outlook.com', note: 'March invoice', cur: 'USD', gross: 8550, fee: null, pp: '3HN20476PA9918320' },
    { id: 3, d: 2, h: 14, payer: 'Marta Nowak', email: 'm.nowak@wp.pl', note: null, cur: 'EUR', gross: 6000, fee: 239, pp: '8RT55021LM4410972' },
    { id: 4, d: 2, h: 11, payer: 'Mehmet Kaya', email: 'mehmet.kaya@yandex.com.tr', note: 'Sipariş #4471', cur: 'TRY', gross: 425000, fee: null, pp: '1VB88310CC5532018' },
    { id: 5, d: 3, h: 16, payer: 'Daniel Fischer', email: 'd.fischer@gmx.de', note: 'Übersetzung', cur: 'EUR', gross: 15000, fee: 715, est: true, pp: '5KD12093XZ7731554' },
    // pending approval
    { id: 6, d: 4, h: 10, payer: 'John Doe', email: 'john.doe@gmail.com', note: 'Website hosting 2026', cur: 'USD', gross: 10000, fee: 500, status: 'pending_approval', cust: 1, pp: '9PL33104TT2287461' },
    { id: 7, d: 5, h: 13, payer: 'Maria Garcia', email: 'maria.garcia@yahoo.es', note: 'Consultoría', cur: 'USD', gross: 5000, fee: null, status: 'pending_approval', cust: 1, pp: '8KL98765ZX4321090' },
    { id: 8, d: 5, h: 9, payer: 'Sophie Martin', email: 'sophie.martin@orange.fr', note: null, cur: 'EUR', gross: 32000, fee: 1158, status: 'pending_approval', cust: 3, pp: '2MM60418QA0011873' },
    { id: 9, d: 6, h: 20, payer: 'Ayşe Demir', email: 'ayse.demir@gmail.com', note: 'Danışmanlık', cur: 'TRY', gross: 1250000, fee: 52500, status: 'pending_approval', cust: 4, bps: 1500, pp: '6GH70092RB3345108' },
    // approved
    { id: 10, d: 12, h: 12, payer: 'John Doe', email: 'john.doe@gmail.com', note: 'Monthly retainer', cur: 'USD', gross: 10000, fee: 398, status: 'approved', cust: 1, pp: '5TY12345AB678901C' },
    { id: 11, d: 14, h: 15, payer: 'Hans Müller', email: 'hans.mueller@web.de', note: 'Projekt Alpha', cur: 'EUR', gross: 125050, fee: 4392, status: 'approved', cust: 2, bps: 2000, pp: '2CD34567EF890123G' },
    { id: 12, d: 18, h: 10, payer: 'Olivia Wilson', email: 'olivia.w@icloud.com', note: 'App UI', cur: 'USD', gross: 45000, fee: 1599, status: 'approved', cust: 3, pp: '4QA77120HJ5590321' },
    { id: 13, d: 20, h: 17, payer: 'Can Öztürk', email: 'can.ozturk@hotmail.com', note: null, cur: 'TRY', gross: 860000, fee: 36120, status: 'approved', cust: 4, bps: 1500, pp: '7ZX40019MN2268145' },
    { id: 14, d: 25, h: 11, payer: 'Noah Smith', email: 'noah.smith@gmail.com', note: 'Video editing', cur: 'USD', gross: 30000, fee: 1077, status: 'approved', cust: 2, bps: 2000, pp: '1RE90334KL6612097' },
    { id: 15, d: 33, h: 9, payer: 'Emma Johnson', email: 'emma.j@proton.me', note: 'Fixed fee job', cur: 'USD', gross: 20000, fee: 728, status: 'approved', cust: 5, mode: 'fixed', fixed: 4000, pp: '3WE22871OP4409716' },
    // excluded (mine)
    { id: 16, d: 8, h: 19, payer: 'PayPal Cashback', email: 'service@paypal.com', note: 'Cashback reward', cur: 'USD', gross: 1250, fee: 0, status: 'excluded', pp: '0CB11234PP0000001', myNote: 'مكافأة شخصية' },
    // refund of approved txn 10 -> alert
    { id: 17, d: 1, h: 8, payer: 'John Doe', email: 'john.doe@gmail.com', note: null, cur: 'USD', gross: -10000, fee: 0, status: 'unassigned', type: 'refund', related: '5TY12345AB678901C', pp: '9RF11111AA222222B' },
    // manual entry
    // 0.2.1: PayPal Israel mail, a generic-parser result to review, eCheck pending, payment on hold
    { id: 19, d: 0, h: 11, payer: 'Yossi Cohen', email: 'yossi.cohen@gmail.com', note: 'עבור עיצוב לוגו', cur: 'ILS', gross: 120000, fee: null, pp: '4LK20991BV3318274', review: 'صيغة غير معروفة — راجع المبلغ والعملة والمرسل' },
    { id: 20, d: 1, h: 15, payer: 'Rachel Levi', email: 'rachel.levi@walla.co.il', note: null, cur: 'USD', gross: 35000, fee: 1250, pp: '6MN44012DE7781925', hold: 'pending_echeck' },
    { id: 21, d: 3, h: 9, payer: 'Murat Arslan', email: 'murat.arslan@gmail.com', note: 'Web tasarım', cur: 'TRY', gross: 640000, fee: 26880, pp: '2PQ88120RT4419063', hold: 'on_hold' },
    { id: 18, d: 9, h: 13, payer: 'تحويل من بشير', email: '', note: null, cur: 'USD', gross: 15000, fee: 450, status: 'pending_approval', cust: 5, source: 'manual', pp: 'MANUAL-0018', myNote: 'أُدخلت يدوياً من لقطة شاشة' },
  ];
  // هشام الزعبي (SPEC 4.8): numbered transfers, one payout sent (#1-3), one recorded but not sent (#4-5), the rest unpaid
  const H: [number, string, string, number, number, string | null][] = [
    [31, 'Liam Turner', 'liam.turner@gmail.com', 30000, 1200, 'Website build'],
    [32, 'Ava Collins', 'ava.collins@outlook.com', 12500, 511, null],
    [33, 'Mason Reed', 'mason.reed@yahoo.com', 48000, 1902, 'Logo + brand kit'],
    [34, 'Liam Turner', 'liam.turner@gmail.com', 30000, 1200, 'Website build — part 2'],
    [35, 'Chloe Price', 'chloe.price@icloud.com', 9000, 384, null],
    [36, 'Ethan Brooks', 'ethan.brooks@gmail.com', 22000, 896, 'Consulting'],
    [37, 'Ava Collins', 'ava.collins@outlook.com', 15000, 615, null],
    [38, 'Noah Bennett', 'noah.bennett@proton.me', 64000, 2526, 'App MVP'],
  ];
  H.forEach(([id, payer, email, gross, fee, note], i) => T.push({ id, d: 34 - i * 3, h: 11, payer, email, note, cur: 'USD', gross, fee, status: 'approved', cust: 8, bps: 2000, pp: `8HZ${String(id).padStart(2, '0')}10${i}7LK9${i}2Q` }));
  const txns = T.map(mkTxn);

  const ledger: LedgerRow[] = [];
  let lid = 0;
  const push = (e: Omit<LedgerRow, 'id' | 'runningBalanceMinor' | 'reversedByEntryId' | 'createdAt'> & { createdAt?: string }) => {
    const entry: LedgerRow = { ...e, id: ++lid, runningBalanceMinor: 0, reversedByEntryId: null, createdAt: e.createdAt ?? daysAgo(0) };
    ledger.push(entry);
    return entry;
  };
  // opening balance for Ali
  push({ customerId: 2, currency: 'USD', type: 'adjustment', amountMinor: 12000, transactionId: null, reversesEntryId: null, payoutMethod: null, reference: null, description: 'رصيد افتتاحي من الدفتر الورقي', entryDate: dayStr(40) });
  for (const t of txns.filter((x) => x.status === 'approved')) {
    push({
      customerId: t.customerId!, currency: t.currency, type: 'credit', amountMinor: t.customerAmountMinor!, transactionId: t.id,
      reversesEntryId: null, payoutMethod: null, reference: t.paypalTxnId,
      description: creditDescription(t), entryDate: t.approvedAt!.slice(0, 10), createdAt: t.approvedAt!,
    });
  }
  push({ customerId: 1, currency: 'USD', type: 'payout', amountMinor: -5000, transactionId: null, reversesEntryId: null, payoutMethod: 'cash', reference: null, description: 'دفعة نقدية في المكتب', entryDate: dayStr(7) });
  push({ customerId: 2, currency: 'EUR', type: 'payout', amountMinor: -50000, transactionId: null, reversesEntryId: null, payoutMethod: 'bank', reference: 'TR-2026-1184', description: 'تحويل بنكي', entryDate: dayStr(10) });
  push({ customerId: 3, currency: 'USD', type: 'payout', amountMinor: -20000, transactionId: null, reversesEntryId: null, payoutMethod: 'usdt', reference: 'TXID 0x9f3…a21c', description: 'USDT على شبكة TRC20', entryDate: dayStr(9) });
  // a mistaken payout, then reversed
  const wrong = push({ customerId: 2, currency: 'USD', type: 'payout', amountMinor: -15000, transactionId: null, reversesEntryId: null, payoutMethod: 'cash', reference: null, description: 'دفعة نقدية', entryDate: dayStr(6) });
  const rev = push({ customerId: 2, currency: 'USD', type: 'reversal', amountMinor: 15000, transactionId: null, reversesEntryId: wrong.id, payoutMethod: null, reference: null, description: 'عكس: دفعة نقدية — سُجّلت مرتين', entryDate: dayStr(6) });
  wrong.reversedByEntryId = rev.id;
  push({ customerId: 2, currency: 'USD', type: 'payout', amountMinor: -15000, transactionId: null, reversesEntryId: null, payoutMethod: 'cash', reference: null, description: 'دفعة نقدية', entryDate: dayStr(5) });
  push({ customerId: 4, currency: 'TRY', type: 'payout', amountMinor: -400000, transactionId: null, reversesEntryId: null, payoutMethod: 'bank', reference: 'Ziraat 55120', description: 'تحويل بنكي', entryDate: dayStr(3) });
  push({ customerId: 5, currency: 'USD', type: 'payout', amountMinor: -20000, transactionId: null, reversesEntryId: null, payoutMethod: 'paypal', reference: null, description: 'إرسال عبر PayPal', entryDate: dayStr(2) });

  // transfer numbers per customer and currency, in approval order (SPEC 4.8)
  const txnSeq: Record<string, number> = {};
  for (const t of txns.filter((x) => x.status === 'approved').sort((a, b) => (a.approvedAt! === b.approvedAt! ? a.id - b.id : a.approvedAt! < b.approvedAt! ? -1 : 1))) {
    const k = `${t.customerId}:${t.currency}`;
    t.customerSeq = txnSeq[k] = (txnSeq[k] ?? 0) + 1;
  }
  // هشام الزعبي: payout 1 sent (USDT on Binance, TRC20) for #1-3, payout 2 recorded by bank for #4-5
  const hisham = txns.filter((t) => t.customerId === 8).sort((a, b) => a.customerSeq! - b.customerSeq!);
  const due = (xs: TxnRow[]) => xs.reduce((n, t) => n + (t.customerAmountMinor ?? 0), 0);
  const p1 = hisham.slice(0, 3), p2 = hisham.slice(3, 5);
  for (const t of p1) t.matched = true;
  const p1Entry = push({ customerId: 8, currency: 'USD', type: 'payout', amountMinor: -due(p1), transactionId: null, reversesEntryId: null, payoutMethod: 'usdt', reference: '0x7c2f19e4a0b38d55a1f2c09e4b7d9a41', description: 'دفعة 1 (1-3)', entryDate: dayStr(20) });
  // a return after the first payout: a partial PayPal refund to Ava Collins, deducted from the next payout (SPEC 4.8)
  push({ customerId: 8, currency: 'USD', type: 'adjustment', amountMinor: -2000, transactionId: null, reversesEntryId: null, payoutMethod: null, reference: '8HZ37RET', description: 'مرتجع: استرداد جزئي لـ Ava Collins', entryDate: dayStr(9) });
  const payouts: PayoutRow[] = [
    { id: 1, customerId: 8, currency: 'USD', seq: 1, status: 'sent', amountMinor: due(p1), dueMinor: due(p1), date: dayStr(20), rangeLabel: '(1-3)',
      details: { method: 'usdt', platform: 'Binance', network: 'TRC20', destination: 'TQx7mWn2r8VbP3kJd9sHe4L1aZc6Yk9Lm', reference: '0x7c2f19e4a0b38d55a1f2c09e4b7d9a41', note: null },
      txnIds: p1.map((t) => t.id), ledgerIds: [], ledgerEntryId: p1Entry.id, createdAt: daysAgo(20), differenceReason: null },
    { id: 2, customerId: 8, currency: 'USD', seq: 2, status: 'draft', amountMinor: due(p2), dueMinor: due(p2), date: dayStr(4), rangeLabel: '(4-5)',
      details: { method: 'bank', platform: 'بنك الاتحاد', network: null, destination: 'JO94 UBSI 1030 0000 0012 3456 7890 12', reference: null, note: 'بانتظار تأكيد العميل للحساب' },
      txnIds: p2.map((t) => t.id), ledgerIds: [], ledgerEntryId: null, createdAt: daysAgo(4), differenceReason: null },
  ];

  const emails: RawEmail[] = [];
  for (const t of txns.filter((x) => x.rawEmailId)) {
    emails.push({
      id: t.rawEmailId!, mailboxLabel: t.mailboxId === 2 ? 'Gmail الاحتياطي' : 'Gmail الرئيسي', fromAddr: t.id === 19 || t.id === 20 ? 'service@paypal.co.il' : 'service@paypal.com',
      subject: t.type === 'refund' ? 'You issued a refund' : `You've got money`, receivedAt: t.occurredAt,
      parseStatus: 'parsed', parseReason: null, parseReasonAr: null, transactionId: t.id, parserName: t.type === 'refund' ? 'refund_v1' : 'payment_v2',
      bodyHtml: paypalHtml(t), bodyText: null,
    });
  }
  const failed: [string, string, string, string, number][] = [
    ['service@paypal.com', 'You received a payment', 'amount_not_found', 'لم يُعثر على المبلغ في الرسالة', 1],
    ['service@paypal.com', 'Payment received from Kevin Lee', 'unknown_template', 'قالب رسالة غير معروف', 2],
    ['service@paypal.com', 'تم استلام دفعة', 'currency_not_found', 'لم تُعرف العملة', 0],
  ];
  failed.forEach(([from, subject, reason, reasonAr, d], i) =>
    emails.push({ id: 2000 + i, mailboxLabel: 'Gmail الرئيسي', fromAddr: from, subject, receivedAt: daysAgo(d, 7 + i), parseStatus: 'failed', parseReason: reason, parseReasonAr: reasonAr, transactionId: null, parserName: null, bodyText: null, bodyHtml: '<div style="font-family:sans-serif"><h2>Hello,</h2><p>You received a payment of <b>$64.00</b> from Kevin Lee.</p><img src="https://www.paypalobjects.com/x.png" alt="logo"></div>' }));
  const ignored: [string, string, string, string][] = [
    ['service@paypal.com', 'Your monthly account statement is ready', 'not_financial', 'رسالة غير مالية'],
    ['security@paypal.com', 'New login to your account', 'not_financial', 'رسالة غير مالية'],
    ['paypal@mail.paypal-support.net', 'Action required: confirm your account', 'sender_unverified', 'المرسل غير موثَّق (فشل DKIM)'],
    ['service@paypal.com.eg', 'لقد استلمت دفعة', 'unknown_paypal_domain', 'نطاق PayPal غير معروف'],
    ['service@paypal.com.eg', 'You received a payment from Omar Nabil', 'unknown_paypal_domain', 'نطاق PayPal غير معروف'],
  ];
  ignored.forEach(([from, subject, reason, reasonAr], i) =>
    emails.push({ id: 3000 + i, mailboxLabel: 'Gmail الرئيسي', fromAddr: from, subject, receivedAt: daysAgo(i + 2, 12), parseStatus: 'ignored', parseReason: reason, parseReasonAr: reasonAr, transactionId: null, parserName: null, bodyText: 'Statement ready.', bodyHtml: null }));

  const db: Db = {
    status: { version: '0.1.0', locked: false, lockEnabled: true, onboardingDone: true, dataDir: 'C:\\Users\\Mohammed\\AppData\\Roaming\\PpFeez' },
    lockPassword: '1234',
    failedAttempts: 0,
    settings: {
      theme: 'dark', defaultCommissionBps: 2500, feeEstimateEnabled: true, feeEstimateBps: 440, feeEstimateFixedMinor: 30,
      backupDir: 'D:\\Backups\\PpFeez', backupOnClose: true, backupKeep: 30, autoLockMinutes: 15, onboardingDone: true,
      excelExportPath: 'D:\\PpFeez\\PpFeez.xlsx', excelLastExportedAt: daysAgo(1, 22, 40), excelUpdateOnClose: true,
      autoCheckUpdates: true,
      excelMode: 'append',
      accent: 'blue', density: 'regular', uiScale: 100, uiPrefs: '{}',
      extraPaypalDomains: [],
      builtinPaypalDomains: ['paypal.com', 'paypal.co.il', 'paypal.co.uk'], // same as BUILTIN in the backend
    },
    customers, txns, ledger,
    history: [],
    mailboxes: [
      { id: 1, label: 'Gmail الرئيسي', email: 'payments.mohammed@gmail.com', host: 'imap.gmail.com', port: 993, folder: 'INBOX', isActive: true, hasPassword: true, lastPulledAt: daysAgo(0, 8, 25), lastUid: 48211, password: 'x' },
      { id: 2, label: 'Gmail الاحتياطي', email: 'mohammed.pp2@gmail.com', host: 'imap.gmail.com', port: 993, folder: 'INBOX', isActive: false, hasPassword: false, lastPulledAt: null, lastUid: 0, password: null },
    ],
    pullRuns: [
      { id: 3, mailboxId: 1, mailboxLabel: 'Gmail الرئيسي', status: 'done', totalCount: 6, fetchedCount: 6, newTransactionsCount: 3, duplicateCount: 0, ignoredCount: 2, failedCount: 1, error: null, startedAt: daysAgo(0, 8, 24), finishedAt: daysAgo(0, 8, 25), range: { kind: 'new' } },
      { id: 2, mailboxId: 1, mailboxLabel: 'Gmail الرئيسي', status: 'failed', totalCount: 0, fetchedCount: 0, newTransactionsCount: 0, duplicateCount: 0, ignoredCount: 0, failedCount: 0, error: 'تعذّر الاتصال بخادم البريد', startedAt: daysAgo(2, 21, 3), finishedAt: daysAgo(2, 21, 3), range: { kind: 'new' } },
      { id: 1, mailboxId: 1, mailboxLabel: 'Gmail الرئيسي', status: 'done', totalCount: 41, fetchedCount: 41, newTransactionsCount: 14, duplicateCount: 0, ignoredCount: 25, failedCount: 2, error: null, startedAt: daysAgo(30, 10), finishedAt: daysAgo(30, 10, 2), range: { kind: 'last_days', days: 90 } },
    ],
    emails,
    backups: [
      { path: 'D:\\Backups\\PpFeez\\ppfeez-2026-11-22-2310.db', createdAt: daysAgo(1, 23, 10), sizeBytes: 1_482_752 },
      { path: 'D:\\Backups\\PpFeez\\ppfeez-2026-11-21-2245.db', createdAt: daysAgo(2, 22, 45), sizeBytes: 1_437_696 },
      { path: 'D:\\Backups\\PpFeez\\ppfeez-2026-11-19-2002.db', createdAt: daysAgo(4, 20, 2), sizeBytes: 1_392_640 },
    ],
    // علي حسن already has a statement with his opening balance and one transfer in it (SPEC 6.8.2)
    payouts,
    txnSeq,
    customerExcel: {
      2: {
        id: 9001, label: null, startMode: 'all', startValue: null, createdAt: daysAgo(20),
        path: 'D:\\العملاء\\كشف حساب - علي حسن.xlsx', updatedAt: daysAgo(3, 18, 5), addToExcelByDefault: true, autoSync: true, linkedAt: daysAgo(20),
        items: [
          { kind: 'ledger', id: 1, currency: 'USD', date: dayStr(40), status: 'exported', exportedAt: daysAgo(20) },
          { kind: 'txn', id: 11, currency: 'EUR', date: daysAgo(14).slice(0, 10), status: 'exported', exportedAt: daysAgo(13) },
        ],
      },
      // هشام الزعبي: #1-3 and payout 1 are in his file; the rest happened while it was not linked (SPEC 6.8.3)
      8: {
        id: 9002, label: null, startMode: 'all', startValue: null, createdAt: daysAgo(30),
        path: 'D:\\العملاء\\كشف حساب - هشام الزعبي.xlsx', updatedAt: daysAgo(20, 12), addToExcelByDefault: true, autoSync: true, linkedAt: daysAgo(30),
        items: [
          ...p1.map((t) => ({ kind: 'txn' as const, id: t.id, currency: 'USD', date: t.occurredAt.slice(0, 10), status: 'exported' as const, exportedAt: daysAgo(20, 12) })),
          { kind: 'payout', id: 1, currency: 'USD', date: dayStr(20), status: 'exported', exportedAt: daysAgo(20, 12) },
        ],
      },
    },
    customerFiles: {},
    seq: 5000,
  };

  for (const t of txns) {
    db.history.push({ txnId: t.id, id: ++db.seq, action: 'created', labelAr: t.source === 'manual' ? 'أُضيفت يدوياً' : 'سُحبت من البريد', details: {}, createdAt: t.occurredAt });
    if (t.assignedAt) db.history.push({ txnId: t.id, id: ++db.seq, action: 'assigned', labelAr: 'خُصّصت لعميل', details: {}, createdAt: t.assignedAt });
    if (t.approvedAt) db.history.push({ txnId: t.id, id: ++db.seq, action: 'approved', labelAr: 'اعتُمدت', details: {}, createdAt: t.approvedAt });
  }
  return db;
}

/** Same as ltr() in the backend: isolate numbers inside generated Arabic text (U+2066 … U+2069). */
export const ltr = (s: string) => `\u2066${s}\u2069`;

export function creditDescription(t: Pick<TxnRow, 'payerName' | 'grossMinor' | 'feeMinor' | 'currency' | 'commissionMode' | 'commissionBps' | 'commissionMinor'>): string {
  const f = (m: number) => fmt(m, t.currency);
  const c = t.commissionMode === 'percent' ? `${(t.commissionBps! / 100).toFixed(2)}%` : f(t.commissionMinor ?? 0);
  return `دفعة من ${t.payerName ?? '—'} — أصلي ${ltr(f(t.grossMinor))}، رسوم ${ltr(f(t.feeMinor ?? 0))}، عمولة ${ltr(c)}`;
}

function fmt(minor: number, cur: string) {
  const neg = minor < 0;
  const s = String(Math.abs(minor)).padStart(3, '0');
  return `${neg ? '-' : ''}${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${s.slice(-2)} ${cur}`;
}

function paypalHtml(t: TxnRow) {
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:auto;color:#222">
<p style="font-size:20px">${t.type === 'refund' ? 'You sent a refund' : `${t.payerName} sent you ${fmt(t.grossMinor, t.currency)}`}</p>
<table style="width:100%;font-size:14px;border-collapse:collapse">
<tr><td style="padding:6px 0;color:#666">Transaction ID</td><td>${t.paypalTxnId}</td></tr>
<tr><td style="padding:6px 0;color:#666">Transaction date</td><td>${t.occurredAt.slice(0, 10)}</td></tr>
<tr><td style="padding:6px 0;color:#666">Amount received</td><td>${fmt(t.grossMinor, t.currency)}</td></tr>
${t.payerNote ? `<tr><td style="padding:6px 0;color:#666">Note</td><td>${t.payerNote}</td></tr>` : ''}
</table><img src="https://www.paypalobjects.com/digitalassets/c/website/logo/full-text/pp_fc_hl.svg" alt="PayPal" width="90"></div>`;
}

export type { TxnAction, PayoutMethod, LedgerType };

/**
 * `?stress=1`: long names and large amounts in several currencies, for the table alignment
 * checks (SPEC 6, "محاذاة الجداول"; SPEC 10).
 */
export function addStressData(db: Db) {
  db.customers.push(mkCustomer(7, 'عبد الرحمن بن عبد العزيز الشمري للتجارة العامة والمقاولات', '+971 50 118 2299 4471', 1750, 'عميل بأسماء طويلة ومبالغ كبيرة'));
  const T: Seed[] = [
    { id: 101, d: 0, h: 7, payer: 'Maximilian Alexander von Hohenzollern-Sigmaringen', email: 'maximilian.alexander.hohenzollern@company-international.example', note: 'Annual enterprise licence renewal for the whole group, invoice INV-2026-000184', cur: 'USD', gross: 123456789, fee: 4320987, pp: '9XX11111AA1111111' },
    { id: 102, d: 0, h: 6, payer: 'Charlotte Montgomery-Fairweather', email: 'c.montgomery@example.co.uk', note: 'Quarterly retainer', cur: 'AUD', gross: 98765432, fee: null, pp: '9XX22222BB2222222' },
    { id: 103, d: 1, h: 7, payer: '', email: 'no-name-sender-with-a-very-long-address@example.com', note: null, cur: 'EUR', gross: 4599, fee: 186, pp: '9XX33333CC3333333' },
    { id: 104, d: 1, h: 6, payer: 'Satoshi Nakamura', email: 'satoshi@example.jp', note: '本番', cur: 'JPY', gross: 1500000, fee: 54000, pp: '9XX44444DD4444444' },
    { id: 105, d: 2, h: 7, payer: 'Maximilian Alexander von Hohenzollern-Sigmaringen', email: 'maximilian.alexander.hohenzollern@company-international.example', note: 'Second instalment', cur: 'USD', gross: 87654321, fee: 3068401, status: 'pending_approval', cust: 7, bps: 1750, pp: '9XX55555EE5555555' },
    { id: 106, d: 3, h: 7, payer: 'Charlotte Montgomery-Fairweather', email: 'c.montgomery@example.co.uk', note: 'Project Phoenix — milestone 3 of 5', cur: 'AUD', gross: 54321098, fee: 1901238, status: 'approved', cust: 7, bps: 1750, pp: '9XX66666FF6666666' },
    { id: 107, d: 4, h: 7, payer: 'Ayşegül Karadeniz-Yıldırım', email: 'aysegul.karadeniz@example.com.tr', note: 'Toplu ödeme', cur: 'TRY', gross: 123456789, fee: 5185185, status: 'approved', cust: 7, bps: 1750, pp: '9XX77777GG7777777' },
  ];
  const txns = T.map(mkTxn);
  db.txns.push(...txns);
  // approved transfers carry their number (#) per customer and currency, as the core gives them (SPEC 4.8)
  for (const t of txns.filter((x) => x.status === 'approved')) {
    const k = `${t.customerId}:${t.currency}`;
    t.customerSeq = db.txnSeq[k] = (db.txnSeq[k] ?? 0) + 1;
  }
  for (const t of txns) {
    db.history.push({ txnId: t.id, id: ++db.seq, action: 'created', labelAr: 'سُحبت من البريد', details: {}, createdAt: t.occurredAt });
    db.emails.push({
      id: t.rawEmailId!, mailboxLabel: 'Gmail الرئيسي', fromAddr: 'service@paypal.com', subject: `You've got money from ${t.payerName || t.payerEmail} — payment notification with a long subject line`,
      receivedAt: t.occurredAt, parseStatus: 'parsed', parseReason: null, parseReasonAr: null, transactionId: t.id, parserName: 'payment_v2', bodyHtml: paypalHtml(t), bodyText: null,
    });
    if (t.status === 'approved') {
      db.ledger.push({
        id: ++db.seq, customerId: 7, currency: t.currency, type: 'credit', amountMinor: t.customerAmountMinor!, transactionId: t.id, reversesEntryId: null,
        payoutMethod: null, reference: t.paypalTxnId, description: creditDescription(t), entryDate: t.approvedAt!.slice(0, 10), createdAt: t.approvedAt!,
        runningBalanceMinor: 0, reversedByEntryId: null,
      });
    }
  }
  db.ledger.push({
    id: ++db.seq, customerId: 7, currency: 'TRY', type: 'payout', amountMinor: -98765432, transactionId: null, reversesEntryId: null, payoutMethod: 'bank',
    reference: 'Ziraat Bankası TR33 0006 1005 1978 6457 8413 26', description: 'تحويل بنكي إلى حساب الشركة في إسطنبول بعد مطابقة الكشف الشهري مع المحاسب', entryDate: dayStr(1), createdAt: daysAgo(1),
    runningBalanceMinor: 0, reversedByEntryId: null,
  });
}

/** `?rows=N`: N more unassigned transactions in the inbox, for the long-list checks (SPEC 6.10). */
export function addManyRows(db: Db, n: number) {
  const names = ['Liam Turner', 'Ava Collins', 'Noah Bennett', 'Chloe Price', 'Ethan Brooks', 'Mia Foster', 'Lucas Gray', 'Emma Reed'];
  const curs = ['USD', 'EUR', 'TRY'];
  for (let i = 0; i < n; i++) {
    const t = mkTxn({
      id: 100000 + i, d: Math.floor(i / 40), h: 23 - (i % 20), payer: `${names[i % names.length]} ${i + 1}`, email: `buyer${i + 1}@example.com`,
      note: i % 3 ? `Order #${10000 + i}` : null, cur: curs[i % curs.length], gross: 1000 + ((i * 7919) % 250000), fee: i % 9 ? 50 + (i % 400) : null,
      pp: `9ZZ${String(i).padStart(14, '0')}`,
    });
    t.rawEmailId = null;
    db.txns.push(t);
  }
}
