import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { txn as s } from '@/lib/strings';
import { Button } from '@/components/ui/Button';
import { tablePage } from '@/components/ui/Table';
import { cx } from '@/components/ui/cx';
import { PageHeader } from '@/components/layout/PageHeader';
import { PullControl, PullProgress } from '@/components/transactions/PullControl';
import { LastPullLine } from '@/components/transactions/LastPullLine';
import { TransactionsView } from '@/components/transactions/TransactionsView';
import { useTxnActions } from '@/components/transactions/TxnActions';
import { openSearch } from '@/components/transactions/SearchDialog';

export function TransactionsPage() {
  const lastPull = useQuery({ queryKey: ['pull_runs', 1], queryFn: () => api.pullRunsList(1) });
  const actions = useTxnActions();
  const [exportSlot, setExportSlot] = useState<HTMLElement | null>(null);
  const run = lastPull.data?.[0];
  return (
    <div className={cx(tablePage, 'max-w-[1800px]')}>
      <PageHeader compact
        title={s.title}
        subtitle={(!run || run.status !== 'running') && <LastPullLine run={run} />}
        actions={<>
          <button type="button" onClick={openSearch} aria-label="بحث في كل المعاملات (Ctrl K)"
            className="flex h-9 w-[200px] items-center gap-2 rounded-ctl border border-line bg-surface px-3 text-start text-[13px] text-fg-3 outline-none hover:border-line-strong focus-visible:outline-2 focus-visible:outline-focus">
            <Search className="size-4 shrink-0" strokeWidth={1.7} />
            <span className="flex-1 truncate">بحث في كل المعاملات</span>
            <kbd className="num rounded border border-line px-1 text-[11px]">Ctrl K</kbd>
          </button>
          <span ref={setExportSlot} className="contents" />
          <Button variant="secondary" onPress={() => actions.open({ kind: 'manual' })}><Plus />{s.addManual}</Button>
          <PullControl />
        </>}
      />
      <PullProgress />
      <TransactionsView scope={{ kind: 'inbox' }} exportSlot={exportSlot} />
    </div>
  );
}
