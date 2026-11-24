// All interface text lives here (SPEC §2). Modern Standard Arabic, one register.
import type { LedgerType, ParseStatus, PayoutMethod, PullRange, TxnStatus, TxnType } from './contract';

export const nav = {
  dashboard: 'لوحة التحكم',
  transactions: 'المعاملات',
  customers: 'العملاء',
  emails: 'الرسائل',
  settings: 'الإعدادات',
  lock: 'قفل البرنامج',
  theme: 'المظهر',
};

export const txnStatus: Record<TxnStatus, string> = {
  unassigned: 'غير مخصّصة',
  pending_approval: 'بانتظار الموافقة',
  approved: 'معتمدة',
  excluded: 'مستبعدة',
};

export const txnType: Record<TxnType, string> = { payment: 'دفعة', refund: 'استرداد', reversal: 'عكس' };

export const ledgerType: Record<LedgerType, string> = { credit: 'اعتماد', payout: 'دفعة', adjustment: 'تسوية', reversal: 'عكس' };

export const payoutMethod: Record<PayoutMethod, string> = {
  cash: 'نقداً', bank: 'تحويل بنكي', usdt: 'USDT', paypal: 'PayPal', other: 'أخرى',
};

export const parseStatus: Record<ParseStatus, string> = { failed: 'فاشلة', ignored: 'متجاهلة', parsed: 'محلَّلة' };

export const txn = {
  title: 'المعاملات',
  pull: 'سحب المعاملات',
  addManual: 'إضافة معاملة يدوياً',
  tabAll: 'الكل',
  search: 'بحث بالمرسل أو الإيميل أو رقم المعاملة',
  allCurrencies: 'كل العملات',
  allCustomers: 'كل العملاء',
  allMailboxes: 'كل صناديق البريد',
  needsFeeOnly: 'تحتاج رسوم فقط',
  needsFee: 'تحتاج رسوم',
  estimated: 'تقديري',
  cols: {
    date: 'التاريخ', payer: 'المرسل', payerNote: 'ملاحظة المرسل', gross: 'الأصلي', fee: 'الرسوم', net: 'الصافي',
    customer: 'العميل', commission: 'العمولة', toCustomer: 'للعميل', status: 'الحالة',
  },
  totals: 'إجمالي المعروض',
  refunded: 'تم استردادها',
  detail: {
    breakdown: 'تفصيل الحساب', gross: 'الأصلي', fee: 'رسوم PayPal', net: 'الصافي', commission: 'عمولتي', toCustomer: 'للعميل',
    history: 'سجل التغييرات', viewEmail: 'عرض الرسالة الأصلية', myNote: 'ملاحظتي', paypalId: 'رقم معاملة PayPal', mailbox: 'البريد',
  },
};

/** "آخر 7 أيام" / "آخر 30 يوماً": Arabic counted noun (3–10 plural, 11+ singular accusative). */
export function daysLabel(n: number): string {
  if (n === 1) return 'آخر يوم';
  if (n === 2) return 'آخر يومين';
  return n <= 10 ? `آخر ${n} أيام` : `آخر ${n} يوماً`;
}

/** Text form of a pull range. `between` keeps the dates LTR with isolates so the arrow stays put. */
export function pullRangeLabel(r: PullRange | undefined | null, short = false): string {
  const fresh = short ? 'الجديد' : 'الجديد منذ آخر سحب';
  if (!r) return fresh;
  switch (r.kind) {
    case 'new': return fresh;
    case 'last_days': return daysLabel(r.days);
    case 'between': return `\u2066${r.from}\u2069 ← \u2066${r.to}\u2069`;
    case 'all': return 'كل الرسائل';
  }
}

export const holdStatus = { pending_echeck: 'eCheck معلّق', on_hold: 'محجوز' } as const;
export const holdHint = {
  pending_echeck: 'لا يُعتمد حتى تصل رسالة اكتمال الـ eCheck',
  on_hold: 'PayPal يحجز هذا المبلغ مؤقتاً',
} as const;
