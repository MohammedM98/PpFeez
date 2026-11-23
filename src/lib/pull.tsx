import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, events, toAppError } from './api';
import type { PullRun } from './contract';
import { toast } from '@/components/ui/Toast';

type Ctx = { run: PullRun | null; start: (mailboxId: number) => Promise<void>; cancel: () => Promise<void> };
const PullCtx = createContext<Ctx>({ run: null, start: async () => {}, cancel: async () => {} });

/** One pull at a time, app-wide; progress arrives via 'pull://progress' events. */
export function PullProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [run, setRun] = useState<PullRun | null>(null);

  useEffect(() => {
    // pick up a pull that was already running (e.g. after a reload)
    api.pullRunsList(1).then((r) => r[0]?.status === 'running' && setRun(r[0])).catch(() => {});
    const offs = [
      events.onPullProgress((r) => setRun(r)),
      events.onPullFinished((r) => {
        setRun(null);
        if (r.status === 'done') toast.ok(`انتهى السحب من ${r.mailboxLabel}`, `${r.newTransactionsCount} معاملة جديدة، ${r.duplicateCount} مكررة، ${r.ignoredCount} متجاهلة، ${r.failedCount} فاشلة`);
        else if (r.status === 'cancelled') toast.ok('أُلغي السحب', `قُرئت ${r.fetchedCount} من ${r.totalCount}`);
        else toast.error('فشل السحب', r.error ?? undefined);
        void qc.invalidateQueries();
      }),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, [qc]);

  const start = async (mailboxId: number) => {
    try {
      setRun(await api.pullStart(mailboxId));
    } catch (e) {
      toast.error(toAppError(e).messageAr);
    }
  };
  const cancel = async () => {
    if (run) await api.pullCancel(run.id).catch((e) => toast.error(toAppError(e).messageAr));
  };
  return <PullCtx.Provider value={{ run, start, cancel }}>{children}</PullCtx.Provider>;
}

export const usePull = () => useContext(PullCtx);
