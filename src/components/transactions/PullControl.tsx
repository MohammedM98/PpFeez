import { useQuery } from '@tanstack/react-query';
import { MenuTrigger, Menu, MenuItem, Popover, ProgressBar } from 'react-aria-components';
import { CloudDownload } from 'lucide-react';
import { api } from '@/lib/api';
import { usePull } from '@/lib/pull';
import { Button } from '@/components/ui/Button';
import { txn as s } from '@/lib/strings';

export function PullControl({ label = s.pull }: { label?: string }) {
  const { run, start, cancel } = usePull();
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: api.mailboxList });
  const ready = (mailboxes.data ?? []).filter((m) => m.isActive);

  if (run) {
    return (
      <div className="flex h-9 items-center gap-3 rounded-ctl border border-line bg-surface ps-3 pe-1">
        <ProgressBar aria-label={`سحب من ${run.mailboxLabel}`} value={run.fetchedCount} maxValue={Math.max(1, run.totalCount)} className="flex w-[140px] flex-col">
          {({ percentage }) => (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
              {/* fills from the right in RTL */}
              <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${percentage}%` }} />
            </div>
          )}
        </ProgressBar>
        <span className="num whitespace-nowrap text-[13px] text-fg-2">
          مقروءة {run.fetchedCount}/{run.totalCount}
          <span className="mx-2 text-fg-3">جديدة {run.newTransactionsCount}</span>
          <span className="text-fg-3">مكررة {run.duplicateCount}</span>
          <span className="mx-2 text-fg-3">فاشلة {run.failedCount}</span>
        </span>
        <Button size="sm" variant="quiet" onPress={() => void cancel()}>إلغاء</Button>
      </div>
    );
  }

  if (ready.length > 1) {
    return (
      <MenuTrigger>
        <Button variant="primary"><CloudDownload />{label}</Button>
        <Popover placement="bottom end" className="min-w-56 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
          <Menu className="outline-none" onAction={(k) => void start(Number(k))}>
            {ready.map((m) => (
              <MenuItem key={m.id} id={m.id} textValue={m.label} className="flex cursor-default flex-col rounded-[6px] px-2.5 py-1.5 text-sm outline-none data-[focused]:bg-raised">
                <span>{m.label}</span><bdi dir="ltr" className="text-[12.5px] text-fg-3">{m.email}</bdi>
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
    );
  }
  return (
    <Button variant="primary" isDisabled={ready.length === 0} onPress={() => ready[0] && void start(ready[0].id)}>
      <CloudDownload />{label}
    </Button>
  );
}
