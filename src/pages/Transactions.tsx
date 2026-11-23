import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { txn as s } from '@/lib/strings';
import { Button } from '@/components/ui/Button';
import { DateTime } from '@/components/ui/DateTime';
import { PageHeader } from '@/components/layout/PageHeader';
import { PullControl } from '@/components/transactions/PullControl';
import { TransactionsView } from '@/components/transactions/TransactionsView';
import { useTxnActions } from '@/components/transactions/TxnActions';

export function TransactionsPage() {
  const lastPull = useQuery({ queryKey: ['pull_runs', 1], queryFn: () => api.pullRunsList(1) });
  const actions = useTxnActions();
  const run = lastPull.data?.[0];
  return (
    <div className="mx-auto flex min-h-full max-w-[1560px] flex-col px-6 pb-8 pt-6">
      <PageHeader
        title={s.title}
        subtitle={run && run.status !== 'running' && (
          <>آخر سحب من {run.mailboxLabel} <DateTime iso={run.finishedAt ?? run.startedAt} />، {run.status === 'failed' ? <span className="text-neg">فشل</span> : <>{run.newTransactionsCount} جديدة</>}</>
        )}
        actions={<>
          <Button variant="secondary" onPress={() => actions.open({ kind: 'manual' })}><Plus />{s.addManual}</Button>
          <PullControl />
        </>}
      />
      <TransactionsView />
    </div>
  );
}
