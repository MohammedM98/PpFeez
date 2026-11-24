import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { txn as s } from '@/lib/strings';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/layout/PageHeader';
import { PullControl, PullProgress } from '@/components/transactions/PullControl';
import { LastPullLine } from '@/components/transactions/LastPullLine';
import { TransactionsView } from '@/components/transactions/TransactionsView';
import { useTxnActions } from '@/components/transactions/TxnActions';

export function TransactionsPage() {
  const lastPull = useQuery({ queryKey: ['pull_runs', 1], queryFn: () => api.pullRunsList(1) });
  const actions = useTxnActions();
  const [exportSlot, setExportSlot] = useState<HTMLElement | null>(null);
  const run = lastPull.data?.[0];
  return (
    <div className="mx-auto flex min-h-full max-w-[1560px] flex-col px-6 pb-8 pt-6">
      <PageHeader
        title={s.title}
        subtitle={(!run || run.status !== 'running') && <LastPullLine run={run} />}
        actions={<>
          <span ref={setExportSlot} className="contents" />
          <Button variant="secondary" onPress={() => actions.open({ kind: 'manual' })}><Plus />{s.addManual}</Button>
          <PullControl />
        </>}
      />
      <PullProgress />
      <TransactionsView exportSlot={exportSlot} />
    </div>
  );
}
