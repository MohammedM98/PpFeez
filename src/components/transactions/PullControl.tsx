import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ProgressBar } from '@heroui/react';
import { CloudDownload } from 'lucide-react';
import { api } from '@/lib/api';
import { usePull } from '@/lib/pull';
import { Button } from '@/components/ui/Button';
import { pullRangeLabel, txn as s } from '@/lib/strings';
import { PullDialog } from './PullDialog';

export function PullControl({ label = s.pull }: { label?: string }) {
  const { run } = usePull();
  const [open, setOpen] = useState(false);
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: api.mailboxList });
  const ready = (mailboxes.data ?? []).filter((m) => m.isActive);

  if (run) {
    return <Button variant="primary" isPending aria-label="جارٍ السحب"><CloudDownload />جارٍ السحب</Button>;
  }

  return (
    <>
      <Button variant="primary" isDisabled={ready.length === 0} onPress={() => setOpen(true)}>
        <CloudDownload />{label}
      </Button>
      {open && <PullDialog mailboxes={ready} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Full-width strip under the page header while a pull runs: range, progress, counts, cancel. */
export function PullProgress() {
  const { run, cancel } = usePull();
  if (!run) return null;
  return (
    <div className="mb-4 flex h-11 items-center gap-4 rounded-card border border-line bg-surface pe-2 ps-4" role="status">
      <span className="whitespace-nowrap text-sm text-fg">سحب من {run.mailboxLabel}، {pullRangeLabel(run.range)}</span>
      <ProgressBar aria-label={`سحب من ${run.mailboxLabel}`} value={run.fetchedCount} maxValue={Math.max(1, run.totalCount)} size="sm" className="min-w-[120px] flex-1">
        <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
      </ProgressBar>
      <span className="num flex gap-4 whitespace-nowrap text-[13px] text-fg-3">
        <span className="text-fg-2">مقروءة {run.fetchedCount}/{run.totalCount}</span>
        <span>جديدة {run.newTransactionsCount}</span>
        <span>مكررة {run.duplicateCount}</span>
        <span>فاشلة {run.failedCount}</span>
      </span>
      <Button size="sm" variant="quiet" onPress={() => void cancel()}>إلغاء</Button>
    </div>
  );
}
