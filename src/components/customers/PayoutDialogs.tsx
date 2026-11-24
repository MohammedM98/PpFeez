import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Payout, PayoutDetails, PayoutMethod } from '@/lib/contract';
import { formatDateTime, todayLocal } from '@/lib/dates';
import { USDT_NETWORKS, payoutMethod, transferCountLabel } from '@/lib/strings';
import { useAction } from '@/lib/useAction';
import { Amount } from '@/components/ui/Amount';
import { Button } from '@/components/ui/Button';
import { ConfirmMoney } from '@/components/ui/ConfirmMoney';
import { DatePicker } from '@/components/ui/DateFields';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Field';
import { TextField } from '@/components/ui/TextField';
import { Trunc } from '@/components/ui/Trunc';

/*
 * Payment details of a payout (SPEC 4.8): method, platform/bank (suggested from earlier ones),
 * USDT network, destination, reference, note. Shared by prepare-payout and "edit details".
 */
export function PayoutDetailsFields({ value, onChange }: { value: PayoutDetails; onChange: (v: PayoutDetails) => void }) {
  const suggestions = useQuery({ queryKey: ['payout_platform_suggestions'], queryFn: api.payoutPlatformSuggestions });
  const set = <K extends keyof PayoutDetails>(k: K) => (v: PayoutDetails[K]) => onChange({ ...value, [k]: v });
  const usdt = value.method === 'usdt';
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">الطريقة</span>
        <Select label="الطريقة" value={value.method} onChange={(k) => onChange({ ...value, method: k as PayoutMethod, network: k === 'usdt' ? value.network ?? 'TRC20' : null })}
          options={(Object.keys(payoutMethod) as PayoutMethod[]).map((m) => ({ id: m, label: payoutMethod[m] }))} />
      </div>
      {usdt ? (
        <div className="flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">الشبكة</span>
          <Select label="الشبكة" value={value.network ?? 'TRC20'} onChange={(k) => set('network')(String(k))} options={USDT_NETWORKS.map((n) => ({ id: n, label: n }))} />
        </div>
      ) : <div />}
      <div className="col-span-2 flex flex-col gap-1.5">
        <TextField label={value.method === 'bank' ? 'البنك' : 'المنصة'} value={value.platform ?? ''} onChange={(v) => set('platform')(v || null)} placeholder={usdt ? 'Binance، OKX…' : ''} />
        {!!suggestions.data?.length && (
          <div className="flex flex-wrap gap-1.5" aria-label="منصات سابقة">
            {suggestions.data.map((p) => (
              <button key={p} type="button" onClick={() => set('platform')(p)}
                className="h-6 rounded-[6px] border border-line px-2 text-[12.5px] text-fg-2 outline-none hover:border-line-strong focus-visible:outline-2 focus-visible:outline-focus">{p}</button>
            ))}
          </div>
        )}
      </div>
      <TextField label={usdt ? 'عنوان المحفظة' : value.method === 'bank' ? 'IBAN / رقم الحساب' : 'الحساب'} ltr value={value.destination ?? ''} onChange={(v) => set('destination')(v || null)} className="col-span-2" />
      <TextField label={usdt ? 'رقم العملية (tx hash)' : 'المرجع / رقم العملية'} ltr value={value.reference ?? ''} onChange={(v) => set('reference')(v || null)} className="col-span-2" />
      <TextField label="ملاحظة" value={value.note ?? ''} onChange={(v) => set('note')(v || null)} className="col-span-2" />
    </div>
  );
}

const txt = (p: Payout) => `دفعة ${p.seq} ${p.rangeLabel}`;

export function MarkSentDialog({ payout, onClose }: { payout: Payout; onClose: () => void }) {
  const [date, setDate] = useState(todayLocal());
  const { run, pending } = useAction();
  return (
    <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title={`تأكيد إرسال ${txt(payout)}`} amount={-payout.amountMinor} currency={payout.currency}
      confirmLabel="تم الإرسال" pending={pending}
      onConfirm={async () => { const r = await run(() => api.payoutMarkSent(payout.id, date), `أُرسلت الدفعة ${payout.seq}`); if (r.ok) onClose(); }}>
      <div className="flex flex-col gap-3 text-sm text-fg-2">
        <p>يُخصم المبلغ من رصيد العميل كقيد دفعة، وتصبح {transferCountLabel(payout.txnCount)} «تم الإرسال — دفعة {payout.seq}».</p>
        <DatePicker label="تاريخ الإرسال" value={date} onChange={(v) => setDate(v ?? todayLocal())} />
      </div>
    </ConfirmMoney>
  );
}

export function CancelPayoutDialog({ payout, onClose }: { payout: Payout; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { run, pending } = useAction();
  const sent = payout.status === 'sent';
  return (
    <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title={`إلغاء ${txt(payout)}`} tone="danger"
      amount={sent ? payout.amountMinor : null} currency={payout.currency} confirmLabel="إلغاء الدفعة" pending={pending} extraValid={reason.trim().length > 0}
      onConfirm={async () => { const r = await run(() => api.payoutCancel(payout.id, reason.trim()), `أُلغيت الدفعة ${payout.seq}`); if (r.ok) onClose(); }}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">
          تعود {transferCountLabel(payout.txnCount)} «غير مدفوعة».
          {sent ? ' والدفعة مرسلة، فيُضاف قيد عكسي يعيد المبلغ إلى رصيد العميل.' : ' والدفعة لم تُرسل، فلا يتغيّر الرصيد.'}
        </p>
        <TextField label="السبب" value={reason} onChange={setReason} isRequired autoFocus />
      </div>
    </ConfirmMoney>
  );
}

export function PayoutDetailsDialog({ payout, onClose }: { payout: Payout; onClose: () => void }) {
  const [details, setDetails] = useState<PayoutDetails>(payout.details);
  const { run, pending } = useAction();
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={`تفاصيل ${txt(payout)}`}
      description="الطريقة والمنصة والمرجع والملاحظة فقط؛ المبلغ والحوالات لا تتغيّر"
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isPending={pending} onPress={async () => { const r = await run(() => api.payoutUpdateDetails(payout.id, details), 'حُفظت التفاصيل'); if (r.ok) onClose(); }}>حفظ</Button>
      </>}>
      <PayoutDetailsFields value={details} onChange={setDetails} />
    </Dialog>
  );
}

/** The transfers a payout covers (from the statement, so their numbers and amounts are the core's). */
export function PayoutItemsDialog({ payout, onClose }: { payout: Payout; onClose: () => void }) {
  const st = useQuery({
    queryKey: ['customer_statement', payout.customerId, payout.currency, { show: 'all' }],
    queryFn: () => api.customerStatement(payout.customerId, payout.currency, { show: 'all' }),
  });
  const txns = (st.data?.rows ?? []).flatMap((r) => (r.kind === 'txn' && payout.itemIds.txns.includes(r.txn.id) ? [r.txn] : []));
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={`حوالات ${txt(payout)}`}
      description={<>المبلغ <Amount minor={payout.amountMinor} currency={payout.currency} />، والمستحق المحسوب <Amount minor={payout.dueMinor} currency={payout.currency} /></>}
      footer={<Button variant="primary" onPress={onClose}>تم</Button>}>
      <ul className="max-h-[360px] divide-y divide-line overflow-auto rounded-card border border-line">
        {txns.map((t) => (
          <li key={t.id} className="grid grid-cols-[48px_88px_1fr_auto] items-center gap-3 px-3 py-2 text-[13px]">
            <span className="num text-fg-2">#{t.customerSeq}</span>
            <bdi dir="ltr" className="num text-right text-fg-3">{formatDateTime(t.occurredAt).slice(0, 10)}</bdi>
            <Trunc className="min-w-0 text-fg">{t.payerName || t.payerEmail}</Trunc>
            <Amount minor={t.customerAmountMinor} currency={t.currency} className="font-medium" />
          </li>
        ))}
        {st.data && !txns.length && <li className="px-3 py-6 text-center text-fg-3">لا حوالات ظاهرة لهذه الدفعة</li>}
      </ul>
    </Dialog>
  );
}
