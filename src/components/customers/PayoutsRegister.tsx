import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { payoutMethod, payoutStatus } from '@/lib/strings';
import { Amount, amountFit, amountWidth } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { Segmented } from '@/components/ui/Segmented';
import { HeadLabel, TableFrame, sumWidths } from '@/components/ui/Table';
import { Trunc } from '@/components/ui/Trunc';
import { cx } from '@/components/ui/cx';
import { InToolbar } from '@/components/layout/ToolbarSlot';

const tone = { sent: 'pos', draft: 'accent', cancelled: 'outline' } as const;

/**
 * SPEC 4.9 "الدفعات": every payout of this customer in one numbering — the standalone ones (the only
 * kind recorded from 0.6.1) and those linked to transfers before. The cumulative paid is the core's.
 */
export function PayoutsRegister({ customerId, currencies }: { customerId: number; currencies: string[] }) {
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD');
  const list = useQuery({ queryKey: ['payout_register', customerId, currency], queryFn: () => api.payoutRegister(customerId, currency) });
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const fit = useMemo(() => ({
    amount: amountFit(rows.map((p) => ({ minor: p.amountMinor, currency }))),
    cumulative: amountFit(rows.map((p) => ({ minor: p.cumulativePaidMinor, currency }))),
  }), [rows, currency]);
  const W = { seq: '72px', date: '100px', amount: amountWidth(fit.amount, false, 96), method: '108px', platform: '120px', network: '84px', ref: '150px', cumulative: amountWidth(fit.cumulative, false, 112), status: '112px' };
  const min = sumWidths([...Object.values(W), '180px']);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {currencies.length > 1 && (
        <InToolbar><Segmented label="العملة" value={currency} onChange={setCurrency} options={currencies.map((c) => ({ id: c, label: c }))} className="w-fit" /></InToolbar>
      )}
      <TableFrame fill>
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm" style={{ minWidth: min }} aria-label={`سجل الدفعات ${currency}`}>
          <colgroup>
            <col style={{ width: W.seq }} /><col style={{ width: W.date }} /><col style={{ width: W.amount }} />
            <col style={{ width: W.method }} /><col style={{ width: W.platform }} /><col style={{ width: W.network }} /><col style={{ width: W.ref }} />
            <col style={{ width: W.cumulative }} /><col /><col style={{ width: W.status }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="[&>th]:h-10 [&>th]:overflow-hidden [&>th]:border-b [&>th]:border-line [&>th]:bg-surface [&>th]:px-2.5 [&>th]:font-normal [&>th]:whitespace-nowrap">
              <th className="sticky z-[2] !ps-4 text-start" data-sticky="start" style={{ insetInlineStart: 0 }}><HeadLabel>الدفعة</HeadLabel></th>
              <th className="text-start"><HeadLabel>التاريخ</HeadLabel></th>
              <th className="text-end"><HeadLabel>المبلغ</HeadLabel></th>
              <th className="text-start"><HeadLabel>الطريقة</HeadLabel></th>
              <th className="text-start"><HeadLabel>المنصة / البنك</HeadLabel></th>
              <th className="text-start"><HeadLabel>الشبكة</HeadLabel></th>
              <th className="text-start"><HeadLabel>المرجع</HeadLabel></th>
              <th className="text-end"><HeadLabel>التراكمي المدفوع</HeadLabel></th>
              <th className="text-start"><HeadLabel>ملاحظة</HeadLabel></th>
              <th className="text-start"><HeadLabel>الحالة</HeadLabel></th>
            </tr>
          </thead>
          <tbody className="[&>tr>td]:h-(--row-h) [&>tr>td]:border-b [&>tr>td]:border-line [&>tr>td]:bg-surface [&>tr>td]:px-2.5 [&>tr>td]:leading-tight [&>tr>td]:whitespace-nowrap [&>tr:last-child>td]:border-b-0">
            {rows.map((p) => {
              const cancelled = p.status === 'cancelled';
              const note = [p.note, p.rangeLabel && `مرتبطة بالحوالات ${p.rangeLabel}`].filter(Boolean).join(' · ');
              return (
                <tr key={`${p.kind}-${p.seq}`} data-kind={p.kind} className={cx(cancelled && 'text-fg-3')}>
                  <td className="num sticky z-[1] !ps-4 font-medium" data-sticky="start" style={{ insetInlineStart: 0 }}>{p.seq}</td>
                  <td className="num text-fg-2"><bdi dir="ltr">{p.date}</bdi></td>
                  <td className="text-end"><Amount fit={fit.amount} minor={p.amountMinor} currency={currency} showCurrency={false} className={cx('font-medium', cancelled && 'line-through')} /></td>
                  <td><Trunc className="text-fg-2">{payoutMethod[p.method]}</Trunc></td>
                  <td><Trunc className="text-fg-2">{p.platform ?? '—'}</Trunc></td>
                  <td className="text-fg-2">{p.network ?? '—'}</td>
                  <td className="text-[13px] text-fg-3">{p.reference ? <div dir="ltr" className="num truncate text-right" title={p.reference}>{p.reference}</div> : '—'}</td>
                  <td className="text-end"><Amount fit={fit.cumulative} minor={p.cumulativePaidMinor} currency={currency} showCurrency={false} className="text-fg-2" /></td>
                  <td><Trunc className="text-fg-2">{note || '—'}</Trunc></td>
                  <td><Badge tone={tone[p.status]}>{payoutStatus[p.status]}</Badge></td>
                </tr>
              );
            })}
            {list.data && rows.length === 0 && <tr><td colSpan={10} className="py-10 text-center text-fg-3">لا دفعات بعد. «تسجيل دفعة» أعلى الصفحة يسجّل دفعة تُنقص رصيد العميل.</td></tr>}
          </tbody>
        </table>
      </TableFrame>
    </div>
  );
}
