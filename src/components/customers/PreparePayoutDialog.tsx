import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import type { Customer, PayoutDetails, PayoutPreparation, PayoutSelection } from '@/lib/contract';
import { formatMinor } from '@/lib/money';
import { formatDateTime, todayLocal } from '@/lib/dates';
import { transferCountLabel } from '@/lib/strings';
import { useAction } from '@/lib/useAction';
import { Amount } from '@/components/ui/Amount';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { ConfirmMoney } from '@/components/ui/ConfirmMoney';
import { DatePicker } from '@/components/ui/DateFields';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented } from '@/components/ui/Segmented';
import { TextField } from '@/components/ui/TextField';
import { Trunc } from '@/components/ui/Trunc';
import { toast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { PayoutDetailsFields } from './PayoutDialogs';
import { StatementCheckbox, addToStatementAfter, useStatementChoice } from './CustomerExcel';

/*
 * Prepare a payout (SPEC 4.8), the app's version of the owner's "تجهيز دفعة" sheet: choose the transfers
 * (all unpaid, a #range, or the selection), see the core's figures and warnings, confirm they match,
 * then the payment details. Every amount shown comes from payout_prepare.
 */

type Kind = PayoutSelection['kind'];

function Figure({ label, children, big }: { label: string; children: React.ReactNode; big?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[12px] text-fg-3">{label}</div>
      <div className={cx('truncate font-medium', big ? 'text-[19px] text-accent-ink' : 'text-[14px] text-fg')}>{children}</div>
    </div>
  );
}

function Warnings({ p }: { p: PayoutPreparation }) {
  const bySeq = new Map<number, number[]>();
  for (const a of p.alreadyPaid) bySeq.set(a.payoutSeq, [...(bySeq.get(a.payoutSeq) ?? []), a.txn.customerSeq ?? 0]);
  const items = [
    ...[...bySeq].map(([seq, ns]) => `مدفوعة سابقاً في الدفعة ${seq}: ${ns.map((n) => `#${n}`).join('، ')} (مستبعدة)`),
    ...(p.excludedHeld.length ? [`معلّقة أو محجوزة: ${p.excludedHeld.map((t) => `#${t.customerSeq}`).join('، ')} (مستبعدة)`] : []),
    ...(p.missingSeqs.length ? [`أرقام غير موجودة في النطاق: ${p.missingSeqs.join('، ')}`] : []),
  ];
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-1 rounded-card bg-warn-soft px-4 py-3 text-[13px] text-fg" aria-label="تنبيهات">
      {items.map((w) => <li key={w} className="flex gap-2"><TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />{w}</li>)}
    </ul>
  );
}

export function PreparePayoutDialog({ customer, currency, initial, onClose }: { customer: Customer; currency: string; initial?: PayoutSelection; onClose: () => void }) {
  const qc = useQueryClient();
  const { run, pending } = useAction();
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'unpaid');
  const [from, setFrom] = useState(initial?.kind === 'range' ? String(initial.from) : '');
  const [to, setTo] = useState(initial?.kind === 'range' ? String(initial.to) : '');
  const [matched, setMatched] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [details, setDetails] = useState<PayoutDetails>({ method: 'usdt', network: 'TRC20' });
  const [status, setStatus] = useState<'sent' | 'draft'>('sent');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const statement = useStatementChoice(customer.id);

  const defaults = useQuery({ queryKey: ['payout_defaults', customer.id], queryFn: () => api.payoutDefaults(customer.id) });
  useEffect(() => { if (defaults.data) setDetails((d) => ({ ...d, ...defaults.data, reference: null, note: null })); }, [defaults.data]);

  const selection = useMemo<PayoutSelection | null>(() => {
    if (kind === 'unpaid') return { kind: 'unpaid' };
    if (kind === 'ids') return initial?.kind === 'ids' ? initial : null;
    const f = Number(from), t = Number(to);
    return Number.isInteger(f) && Number.isInteger(t) && f > 0 && t >= f ? { kind: 'range', from: f, to: t } : null;
  }, [kind, from, to, initial]);
  const [debounced, setDebounced] = useState(selection);
  useEffect(() => { const t = setTimeout(() => setDebounced(selection), 250); return () => clearTimeout(t); }, [selection]);
  const prep = useQuery({
    queryKey: ['payout_prepare', customer.id, currency, debounced],
    queryFn: () => api.payoutPrepare(customer.id, currency, debounced!),
    enabled: debounced !== null,
    placeholderData: keepPreviousData,
  });
  const p = debounced ? prep.data : undefined;
  const dueText = p ? formatMinor(p.dueMinor, currency) : '';
  // the core compares the amounts; here only the typed text is compared with the due amount's own text
  const differs = amountText.trim() !== '' && amountText.replace(/,/g, '').trim() !== dueText.replace(/,/g, '');
  const rangeError = kind === 'range' && (from || to) && !selection ? 'أدخل نطاقاً صحيحاً: من رقم إلى رقم أكبر منه أو يساويه' : undefined;

  const next = () => {
    const e: Record<string, string> = {};
    if (!matched) e.matched = 'راجع الحوالات وأكّد أنها مطابقة';
    if (differs && !reason.trim()) e.difference_reason = 'المبلغ يختلف عن المستحق؛ اكتب السبب';
    setErrors(e);
    if (!Object.keys(e).length) setStep('confirm');
  };

  const create = async () => {
    if (!p) return;
    const r = await run(() => api.payoutCreate({
      customerId: customer.id, currency, txnIds: p.included.map((t) => t.id), returnedEntryIds: p.returned.map((e) => e.id),
      amountText: amountText.trim() || undefined, differenceReason: differs ? reason.trim() : undefined,
      date, details, status, matchedConfirmed: true,
    }), undefined, { quiet: (e) => e.code === 'validation' || e.code === 'invalid_amount' });
    if (r.ok) {
      onClose();
      toast.ok(status === 'sent' ? `أُرسلت الدفعة ${r.value.seq} ${r.value.rangeLabel}` : `سُجّلت الدفعة ${r.value.seq} ${r.value.rangeLabel}`,
        status === 'sent' ? 'خُصمت من رصيد العميل، والحوالات صارت «تم الإرسال».' : 'الحوالات محجوزة لها؛ أكّد الإرسال من سطر الدفعة.');
      if (status === 'sent' && statement.on) void addToStatementAfter(customer.id, { kind: 'payout', id: r.value.id }, qc);
      return;
    }
    setStep('form');
    const field = r.error.field ?? (r.error.code === 'invalid_amount' ? 'amount' : 'form');
    setErrors({ [field]: r.error.messageAr });
  };

  if (step === 'confirm' && p) {
    return (
      <ConfirmMoney isOpen onOpenChange={(o) => !o && setStep('form')} title={`${status === 'sent' ? 'إرسال' : 'تسجيل'} دفعة لـ ${customer.name}`}
        amountText={`-${amountText.trim() || dueText}`} currency={currency} pending={pending}
        confirmLabel={status === 'sent' ? 'تم الإرسال' : 'تسجيل الدفعة'} onConfirm={() => void create()}>
        <div className="flex flex-col gap-2 text-sm text-fg-2">
          <p>{transferCountLabel(p.countedCount)} {p.rangeLabel}، بتاريخ <bdi dir="ltr" className="num">{date}</bdi></p>
          {status === 'draft' && <p className="text-fg-3">لا يتغيّر الرصيد حتى «تأكيد الإرسال».</p>}
          {differs && <p className="text-fg-3">يختلف عن المستحق <Amount minor={p.dueMinor} currency={currency} />: {reason}</p>}
          {status === 'sent' && <StatementCheckbox customerId={customer.id} value={statement.value} onChange={statement.setValue} />}
        </div>
      </ConfirmMoney>
    );
  }

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="lg" title={`تجهيز دفعة لـ ${customer.name} (${currency})`}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isDisabled={!p || p.countedCount === 0} onPress={next}>متابعة</Button>
      </>}>
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-3">
          <Segmented label="الحوالات" value={kind} onChange={setKind}
            options={[
              { id: 'unpaid', label: 'كل غير المدفوع' }, { id: 'range', label: 'نطاق من # إلى #' },
              ...(initial?.kind === 'ids' ? [{ id: 'ids' as const, label: `المحدد (${initial.txnIds.length})` }] : []),
            ]} />
          {kind === 'range' && (
            <div className="flex items-start gap-3">
              <TextField label="من #" ltr value={from} onChange={setFrom} className="w-[120px]" autoFocus />
              <TextField label="إلى #" ltr value={to} onChange={setTo} className="w-[120px]" errorMessage={rangeError} />
            </div>
          )}
        </section>

        {p && (
          <section className="flex flex-col gap-3" aria-label="معاينة الدفعة">
            <div className="grid grid-cols-4 gap-x-4 gap-y-3 rounded-card bg-raised/60 px-4 py-3">
              <Figure label="الموجودة"><span className="num">{p.foundCount}</span></Figure>
              <Figure label="المحتسبة"><span className="num">{p.countedCount}</span></Figure>
              <Figure label="المرجعة (سالبة)"><span className="num">{p.returnedCount}</span></Figure>
              <Figure label="النطاق"><bdi className="num">{p.rangeLabel}</bdi></Figure>
              <Figure label="إجمالي PayPal"><Amount minor={p.grossMinor} currency={currency} showCurrency={false} /></Figure>
              <Figure label="صافي PayPal"><Amount minor={p.netPaypalMinor} currency={currency} showCurrency={false} /></Figure>
              <Figure label="العمولة"><Amount minor={p.commissionMinor} currency={currency} showCurrency={false} /></Figure>
              <Figure label="المستحق للإرسال" big><Amount minor={p.dueMinor} currency={currency} /></Figure>
            </div>
            <Warnings p={p} />
            {errors.overlap && <p className="text-[13px] text-neg">{errors.overlap}</p>}
            {p.included.length > 0 && (
              <ul className="max-h-[168px] divide-y divide-line overflow-auto rounded-card border border-line" aria-label="الحوالات المحتسبة">
                {p.included.map((t) => (
                  <li key={t.id} className="grid grid-cols-[48px_88px_1fr_auto] items-center gap-3 px-3 py-1.5 text-[13px]">
                    <span className="num text-fg-2">#{t.customerSeq}</span>
                    <bdi dir="ltr" className="num text-right text-fg-3">{formatDateTime(t.occurredAt).slice(0, 10)}</bdi>
                    <Trunc className="min-w-0 text-fg">{t.payerName || t.payerEmail}</Trunc>
                    <Amount minor={t.customerAmountMinor} currency={currency} showCurrency={false} className="font-medium" />
                  </li>
                ))}
              </ul>
            )}
            {p.countedCount === 0 && <p className="text-sm text-fg-3">لا حوالات تُحتسب في هذا الاختيار.</p>}
            <div>
              <Checkbox isSelected={matched} onChange={(v) => { setMatched(v); setErrors(({ matched: _m, ...rest }) => rest); }}>راجعتُ الحوالات وهي مطابقة</Checkbox>
              {errors.matched && <p className="mt-1 text-[12.5px] text-neg">{errors.matched}</p>}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-4 border-t border-line pt-4" aria-label="تفاصيل الدفع">
          <div className="grid grid-cols-2 gap-4">
            <TextField label="المبلغ المدفوع" ltr suffix={currency} value={amountText} onChange={(v) => { setAmountText(v); setErrors({}); }}
              placeholder={dueText} description="فارغ = المستحق كاملاً" errorMessage={errors.amount} />
            <DatePicker label="التاريخ" value={date} onChange={(v) => setDate(v ?? todayLocal())} />
            {differs && (
              <TextField label="سبب الاختلاف عن المستحق" value={reason} onChange={setReason} isRequired className="col-span-2"
                description="الفرق يبقى في رصيد العميل" errorMessage={errors.difference_reason} />
            )}
          </div>
          <PayoutDetailsFields value={details} onChange={setDetails} />
          <div className="flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">الحالة</span>
            <Segmented label="الحالة" value={status} onChange={setStatus}
              options={[{ id: 'sent', label: 'تم الإرسال' }, { id: 'draft', label: 'مسجلة (لم تُرسل بعد)' }]} className="w-[340px]" />
          </div>
          {errors.form && <p className="text-[13px] text-neg">{errors.form}</p>}
        </section>
      </div>
    </Dialog>
  );
}
