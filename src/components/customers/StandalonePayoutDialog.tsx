import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Customer, PayoutDetails } from '@/lib/contract';
import { formatMinor } from '@/lib/money';
import { todayLocal } from '@/lib/dates';
import { payoutMethod } from '@/lib/strings';
import { useAction } from '@/lib/useAction';
import { Amount } from '@/components/ui/Amount';
import { Button } from '@/components/ui/Button';
import { ConfirmMoney } from '@/components/ui/ConfirmMoney';
import { DatePicker } from '@/components/ui/DateFields';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Field';
import { TextField } from '@/components/ui/TextField';
import { PayoutDetailsFields } from './PayoutDialogs';

/*
 * SPEC 4.9: the only way to pay a customer from the app. A payout on its own: it lowers the balance in
 * the ledger and is not tied to any transfer — no "all unpaid", no "#from–#to". The customer's last
 * method / platform / network / destination come back by themselves. Every number is the core's.
 */
export function StandalonePayoutDialog({ customer, currencies, defaultCurrency, onClose }: {
  customer: Customer; currencies: string[]; defaultCurrency: string; onClose: () => void;
}) {
  const [currency, setCurrency] = useState(defaultCurrency);
  const [amountText, setAmountText] = useState('');
  const [entryDate, setEntryDate] = useState(todayLocal());
  const [details, setDetails] = useState<PayoutDetails>({ method: 'usdt', network: 'TRC20' });
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [overdraw, setOverdraw] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const { run, pending } = useAction();

  const defaults = useQuery({ queryKey: ['payout_defaults', customer.id], queryFn: () => api.payoutDefaults(customer.id) });
  useEffect(() => { if (defaults.data) setDetails((d) => ({ ...d, ...defaults.data, reference: null, note: null })); }, [defaults.data]);
  // the balance before / after, from the core as the amount is typed (SPEC 4.9)
  const [typed, setTyped] = useState('');
  useEffect(() => { const t = setTimeout(() => setTyped(amountText.trim()), 220); return () => clearTimeout(t); }, [amountText]);
  const valid = !typed || /^[\d,]+(\.\d+)?$/.test(typed);
  const preview = useQuery({
    queryKey: ['ledger_payout_preview', customer.id, currency, valid ? typed : ''],
    queryFn: () => api.ledgerPayoutPreview(customer.id, currency, valid ? typed : undefined),
    placeholderData: keepPreviousData,
  });
  const p = preview.data;
  const balance = p?.balanceBeforeMinor ?? 0;

  const next = () => {
    if (!/^\s*[\d,]+(\.\d+)?\s*$/.test(amountText)) { setError('أدخل مبلغاً مثل 150.00'); return; }
    setStep('confirm');
  };
  const submit = async (confirmOverdraw = false) => {
    const r = await run(() => api.ledgerAddPayout(customer.id, {
      currency, amountText: amountText.trim(), entryDate, method: details.method,
      platform: details.platform || undefined, network: details.method === 'usdt' ? details.network ?? undefined : undefined,
      destination: details.destination || undefined, reference: details.reference || undefined, description: details.note || undefined,
      confirmOverdraw,
    }), 'سُجّلت الدفعة', { quiet: (e) => e.field === 'overdraw' });
    if (r.ok) onClose();
    else if (r.error.field === 'overdraw') setOverdraw(r.error.messageAr);
    else if (r.error.field === 'amountText' || r.error.code === 'invalid_amount') { setError(r.error.messageAr); setStep('form'); }
  };

  const before = (
    <div className="grid grid-cols-2 divide-x divide-x-reverse divide-line rounded-card bg-raised/60 text-sm" aria-live="polite">
      <div className="flex flex-col gap-0.5 px-4 py-2.5">
        <span className="text-[12.5px] text-fg-2">المتبقي للعميل الآن</span>
        <Amount minor={p?.balanceBeforeMinor ?? null} currency={currency} className={balance < 0 ? 'font-medium text-neg' : 'font-medium text-fg'} />
      </div>
      <div className="flex flex-col gap-0.5 px-4 py-2.5">
        <span className="text-[12.5px] text-fg-2">بعد الدفعة</span>
        {p && p.amountMinor > 0
          ? <Amount minor={p.balanceAfterMinor} currency={currency} className={p.balanceAfterMinor < 0 ? 'font-medium text-neg' : 'font-medium text-fg'} />
          : <span className="text-fg-3">—</span>}
      </div>
      {p?.overdraw && <p className="col-span-2 border-t border-line px-4 py-2 text-[12.5px] text-neg">الدفعة أكبر من المتبقي: يصبح الرصيد سالباً («عليه»)، وتُطلب موافقتك صراحةً.</p>}
    </div>
  );

  if (step === 'confirm') {
    return (
      <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title={`دفعة لـ ${customer.name}`} dirty
        amountText={`-${amountText.trim()}`} currency={currency} tone={overdraw ? 'danger' : 'primary'} pending={pending}
        confirmLabel={overdraw ? 'تأكيد رغم التجاوز' : 'تسجيل الدفعة'} onConfirm={() => submit(!!overdraw)}>
        <div className="flex flex-col gap-2 text-sm text-fg-2">
          {before}
          <p>
            {payoutMethod[details.method]}{details.platform ? ` — ${details.platform}` : ''}{details.method === 'usdt' && details.network ? ` (${details.network})` : ''}،
            بتاريخ <bdi dir="ltr" className="num">{entryDate}</bdi>
          </p>
          {details.reference && <p>المرجع <bdi dir="ltr" className="num">{details.reference}</bdi></p>}
          {overdraw && <p role="alert" className="rounded-card bg-neg-soft px-3 py-2 text-neg">{overdraw}. بعد التسجيل يصبح الرصيد سالباً ويظهر «عليه».</p>}
          <button className="self-start text-[13px] text-accent-ink hover:underline" onClick={() => { setStep('form'); setOverdraw(null); }}>تعديل البيانات</button>
        </div>
      </ConfirmMoney>
    );
  }

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={`تسجيل دفعة لـ ${customer.name}`}
      description="دفعة مستقلة تُنقص رصيد العميل في الدفتر، بلا ربط بحوالات"
      footer={<><Button variant="secondary" onPress={onClose}>تراجع</Button><Button variant="primary" onPress={next}>متابعة</Button></>}>
      <div className="flex flex-col gap-4">
        {before}
        <div className="grid grid-cols-[120px_1fr_auto] items-start gap-3">
          <div className="flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">العملة</span>
            <Select label="العملة" value={currency} onChange={(k) => setCurrency(String(k))} options={currencies.map((c) => ({ id: c, label: c }))} /></div>
          <TextField label="المبلغ" ltr suffix={currency} placeholder="0.00" value={amountText} onChange={(v) => { setAmountText(v); setError(undefined); }} autoFocus isRequired errorMessage={error} />
          <Button size="sm" variant="quiet" className="mt-7" isDisabled={balance <= 0}
            onPress={() => { setAmountText(formatMinor(balance, currency).replace(/,/g, '')); setError(undefined); }}>كامل المتبقي</Button>
        </div>
        <DatePicker label="التاريخ" value={entryDate} onChange={(v) => setEntryDate(v ?? todayLocal())} />
        <PayoutDetailsFields value={details} onChange={setDetails} />
      </div>
    </Dialog>
  );
}
