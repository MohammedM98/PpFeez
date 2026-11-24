import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, RefreshCw, ShieldQuestion, TriangleAlert } from 'lucide-react';
import { useExcelUpdate } from '@/components/settings/useExcelUpdate';
import { api } from '@/lib/api';
import type { Period, RefundAlert } from '@/lib/contract';
import { formatMinor } from '@/lib/money';
import { periodLabels, presetPeriod, type PeriodPreset } from '@/lib/period';
import { useAction } from '@/lib/useAction';
import { PageHeader } from '@/components/layout/PageHeader';
import { PullControl, PullProgress } from '@/components/transactions/PullControl';
import { LastPullLine } from '@/components/transactions/LastPullLine';
import { Amount, amountFit, amountWidth } from '@/components/ui/Amount';
import { HeadLabel, TableFrame, sumWidths } from '@/components/ui/Table';
import { Button, button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { DateRangePicker } from '@/components/ui/DateFields';
import { DateTime } from '@/components/ui/DateTime';
import { ConfirmMoney } from '@/components/ui/ConfirmMoney';
import { TextField } from '@/components/ui/TextField';
import { cx } from '@/components/ui/cx';
import { Trunc } from '@/components/ui/Trunc';


const DASH_COLS = ['grossMinor', 'feeMinor', 'commissionMinor', 'paidOutMinor', 'owedToCustomersMinor'] as const;
type DashCol = (typeof DASH_COLS)[number];
function CountCard({ label, value, to, hint, tone, scrollTo }: { label: string; value: number | undefined; to: string; hint: string; tone?: 'warn'; scrollTo?: string }) {
  const hot = (value ?? 0) > 0;
  return (
    <Link to={to} onClick={scrollTo ? (e) => { e.preventDefault(); document.getElementById(scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } : undefined} className="group flex flex-col rounded-card border border-line bg-surface px-4 py-3.5 outline-none transition-colors duration-150 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-focus">
      <span className="text-[13px] text-fg-3">{label}</span>
      <span className={cx('num mt-1 text-[30px] font-medium leading-none', hot ? (tone === 'warn' ? 'text-warn' : 'text-fg') : 'text-fg-3')}>{value ?? '—'}</span>
      <span className="mt-2 text-[12.5px] text-fg-3 group-hover:text-fg-2">{hint}</span>
    </Link>
  );
}

function RefundAlerts({ alerts, domains }: { alerts: RefundAlert[]; domains: { domain: string; count: number }[] }) {
  const [confirming, setConfirming] = useState<RefundAlert | null>(null);
  const [amountText, setAmountText] = useState('');
  const { run, pending } = useAction();
  if (!alerts.length && !domains.length) return null;
  return (
    <section id="refund-alerts" className="mb-6">
      <h2 className="mb-2 text-[15px] font-medium text-fg">تنبيهات تحتاج إجراء</h2>
      <ul className="divide-y divide-line overflow-hidden rounded-card border border-neg/30 bg-surface">
        {domains.map((d) => (
          <li key={d.domain} className="flex items-center gap-4 px-4 py-3">
            <ShieldQuestion className="size-[18px] shrink-0 text-warn" strokeWidth={1.6} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="text-fg">رسائل من نطاق PayPal غير معروف: <bdi dir="ltr" className="font-medium">{d.domain}</bdi> <span className="num text-fg-3">({d.count})</span></div>
              <div className="text-[12.5px] text-fg-3">موقّعة توقيعاً صحيحاً لكنها لم تُقرأ. إن كان نطاق PayPal في بلد المرسل فثق به لتُقرأ</div>
            </div>
            <Link to="/emails?tab=ignored" className={button({ variant: 'secondary', size: 'sm' })}>مراجعة الرسائل</Link>
          </li>
        ))}
        {alerts.map((a) => (
          <li key={a.refundTxn.id} className="flex items-center gap-4 px-4 py-3">
            <TriangleAlert className="size-[18px] shrink-0 text-neg" strokeWidth={1.6} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="text-fg">
                استرداد <Amount minor={a.refundTxn.grossMinor} currency={a.refundTxn.currency} className="text-neg" /> لمعاملة معتمدة لـ <b className="font-medium">{a.customer.name}</b>
              </div>
              <div className="text-[12.5px] text-fg-3">
                من <bdi>{a.originalTxn.payerName}</bdi>، الأصلية <Amount minor={a.originalTxn.grossMinor} currency={a.originalTxn.currency} /> بتاريخ <DateTime iso={a.originalTxn.occurredAt} dateOnly />
              </div>
            </div>
            <div className="text-end text-[12.5px] text-fg-3">
              القيد المقترح
              <div className="text-sm"><Amount minor={a.suggestedReversalMinor} currency={a.originalTxn.currency} className="text-neg" /></div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="quiet" isPending={pending} onPress={() => void run(() => api.refundDismiss(a.refundTxn.id), 'تُجوهل التنبيه')}>تجاهل</Button>
              <Button size="sm" variant="secondary" onPress={() => { setAmountText(''); setConfirming(a); }}>مراجعة القيد</Button>
            </div>
          </li>
        ))}
      </ul>
      {confirming && (
        <ConfirmMoney isOpen onOpenChange={(o) => !o && setConfirming(null)} title={`قيد عكسي في دفتر ${confirming.customer.name}`} tone="danger"
          currency={confirming.originalTxn.currency} confirmLabel="إنشاء القيد" pending={pending}
          {...(amountText.trim() ? { amountText: `-${amountText.trim()}` } : { amount: confirming.suggestedReversalMinor })}
          onConfirm={async () => {
            const r = await run(() => api.refundConfirmReversal(confirming.refundTxn.id, amountText.trim() || undefined), 'أُنشئ القيد العكسي');
            if (r.ok) setConfirming(null);
          }}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-2">
              المقترح يساوي حصة العميل من المبلغ المسترد. في الاسترداد الجزئي يمكنك تعديله قبل التأكيد.
            </p>
            <TextField label="مبلغ آخر (اختياري)" ltr suffix={confirming.originalTxn.currency} value={amountText} onChange={setAmountText}
              placeholder={formatMinor(-confirming.suggestedReversalMinor, confirming.originalTxn.currency)} description="اتركه فارغاً لاستخدام المقترح" />
          </div>
        </ConfirmMoney>
      )}
    </section>
  );
}

function ExcelCard() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const excel = useExcelUpdate();
  const { run } = useAction();
  const s = settings.data;
  if (!s) return null;
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-center gap-2 text-sm text-fg"><FileSpreadsheet className="size-4 text-fg-3" strokeWidth={1.6} />ملف Excel</div>
      {s.excelExportPath ? (
        <>
          <p className="mt-1 text-[12.5px] text-fg-3">{s.excelLastExportedAt ? <>آخر تحديث <DateTime iso={s.excelLastExportedAt} /></> : 'لم يُحدَّث بعد'}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="secondary" isPending={excel.pending} onPress={() => void excel.update()}><RefreshCw />تحديث ملف Excel</Button>
            <Button size="sm" variant="quiet" onPress={() => void run(() => api.openPath(s.excelExportPath!))}>فتح الملف</Button>
          </div>
        </>
      ) : (
        <p className="mt-1 text-[12.5px] text-fg-3">لم يُختر ملف بعد. <Link to="/settings" className="text-accent-ink hover:underline">اختره من الإعدادات</Link></p>
      )}
      {excel.dialog}
    </div>
  );
}

export function DashboardPage() {
  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [custom, setCustom] = useState<Period>({});
  const period = preset === 'custom' ? custom : presetPeriod(preset);
  const summary = useQuery({ queryKey: ['dashboard', period], queryFn: () => api.dashboardSummary(period) });
  const alerts = useQuery({ queryKey: ['refund_alerts'], queryFn: api.refundAlerts });
  const unknownDomains = useQuery({ queryKey: ['unknown_paypal_domains'], queryFn: api.unknownPaypalDomains });
  const s = summary.data;
  const fit = Object.fromEntries(DASH_COLS.map((k) => [k, amountFit((s?.byCurrency ?? []).map((c) => ({ minor: c[k], currency: c.currency })))])) as Record<DashCol, number>;
  const run = s?.lastPull;
  const topByCurrency = new Map<string, NonNullable<typeof s>['topCustomers']>();
  s?.topCustomers.forEach((t) => topByCurrency.set(t.balance.currency, [...(topByCurrency.get(t.balance.currency) ?? []), t]));

  return (
    <div className="mx-auto flex min-h-full max-w-[1560px] flex-col px-6 pb-8 pt-6">
      <PageHeader
        title="لوحة التحكم"
        subtitle={<LastPullLine run={run} />}
        actions={<PullControl label="سحب الآن" />}
      />

      <PullProgress />
      <div className="mb-6 grid grid-cols-5 gap-3">
        <CountCard label="غير مخصّصة" value={s?.counts.unassigned} to="/transactions?tab=unassigned" hint="خصّصها لعملائها" />
        <CountCard label="تحتاج رسوم" value={s?.counts.needsFee} to="/transactions?tab=unassigned&needsFee=1" hint="أدخل رسوم PayPal أو الصافي" tone="warn" />
        <CountCard label="بانتظار الموافقة" value={s?.counts.pendingApproval} to="/customers?pending=1" hint="في صفحات العملاء، اعتمدها بعد موافقتهم" />
        <CountCard label="تحتاج مراجعة" value={s?.counts.needsReview} to="/transactions?tab=unassigned&needsReview=1" hint="أكّد بياناتها قبل الاعتماد" tone="warn" />
        <CountCard label="تنبيهات" value={s ? s.counts.refundAlerts + (unknownDomains.data?.length ?? 0) : undefined} to="/dashboard" scrollTo="refund-alerts" hint="استردادات ونطاقات غير معروفة" tone="warn" />
      </div>

      <RefundAlerts alerts={alerts.data ?? []} domains={unknownDomains.data ?? []} />

      <div className="grid grid-cols-1 gap-6 min-[1440px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-medium text-fg">حسب العملة</h2>
            <div className="flex items-center gap-2">
              {preset === 'custom' && <DateRangePicker label="الفترة المخصّصة" value={custom} onChange={setCustom} className="w-[240px]" />}
              <Select label="الفترة" value={preset} onChange={(k) => setPreset(k as PeriodPreset)} className="w-[140px]"
                options={(Object.keys(periodLabels) as PeriodPreset[]).map((k) => ({ id: k, label: periodLabels[k] }))} />
            </div>
          </div>
          <TableFrame>
            <table className="w-full table-fixed border-separate border-spacing-0 text-sm" style={{ minWidth: sumWidths(['72px', ...DASH_COLS.map((k) => amountWidth(fit[k], false, 92))]) }} aria-label="الأرقام لكل عملة">
              <colgroup><col style={{ width: '72px' }} />{DASH_COLS.map((k) => <col key={k} />)}</colgroup>
              <thead>
                <tr className="[&>th]:h-10 [&>th]:border-b [&>th]:border-line [&>th]:bg-surface [&>th]:px-2.5 [&>th]:font-normal [&>th]:whitespace-nowrap">
                  <th className="sticky z-[1] !ps-4 text-start" data-sticky="start" style={{ insetInlineStart: 0 }}><HeadLabel>العملة</HeadLabel></th>
                  <th className="text-end"><HeadLabel>إجمالي الوارد</HeadLabel></th>
                  <th className="text-end"><HeadLabel>رسوم PayPal</HeadLabel></th>
                  <th className="text-end"><HeadLabel>عمولتي</HeadLabel></th>
                  <th className="text-end"><HeadLabel>مدفوع للعملاء</HeadLabel></th>
                  <th className="!pe-4 text-end"><HeadLabel>مستحق للعملاء الآن</HeadLabel></th>
                </tr>
              </thead>
              <tbody className="[&>tr>td]:h-12 [&>tr>td]:border-b [&>tr>td]:border-line [&>tr>td]:bg-surface [&>tr>td]:px-2.5 [&>tr>td]:whitespace-nowrap [&>tr:last-child>td]:border-b-0">
                {s?.byCurrency.map((c) => (
                  <tr key={c.currency}>
                    <td className="sticky z-[1] !ps-4 font-medium" data-sticky="start" style={{ insetInlineStart: 0 }}>{c.currency}</td>
                    <td className="text-end"><Amount fit={fit.grossMinor} minor={c.grossMinor} currency={c.currency} showCurrency={false} /></td>
                    <td className="text-end"><Amount fit={fit.feeMinor} minor={c.feeMinor} currency={c.currency} showCurrency={false} className="text-fg-2" /></td>
                    <td className="text-end"><Amount fit={fit.commissionMinor} minor={c.commissionMinor} currency={c.currency} showCurrency={false} className="font-medium text-accent-ink" /></td>
                    <td className="text-end"><Amount fit={fit.paidOutMinor} minor={c.paidOutMinor} currency={c.currency} showCurrency={false} className="text-fg-2" /></td>
                    <td className="!pe-4 text-end"><Amount fit={fit.owedToCustomersMinor} minor={c.owedToCustomersMinor} currency={c.currency} showCurrency={false} className={cx('font-medium', c.owedToCustomersMinor < 0 && 'text-neg')} /></td>
                  </tr>
                ))}
                {s && s.byCurrency.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-fg-3">لا معاملات بعد</td></tr>}
              </tbody>
            </table>
          </TableFrame>
          <p className="mt-2 text-[12.5px] text-fg-3">«مستحق للعملاء الآن» مجموع أرصدتهم الحالية ولا يتأثر بالفترة</p>
        </section>

        <section>
          <h2 className="mb-2 flex h-9 items-center text-[15px] font-medium text-fg">أعلى العملاء رصيداً</h2>
          <div className="grid grid-cols-2 gap-3 min-[1440px]:grid-cols-1">
            {[...topByCurrency.entries()].map(([cur, list]) => (
              <div key={cur} className="overflow-hidden rounded-card border border-line bg-surface">
                <div className="border-b border-line px-4 py-2 text-[12.5px] text-fg-3">{cur}</div>
                <ol>
                  {list.map((t) => (
                    <li key={t.customerId}>
                      <Link to={`/customers/${t.customerId}`} className="flex h-10 items-center justify-between gap-3 px-4 text-sm outline-none hover:bg-raised/50 focus-visible:bg-raised">
                        <Trunc className="min-w-0 flex-1">{t.name}</Trunc>
                        <Amount fit={amountFit(list.map((x) => ({ minor: x.balance.minor, currency: cur })))} minor={t.balance.minor} currency={cur} showCurrency={false} className={t.balance.minor < 0 ? 'text-neg' : 'text-fg'} />
                      </Link>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            {topByCurrency.size === 0 && <p className="text-sm text-fg-3">لا أرصدة بعد</p>}
            <ExcelCard />
          </div>
        </section>
      </div>
    </div>
  );
}
