import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { LedgerEntry } from '@/lib/contract';
import { ledgerType } from '@/lib/strings';
import { useAction } from '@/lib/useAction';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { ConfirmMoney } from '@/components/ui/ConfirmMoney';
import { DangerConfirm, deletedToast } from '@/components/ui/DangerConfirm';
import { TextField } from '@/components/ui/TextField';
import { cx } from '@/components/ui/cx';

/** SPEC 4.7: a payout or adjustment (with its reversal pair); shows the balance before and after. */
export function DeleteEntryDialog({ entry, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const preview = useQuery({ queryKey: ['ledger_delete_preview', entry.id], queryFn: () => api.ledgerDeletePreview(entry.id), staleTime: 0 });
  const { run, pending } = useAction();
  const p = preview.data;
  return (
    <DangerConfirm title={p && p.entries.length > 1 ? 'حذف القيد وعكسه' : 'حذف القيد'} confirmLabel="حذف نهائياً" pending={pending} isLoading={!p} backup="auto" onClose={onClose}
      onConfirm={async (reason) => {
        const r = await run(() => api.ledgerDeleteEntry(entry.id, reason || undefined));
        if (r.ok) { deletedToast(p && p.entries.length > 1 ? 'حُذف القيد وعكسه' : 'حُذف القيد', r.value.backup); onClose(); }
      }}>
      {p && (
        <div className="flex flex-col gap-3 text-sm">
          <ul className="divide-y divide-line rounded-card border border-line">
            {p.entries.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                <bdi dir="ltr" className="num text-[13px] text-fg-3">{e.entryDate}</bdi>
                <Badge tone={e.type === 'reversal' ? 'neg' : e.type === 'payout' ? 'neutral' : 'outline'}>{ledgerType[e.type]}</Badge>
                <span className="min-w-0 flex-1 truncate text-fg-2">{e.description}</span>
                <Amount minor={e.amountMinor} currency={e.currency} tone="signed" />
              </li>
            ))}
          </ul>
          {p.entries.length > 1 && <p className="text-[13px] text-fg-3">القيد معكوس، فيُحذف معه قيد عكسه.</p>}
          <div className="flex items-center justify-around rounded-card bg-raised/60 px-4 py-3 text-center">
            <div><div className="text-[12.5px] text-fg-3">الرصيد الآن</div><Amount minor={p.balanceBeforeMinor} currency={entry.currency} className="text-[17px] font-medium" /></div>
            <span className="text-fg-3" aria-hidden>←</span>
            <div><div className="text-[12.5px] text-fg-3">بعد الحذف</div><Amount minor={p.balanceAfterMinor} currency={entry.currency} className={cx('text-[17px] font-medium', p.balanceAfterMinor < 0 && 'text-neg')} /></div>
          </div>
        </div>
      )}
    </DangerConfirm>
  );
}

export function ReverseDialog({ entry, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { run, pending } = useAction();
  return (
    <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title="عكس القيد" tone="danger" amount={-entry.amountMinor} currency={entry.currency}
      confirmLabel="عكس القيد" pending={pending} extraValid={reason.trim().length > 0}
      onConfirm={async () => { const r = await run(() => api.ledgerReverseEntry(entry.id, reason.trim()), 'عُكس القيد'); if (r.ok) onClose(); }}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">يُضاف قيد معاكس بوصف «عكس: {entry.description}»، ويبقى القيد الأصلي ظاهراً مشطوباً.</p>
        <TextField label="السبب" value={reason} onChange={setReason} isRequired autoFocus />
      </div>
    </ConfirmMoney>
  );
}
