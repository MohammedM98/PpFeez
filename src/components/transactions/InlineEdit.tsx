import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, toAppError } from '@/lib/api';
import type { CommissionInput, FeeInput, Transaction } from '@/lib/contract';
import { bpsToPercentText, formatMinor, percentTextToBps } from '@/lib/money';
import { toast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { usePreview } from './usePreview';

/*
 * SPEC 6.10 "تعديل داخل الخلية": the fee and the commission of a transaction that is not approved yet,
 * edited in its cell (double-click or F2) with the core's live preview under it. Enter saves, Esc
 * leaves it as it was. Every number shown comes from the core (txn_preview).
 */

export type InlineField = 'fee' | 'commission';

function InlineInput({ label, initial, suffix, onSave, onCancel, preview, invalid, onChange }: {
  label: string; initial: string; suffix?: string; invalid?: (v: string) => string | undefined; onChange?: (v: string) => void;
  onSave: (v: string) => Promise<boolean>; onCancel: () => void; preview: (v: string) => ReactNode;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const error = invalid?.(v);
  const key = async (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // the table's own keys (arrows, space, type-ahead) stay out of the field
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    if (e.key === 'Enter' && !error && !busy) {
      e.preventDefault();
      setBusy(true);
      const ok = await onSave(v.trim());
      setBusy(false);
      if (ok) onCancel();
    }
  };
  return (
    <div className="flex flex-col items-end gap-0.5" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className={cx('flex h-7 w-full items-center rounded-[6px] border bg-bg px-1.5', error ? 'border-neg' : 'border-focus')}>
        <input aria-label={label} autoFocus dir="ltr" value={v} onChange={(e) => { setV(e.target.value); onChange?.(e.target.value.trim()); }} onKeyDown={key} onBlur={onCancel}
          aria-invalid={!!error} aria-busy={busy}
          className="num min-w-0 flex-1 bg-transparent text-end text-sm text-fg outline-none" />
        {suffix && <span className="ps-1 text-[12px] text-fg-3">{suffix}</span>}
      </div>
      <div className="num text-[11.5px] leading-4 text-fg-3" aria-live="polite">{error ?? preview(v)}</div>
    </div>
  );
}

async function save(qc: ReturnType<typeof useQueryClient>, fn: () => Promise<Transaction>, ok: string) {
  try {
    await fn();
    await qc.invalidateQueries();
    toast.ok(ok);
    return true;
  } catch (raw) {
    toast.error(toAppError(raw).messageAr);
    return false;
  }
}

export function InlineFee({ t, onDone }: { t: Transaction; onDone: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const input: FeeInput | undefined = text ? { kind: 'fee', feeText: text } : undefined;
  const p = usePreview({ id: t.id, fee: input }).data;
  const initial = t.feeMinor !== null && !t.feeIsEstimated ? formatMinor(t.feeMinor, t.currency).replace(/,/g, '') : '';
  return (
    <InlineInput label="رسوم PayPal" initial={initial} suffix={t.currency} onCancel={onDone}
      onChange={setText} invalid={(v) => (v.trim() && !/^[\d,]+(\.\d+)?$/.test(v.trim()) ? 'مبلغ مثل 12.30' : undefined)}
      preview={() => (p?.netMinor != null ? `الصافي ${formatMinor(p.netMinor, t.currency)}` : '')}
      onSave={(v) => (v ? save(qc, () => api.txnSetFee(t.id, { kind: 'fee', feeText: v }), 'حُفظت الرسوم') : Promise.resolve(true))} />
  );
}

export function InlineCommission({ t, onDone }: { t: Transaction; onDone: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const bps = percentTextToBps(text);
  const input: CommissionInput | undefined = bps === null ? undefined : { mode: 'percent', bps };
  const p = usePreview({ id: t.id, commission: input }).data;
  const initial = t.commissionMode === 'percent' && t.commissionBps !== null ? bpsToPercentText(t.commissionBps) : '';
  return (
    <InlineInput label="نسبة العمولة" initial={initial} suffix="%" onCancel={onDone}
      onChange={setText} invalid={(v) => (v.trim() && percentTextToBps(v) === null ? 'نسبة بين 0 و100' : undefined)}
      preview={() => (p?.customerAmountMinor != null ? `للعميل ${formatMinor(p.customerAmountMinor, t.currency)}` : '')}
      onSave={(v) => { const b = percentTextToBps(v); return b === null ? Promise.resolve(false) : save(qc, () => api.txnSetCommission(t.id, { mode: 'percent', bps: b }), 'حُفظت العمولة'); }} />
  );
}
