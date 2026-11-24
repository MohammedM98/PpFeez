import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { PullRun } from '@/lib/contract';
import { pullRangeLabel } from '@/lib/strings';
import { DateTime } from '@/components/ui/DateTime';

/** The first two domains searched, each isolated LTR, then the Arabic count of the rest. */
export function DomainsSummary({ domains }: { domains: string[] }) {
  const shown = domains.slice(0, 2);
  const rest = domains.length - shown.length;
  return (
    <>
      {shown.map((d, i) => <span key={d}>{i > 0 && ' و'}<bdi dir="ltr">{d}</bdi></span>)}
      {rest > 0 && <> و<span className="num">{rest}</span> {rest <= 10 ? 'نطاقات أخرى' : 'نطاقاً آخر'}</>}
    </>
  );
}

/**
 * Last pull: when, where, which range and every count (SPEC 10). A successful pull that
 * found no PayPal mail says so plainly instead of "0 new".
 */
export function LastPullLine({ run }: { run: PullRun | null | undefined }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  if (!run) return <>لم يُسحب البريد بعد</>;
  const head = <>آخر سحب من {run.mailboxLabel} <DateTime iso={run.finishedAt ?? run.startedAt} /> ({pullRangeLabel(run.range, true)})</>;
  if (run.status === 'running') return <>{head}، قيد التشغيل</>;
  if (run.status === 'failed') return <>{head}، <span className="text-neg">فشل{run.error ? `: ${run.error}` : ''}</span></>;
  if (run.status === 'done' && run.totalCount === 0) {
    const domains = [...(settings.data?.builtinPaypalDomains ?? []), ...(settings.data?.extraPaypalDomains ?? [])];
    return (
      <>{head}، <span className="text-warn">لم تُوجد رسائل من PayPal في هذه الفترة</span>
        {domains.length > 0 && <>. بُحث في <DomainsSummary domains={domains} /> (<Link to="/settings" className="text-accent-ink hover:underline">الإعدادات</Link>)</>}
      </>
    );
  }
  return (
    <>{head}{run.status === 'cancelled' && '، أُلغي'}: <span className="num">
      مقروءة {run.fetchedCount}، جديدة {run.newTransactionsCount}، مكررة {run.duplicateCount}، متجاهلة {run.ignoredCount}، فاشلة {run.failedCount}
    </span></>
  );
}
