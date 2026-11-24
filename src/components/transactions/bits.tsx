import type { Currency, Minor, Transaction, TxnStatus } from '@/lib/contract';
import { holdHint, holdStatus, txn as s, txnStatus, txnType } from '@/lib/strings';
import { formatDateTime } from '@/lib/dates';
import { Trunc } from '@/components/ui/Trunc';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/components/ui/cx';

export function StatusBadge({ status, dot = true }: { status: TxnStatus; dot?: boolean }) {
  const tone = { unassigned: 'neutral', pending_approval: 'accent', approved: 'pos', excluded: 'outline' } as const;
  return <Badge tone={tone[status]} dot={dot && status !== 'excluded'}>{txnStatus[status]}</Badge>;
}

/** Fee column: "تحتاج رسوم" when missing, italic when estimated (SPEC 6.3). */
export function FeeCell({ t, fit }: { t: Transaction; fit?: number }) {
  if (t.feeMinor === null) return <Badge tone="warn">{s.needsFee}</Badge>;
  if (t.feeIsEstimated)
    return (
      <span title={s.estimated}>
        <Amount fit={fit} minor={t.feeMinor} currency={t.currency} showCurrency={false} estimated className="italic" />
      </span>
    );
  return <Amount fit={fit} minor={t.feeMinor} currency={t.currency} showCurrency={false} className="text-fg-2" />;
}

/** Date over time, the same two lines in every row. */
export function DateCell({ iso }: { iso: string }) {
  const v = formatDateTime(iso);
  return (
    <div className="num whitespace-nowrap">
      <div>{v.slice(0, 10)}</div>
      <div className="text-[12px] text-fg-3">{v.slice(11)}</div>
    </div>
  );
}

/**
 * Payer: name (or e-mail, or "—") over the PayPal transaction id. Markers sit in a fixed slot at
 * the end of the cell, so they never move the text or widen the column.
 */
export function PayerCell({ t }: { t: Transaction }) {
  const who = t.payerName || t.payerEmail || '—';
  const title = [t.payerName, t.payerEmail, t.paypalTxnId].filter(Boolean).join('\n');
  const flags = [
    t.type !== 'payment' && <Badge key="type" tone="neg">{txnType[t.type]}</Badge>,
    t.refundedBy.length > 0 && <Badge key="refunded" tone="neg">{s.refunded}</Badge>,
    t.source === 'manual' && <Badge key="manual" tone="outline">يدوية</Badge>,
    t.needsReview && <span key="review" title={t.reviewReasonAr ?? undefined}><Badge tone="warn">تحتاج مراجعة</Badge></span>,
    t.holdStatus && <span key="hold" title={holdHint[t.holdStatus]}><Badge tone="outline">{holdStatus[t.holdStatus]}</Badge></span>,
    t.changedAfterExcel && <span key="excel" title="أُضيفت لملف العميل ثم أُلغي اعتمادها أو تغيّرت؛ قرّر إن كنت تضيف سطر العكس"><Badge tone="warn">تغيّرت بعد إضافتها لملف العميل</Badge></span>,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="min-w-0 flex-1">
        <Trunc>{who}</Trunc>
        <div dir="ltr" className="num truncate text-right text-[12px] text-fg-3">{t.paypalTxnId}</div>
      </div>
      {flags.length > 0 && <div className="flex max-w-[62%] shrink-0 gap-1 overflow-hidden">{flags}</div>}
    </div>
  );
}

export type BreakdownValues = {
  currency: Currency;
  gross: Minor;
  fee: Minor | null;
  net: Minor | null;
  commission: Minor | null;
  commissionHint?: string;
  toCustomer: Minor | null;
  feeHint?: string;
};

/** gross − fee = net − commission = to customer. Values always come from the backend. */
export function Breakdown({ v, title = s.detail.breakdown, className }: { v: BreakdownValues; title?: string; className?: string }) {
  const neg = (m: Minor | null) => (m === null ? null : -m);
  const rows: { label: string; value: Minor | null; hint?: string; kind?: 'rule' | 'total'; missing?: string }[] = [
    { label: s.detail.gross, value: v.gross },
    { label: s.detail.fee, value: neg(v.fee), hint: v.feeHint, missing: s.needsFee },
    { label: s.detail.net, value: v.net, kind: 'rule' },
    { label: s.detail.commission, value: neg(v.commission), hint: v.commissionHint },
    { label: s.detail.toCustomer, value: v.toCustomer, kind: 'total' },
  ];
  return (
    <div className={cx('rounded-card bg-raised/60 p-4', className)}>
      <div className="mb-2 text-[13px] text-fg-3">{title}</div>
      <dl className="flex flex-col">
        {rows.map((r) => (
          <div key={r.label} className={cx('flex items-center justify-between py-1.5', r.kind && 'mt-1 border-t border-line pt-2.5')}>
            <dt className={cx('text-sm', r.kind === 'total' ? 'text-fg' : 'text-fg-2')}>
              {r.label}{r.hint && <>{' '}<bdi dir="ltr" className="num text-fg-3">{r.hint}</bdi></>}
            </dt>
            <dd className={cx(r.kind === 'total' && 'text-[17px] font-medium')}>
              {r.value === null
                ? <span className={cx('text-[13px]', r.missing ? 'text-warn' : 'text-fg-3')}>{r.missing ?? '—'}</span>
                : <Amount minor={r.value} currency={v.currency} showCurrency={r.kind === 'total'} className={r.kind === 'total' ? 'text-accent-ink' : ''} />}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function fromTxn(t: Transaction, commissionHint?: string): BreakdownValues {
  return {
    currency: t.currency, gross: t.grossMinor, fee: t.feeMinor, net: t.netMinor, commission: t.commissionMinor,
    toCustomer: t.customerAmountMinor, commissionHint, feeHint: t.feeIsEstimated ? s.estimated : undefined,
  };
}

/** Review / hold markers shown next to the payer (SPEC 5.3). */
export function TxnFlags({ t }: { t: Transaction }) {
  return (
    <>
      {t.needsReview && <span title={t.reviewReasonAr ?? undefined}><Badge tone="warn">تحتاج مراجعة</Badge></span>}
      {t.holdStatus && <span title={holdHint[t.holdStatus]}><Badge tone="outline">{holdStatus[t.holdStatus]}</Badge></span>}
    </>
  );
}
