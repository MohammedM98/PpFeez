// In-memory stand-in for the Rust backend, used only in the browser (no Tauri).
// It follows SPEC §4 closely enough for the UI to be designed and tested end to end.
// Money arithmetic here simulates the backend; UI code must never do this.
import type {
  AppStatus, Customer, HistoryItem, LedgerEntry, Mailbox, PullRun, RawEmail, Settings,
  Transaction, TxnAction, TxnStatus, TxnType, CommissionMode, PayoutMethod, LedgerType, BackupFile,
} from '@/lib/contract';

export type TxnRow = Omit<Transaction, 'customer' | 'mailbox' | 'refundedBy' | 'allowedActions'> & {
  customerId: number | null;
  mailboxId: number | null;
  refundHandled: boolean; // refund alert confirmed or dismissed
};
export type CustomerRow = Omit<Customer, 'balances' | 'pendingCount'>;

export type Db = {
  status: AppStatus;
  lockPassword: string | null;
  failedAttempts: number;
  settings: Settings;
  customers: CustomerRow[];
  txns: TxnRow[];
  ledger: LedgerEntry[];
  history: (HistoryItem & { txnId: number })[];
  mailboxes: (Omit<Mailbox, 'running'> & { password: string | null })[];
  pullRuns: PullRun[];
  emails: RawEmail[];
  backups: BackupFile[];
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
    { id: 18, d: 9, h: 13, payer: 'تحويل من بشير', email: '', note: null, cur: 'USD', gross: 15000, fee: 450, status: 'pending_approval', cust: 5, source: 'manual', pp: 'MANUAL-0018', myNote: 'أُدخلت يدوياً من لقطة شاشة' },
  ];
  const txns = T.map(mkTxn);

  const ledger: LedgerEntry[] = [];
  let lid = 0;
  const push = (e: Omit<LedgerEntry, 'id' | 'runningBalanceMinor' | 'reversedByEntryId' | 'createdAt'> & { createdAt?: string }) => {
    const entry: LedgerEntry = { ...e, id: ++lid, runningBalanceMinor: 0, reversedByEntryId: null, createdAt: e.createdAt ?? daysAgo(0) };
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

  const emails: RawEmail[] = [];
  for (const t of txns.filter((x) => x.rawEmailId)) {
    emails.push({
      id: t.rawEmailId!, mailboxLabel: t.mailboxId === 2 ? 'Gmail الاحتياطي' : 'Gmail الرئيسي', fromAddr: 'service@paypal.com',
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
