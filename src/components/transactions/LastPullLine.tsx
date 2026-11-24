import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { PullRun } from '@/lib/contract';
import { pullRangeLabel } from '@/lib/strings';
import { DateTime } from '@/components/ui/DateTime';

/** Domains searched: all of them when there are three or fewer, else two and the Arabic count of the rest. */
export function DomainsSummary({ domains }: { domains: string[] }) {
  const shown = domains.length <= 3 ? domains : domains.slice(0, 2);
  const rest = domains.length - shown.length;
  const restAr = rest === 1 ? 'ونطاق آخر' : rest === 2 ? 'ونطاقان آخران' : rest <= 10 ? `و${rest} نطاقات أخرى` : `و${rest} نطاقاً آخر`;
  return (
    <>
      {shown.map((d, i) => <span key={d}>{i > 0 && ' و'}<bdi dir="ltr">{d}</bdi></span>)}
      {rest > 0 && <> {restAr}</>}
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
