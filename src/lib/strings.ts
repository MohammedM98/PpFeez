// All interface text lives here (SPEC §2). Modern Standard Arabic, one register.
import type { LedgerType, ParseStatus, PayoutMethod, TxnStatus, TxnType } from './contract';

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
