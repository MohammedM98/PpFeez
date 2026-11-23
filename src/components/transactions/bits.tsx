import type { Currency, Minor, Transaction, TxnStatus } from '@/lib/contract';
import { txn as s, txnStatus } from '@/lib/strings';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/components/ui/cx';

export function StatusBadge({ status, dot = true }: { status: TxnStatus; dot?: boolean }) {
  const tone = { unassigned: 'neutral', pending_approval: 'accent', approved: 'pos', excluded: 'outline' } as const;
  return <Badge tone={tone[status]} dot={dot && status !== 'excluded'}>{txnStatus[status]}</Badge>;
}

export function FeeCell({ t }: { t: Transaction }) {
  if (t.feeMinor === null) return <Badge tone="warn">{s.needsFee}</Badge>;
  if (t.feeIsEstimated)
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <Amount minor={t.feeMinor} currency={t.currency} showCurrency={false} estimated className="italic" />
        <span className="text-[11.5px] text-fg-3">{s.estimated}</span>
      </span>
    );
  return <Amount minor={t.feeMinor} currency={t.currency} showCurrency={false} className="text-fg-2" />;
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
