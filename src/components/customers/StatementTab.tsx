import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MenuTrigger, Menu, MenuItem, Popover } from 'react-aria-components';
import { Check, Download, FileCheck2, FileSpreadsheet, MoreHorizontal, Printer, X } from 'lucide-react';
import { api, native } from '@/lib/api';
import type { Customer, CustomerExcelItemRef, LedgerEntry, Payout, PayoutSelection, Period, StatementFilter, StatementRow, Transaction, TxnAction } from '@/lib/contract';
import { formatBps } from '@/lib/money';
import { formatDateTime } from '@/lib/dates';
import { payoutMethod, payoutStatus, transferCountLabel } from '@/lib/strings';
import { periodLabels, presetPeriod, type PeriodPreset } from '@/lib/period';
import { useAction } from '@/lib/useAction';
import { Amount, amountFit, amountWidth } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox, Select } from '@/components/ui/Field';
import { DateRangePicker } from '@/components/ui/DateFields';
import { Segmented } from '@/components/ui/Segmented';
import { HeadLabel, SELECT_W, TableFrame, TotalsCell, TotalsTable, sumWidths } from '@/components/ui/Table';
import { Trunc } from '@/components/ui/Trunc';
import { toast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { DetailPanel } from '@/components/transactions/DetailPanel';
import { actionLabel, useTxnActions } from '@/components/transactions/TxnActions';
import { AddToStatementDialog } from './CustomerExcel';
import { DeleteEntryDialog, ReverseDialog } from './EntryDialogs';
import { CancelPayoutDialog, MarkSentDialog, PayoutDetailsDialog, PayoutItemsDialog } from './PayoutDialogs';

/*
 * SPEC 6.5: one statement per currency. Transfers (له), payouts (عليه), adjustments and reversals in
 * one table with a running balance, under the eight figures of SPEC 4.8. Every number comes from the core.
 */

type Show = NonNullable<StatementFilter['show']>;
const SHOWS: { id: Show; label: string }[] = [
  { id: 'all', label: 'الكل' }, { id: 'unpaid', label: 'غير المدفوع' }, { id: 'paid', label: 'المدفوع' }, { id: 'payouts', label: 'الدفعات فقط' },
];

const keyOf = (r: StatementRow) => (r.kind === 'txn' ? `t:${r.txn.id}` : r.kind === 'payout' ? `p:${r.payout.id}` : `e:${r.entry.id}`);
const dateOf = (r: StatementRow) => (r.kind === 'txn' ? formatDateTime(r.txn.occurredAt).slice(0, 10) : r.kind === 'payout' ? r.payout.date : r.entry.entryDate);

function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: 'accent' | 'neg' }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="truncate text-[12.5px] text-fg-3">{label}</div>
      <div className={cx('mt-0.5 truncate text-[17px] font-medium', tone === 'accent' ? 'text-accent-ink' : tone === 'neg' ? 'text-neg' : 'text-fg')}>{children}</div>
    </div>
  );
}

/** The eight figures (SPEC 4.8), as the owner's own workbook shows them. */
export function SummaryBar({ customerId, currency }: { customerId: number; currency: string }) {
  const s = useQuery({ queryKey: ['customer_summary', customerId, currency], queryFn: () => api.customerSummary(customerId, currency) }).data;
  const money = (m: number | undefined) => (m === undefined ? '—' : <Amount minor={m} currency={currency} showCurrency={false} />);
  return (
    <section aria-label={`ملخص ${currency}`} className="mb-4 grid grid-cols-4 divide-x divide-x-reverse divide-line overflow-hidden rounded-card border border-line bg-surface [&>*:nth-child(n+5)]:border-t [&>*:nth-child(n+5)]:border-line">
      <Stat label="الصافي المكتمل">{money(s?.netCompletedMinor)}</Stat>
      <Stat label="المُرسل">{money(s?.sentMinor)}</Stat>
      <Stat label="المتبقي" tone={s && s.remainingMinor < 0 ? 'neg' : 'accent'}>{money(s?.remainingMinor)}{s && s.remainingMinor < 0 && <span className="ms-1.5 text-[13px]">عليه</span>}</Stat>
      <Stat label="غير مدفوع">{s ? transferCountLabel(s.notPaidCount) : '—'}</Stat>
      <Stat label="المبلغ قبل العمولة">{money(s?.grossBeforeCommissionMinor)}</Stat>
      <Stat label="إجمالي العمولة">{money(s?.commissionMinor)}</Stat>
      <Stat label="عدد المعاملات"><span className="num">{s?.txnCount ?? '—'}</span></Stat>
      <Stat label="عدد المدفوع"><span className="num">{s?.paidCount ?? '—'}</span></Stat>
    </section>
  );
}

function SentCell({ t, onPayout }: { t: Transaction; onPayout: (id: number) => void }) {
  if (!t.payout) return <Badge tone="neutral">لا</Badge>;
  const label = t.payout.status === 'sent' ? `نعم — دفعة ${t.payout.seq}` : `مسجلة — دفعة ${t.payout.seq}`;
  return (
    <button type="button" onClick={() => onPayout(t.payout!.id)} className="rounded-[6px] outline-none focus-visible:outline-2 focus-visible:outline-focus" title="الانتقال إلى سطر الدفعة">
      <Badge tone={t.payout.status === 'sent' ? 'pos' : 'accent'}>{label}</Badge>
    </button>
  );
}

const payoutTone = { sent: 'pos', draft: 'accent', cancelled: 'outline' } as const;

export function StatementTab({ customer, currency, onPrepare }: { customer: Customer; currency: string; onPrepare: (selection: PayoutSelection) => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [show, setShow] = useState<Show>('all');
  const [preset, setPreset] = useState<PeriodPreset>('all');
  const [custom, setCustom] = useState<Period>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'reverse' | 'delete-entry'; entry: LedgerEntry }
    | { kind: 'send' | 'cancel' | 'details' | 'items'; payout: Payout }
    | { kind: 'statement'; items: CustomerExcelItemRef[] }
    | null>(null);
  const actions = useTxnActions();
  const { run } = useAction();
  const period = preset === 'custom' ? custom : presetPeriod(preset);
  const filter: StatementFilter = { show, period: period.from || period.to ? period : undefined };
  const st = useQuery({
    queryKey: ['customer_statement', customer.id, currency, filter],
    queryFn: () => api.customerStatement(customer.id, currency, filter),
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => st.data?.rows ?? [], [st.data]);

  // a transaction opened from search, a toast or the inbox: its panel, and a brief highlight on its row
  const detail = params.get('detail') ? Number(params.get('detail')) : null;
  useEffect(() => { if (detail !== null) setFlash(`t:${detail}`); }, [detail]);
  useEffect(() => {
    if (!flash || !rows.some((r) => keyOf(r) === flash)) return;
    document.getElementById(`row-${flash}`)?.scrollIntoView({ block: 'center' });
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash, rows]);
  const openDetail = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id === null) p.delete('detail'); else p.set('detail', String(id));
    setParams(p, { replace: true });
  };
  useEffect(() => setPicked(new Set()), [show, preset, custom.from, custom.to]);

  const fit = useMemo(() => {
    const of = (f: (r: StatementRow) => number | null | undefined, extra: (number | null)[] = []) =>
      amountFit([...rows.map((r) => ({ minor: f(r), currency })), ...extra.map((minor) => ({ minor, currency }))]);
    const credit = (r: StatementRow) => (r.kind === 'txn' ? r.txn.customerAmountMinor : r.kind === 'entry' && r.entry.amountMinor > 0 ? r.entry.amountMinor : null);
    const debit = (r: StatementRow) => (r.kind === 'payout' ? r.payout.amountMinor : r.kind === 'entry' && r.entry.amountMinor < 0 ? -r.entry.amountMinor : null);
    return {
      gross: of((r) => (r.kind === 'txn' ? r.txn.grossMinor : null)),
      fee: of((r) => (r.kind === 'txn' ? r.txn.feeMinor : null)),
      net: of((r) => (r.kind === 'txn' ? r.txn.netMinor : null)),
      commission: of((r) => (r.kind === 'txn' ? r.txn.commissionMinor : null)),
      credit: of(credit), debit: of(debit),
      balance: of((r) => r.runningBalanceMinor, [st.data?.openingBalanceMinor ?? null, st.data?.closingBalanceMinor ?? null]),
    };
  }, [rows, currency, st.data]);
  const W = useMemo(() => {
    const w = {
      select: SELECT_W, seq: '72px', date: '96px',
      gross: amountWidth(fit.gross, false, 156), fee: amountWidth(fit.fee, false, 100), net: amountWidth(fit.net, false, 128),
      commission: amountWidth(fit.commission, false, 76), credit: amountWidth(fit.credit, false, 64), debit: amountWidth(fit.debit, false, 64),
      balance: amountWidth(fit.balance, false, 80), sent: '136px', method: '148px', ref: '128px', matched: '76px', notes: '140px', excel: '40px', menu: '48px',
    };
    return { ...w, min: sumWidths([...Object.values(w), '200px']) };
  }, [fit]);
  const widths = [W.select, W.seq, W.date, undefined, W.gross, W.fee, W.net, W.commission, W.credit, W.debit, W.balance, W.sent, W.method, W.ref, W.matched, W.notes, W.excel, W.menu];

  const pickedRows = rows.filter((r) => picked.has(keyOf(r)));
  const pickedTxns = pickedRows.flatMap((r) => (r.kind === 'txn' ? [r.txn] : []));
  const toggle = (k: string, on: boolean) => setPicked((prev) => { const n = new Set(prev); if (on) n.add(k); else n.delete(k); return n; });
  const toPayout = (id: number) => {
    setShow('all');
    setFlash(`p:${id}`);
  };
  const excelItems = (rs: StatementRow[]): CustomerExcelItemRef[] =>
    rs.map((r) => (r.kind === 'txn' ? { kind: 'txn', id: r.txn.id } : r.kind === 'payout' ? { kind: 'payout', id: r.payout.id } : { kind: 'ledger', id: r.entry.id }));

  const exportExcel = async () => {
    const path = await native.saveXlsx(`${customer.name}-${currency}.xlsx`);
    if (!path) return;
    const r = await run(() => api.excelExportLedger(customer.id, path, currency, filter.period));
    if (r.ok) toast.ok('صُدّر كشف الحساب إلى Excel', r.value.path);
  };
  const exportCsv = async () => {
    const path = await native.saveCsv(`${customer.name}-${currency}.csv`);
    if (path) await run(() => api.ledgerExportCsv(customer.id, currency, path, filter.period), 'صُدّر الكشف');
  };
  const print = () => {
    const p = new URLSearchParams({ currency, ...(period.from ? { from: period.from } : {}), ...(period.to ? { to: period.to } : {}) });
    navigate(`/statement/${customer.id}?${p}`);
  };

  const menuItem = 'flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised data-[disabled]:text-fg-3';
  const onTxnMenu = (t: Transaction, k: string) => {
    if (k === 'detail') openDetail(t.id);
    else if (k === 'prepare') onPrepare({ kind: 'ids', txnIds: [t.id] });
    else if (k === 'match') void run(() => api.txnSetMatched([t.id], !t.matched), t.matched ? 'أُزيلت المطابقة' : 'وُضعت علامة مطابق');
    else actions.act(k as TxnAction, t);
  };

  return (
    <div>
      <SummaryBar customerId={customer.id} currency={currency} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented label="عرض" value={show} onChange={setShow} options={SHOWS} className="w-[380px]" />
        <Select label="الفترة" value={preset} onChange={(k) => setPreset(k as PeriodPreset)} className="w-[140px]"
          options={(Object.keys(periodLabels) as PeriodPreset[]).map((k) => ({ id: k, label: periodLabels[k] }))} />
        {preset === 'custom' && <DateRangePicker label="الفترة المخصّصة" value={custom} onChange={setCustom} className="w-[250px]" />}
        <div className="ms-auto flex gap-2">
          <Button variant="secondary" size="sm" onPress={() => void exportExcel()}><FileSpreadsheet />تصدير Excel</Button>
          <Button variant="secondary" size="sm" onPress={() => void exportCsv()}><Download />تصدير CSV</Button>
          <Button variant="secondary" size="sm" onPress={print}><Printer />طباعة كشف</Button>
        </div>
      </div>

      {pickedRows.length > 0 && (
        <div className="mb-3 flex h-11 items-center gap-1 rounded-card bg-accent-soft pe-2 ps-4 text-sm" role="toolbar" aria-label="إجراءات على المحدد">
          <span className="me-3 text-fg">محدّد <span className="num">{pickedRows.length}</span></span>
          {pickedTxns.length > 0 && pickedTxns.every((t) => !t.payout) && (
            <Button size="sm" variant="quiet" onPress={() => onPrepare({ kind: 'ids', txnIds: pickedTxns.map((t) => t.id) })}>تجهيز دفعة من المحدد</Button>
          )}
          {pickedTxns.length > 0 && <>
            <Button size="sm" variant="quiet" onPress={() => void run(() => api.txnSetMatched(pickedTxns.map((t) => t.id), true), 'وُضعت علامة مطابق')}>مطابق</Button>
            <Button size="sm" variant="quiet" onPress={() => void run(() => api.txnSetMatched(pickedTxns.map((t) => t.id), false), 'أُزيلت المطابقة')}>إزالة المطابقة</Button>
          </>}
          <Button size="sm" variant="quiet" onPress={() => setDialog({ kind: 'statement', items: excelItems(pickedRows) })}><FileSpreadsheet />إضافة إلى ملف العميل</Button>
          {pickedTxns.length === 1 && pickedRows.length === 1 && (
            <Button size="sm" variant="quiet" onPress={() => actions.act('unapprove', pickedTxns[0])}>إلغاء الاعتماد</Button>
          )}
          {pickedTxns.length > 0 && pickedTxns.length === pickedRows.length && (
            <Button size="sm" variant="quiet" className="text-neg" onPress={() => actions.open({ kind: 'delete', rows: pickedTxns })}>حذف</Button>
          )}
          <Button size="icon" variant="quiet" aria-label="إلغاء التحديد" className="ms-auto" onPress={() => setPicked(new Set())}><X /></Button>
        </div>
      )}

      <TableFrame>
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm" style={{ minWidth: W.min }} aria-label={`كشف ${currency}`}>
          <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="[&>th]:h-10 [&>th]:overflow-hidden [&>th]:border-b [&>th]:border-line [&>th]:bg-surface [&>th]:px-2.5 [&>th]:font-normal [&>th]:whitespace-nowrap">
              <th className="sticky z-[2] !ps-4 text-start" data-sticky="start-inner" style={{ insetInlineStart: 0 }}>
                <Checkbox aria-label="تحديد كل الأسطر" isSelected={rows.length > 0 && picked.size === rows.length}
                  isIndeterminate={picked.size > 0 && picked.size < rows.length}
                  onChange={(on) => setPicked(on ? new Set(rows.map(keyOf)) : new Set())} />
              </th>
              <th className="sticky z-[2] text-start" data-sticky="start-inner" style={{ insetInlineStart: SELECT_W }}><HeadLabel>#</HeadLabel></th>
              <th className="sticky z-[2] text-start" data-sticky="start" style={{ insetInlineStart: `calc(${SELECT_W} + ${W.seq})` }}><HeadLabel>التاريخ</HeadLabel></th>
              <th className="text-start"><HeadLabel>البيان</HeadLabel></th>
              <th className="text-end"><HeadLabel>المبلغ الكامل من PayPal</HeadLabel></th>
              <th className="text-end"><HeadLabel>خصم PayPal</HeadLabel></th>
              <th className="text-end"><HeadLabel>الصافي من PayPal</HeadLabel></th>
              <th className="text-end"><HeadLabel>العمولة</HeadLabel></th>
              <th className="text-end"><HeadLabel>له</HeadLabel></th>
              <th className="text-end"><HeadLabel>عليه</HeadLabel></th>
              <th className="text-end"><HeadLabel>الرصيد</HeadLabel></th>
              <th className="text-start"><HeadLabel>تم الإرسال؟</HeadLabel></th>
              <th className="text-start"><HeadLabel>طريقة الدفع</HeadLabel></th>
              <th className="text-start"><HeadLabel>المرجع</HeadLabel></th>
              <th className="text-start"><HeadLabel>المطابقة</HeadLabel></th>
              <th className="text-start"><HeadLabel>ملاحظات</HeadLabel></th>
              <th className="text-start"><span title="في ملف العميل" className="inline-flex text-fg-3"><FileCheck2 className="size-4" strokeWidth={1.7} aria-hidden /><span className="sr-only">في ملف العميل</span></span></th>
              <th className="sticky z-[2]" data-sticky="end" style={{ insetInlineEnd: 0 }}><span className="sr-only">إجراءات</span></th>
            </tr>
          </thead>
          <tbody className="[&>tr>td]:h-12 [&>tr>td]:border-b [&>tr>td]:border-line [&>tr>td]:px-2.5 [&>tr>td]:leading-tight [&>tr>td]:whitespace-nowrap [&>tr:last-child>td]:border-b-0">
            {st.data && period.from && (
              <tr className="t-row [--row-tint:color-mix(in_oklab,var(--raised)_40%,transparent)] text-fg-2">
                <td colSpan={10}>رصيد سابق حتى <bdi dir="ltr" className="num">{period.from}</bdi></td>
                <td className="text-end"><Amount fit={fit.balance} minor={st.data.openingBalanceMinor} currency={currency} showCurrency={false} tone="signed" /></td>
                <td colSpan={7} />
              </tr>
            )}
            {rows.map((r) => {
              const k = keyOf(r);
              const tint = flash === k ? '[--row-tint:var(--accent-soft)]'
                : r.kind === 'payout' ? '[--row-tint:color-mix(in_oklab,var(--accent)_7%,transparent)]'
                  : r.kind === 'txn' && detail === r.txn.id ? '[--row-tint:var(--raised)]' : '';
              const sel = (
                <td className="sticky z-[1] !ps-4" data-sticky="start-inner" style={{ insetInlineStart: 0 }}>
                  <Checkbox aria-label="تحديد السطر" isSelected={picked.has(k)} onChange={(on) => toggle(k, on)} />
                </td>
              );
              const seqCell = (text: ReactNode) => <td className="num sticky z-[1] text-fg-2" data-sticky="start-inner" style={{ insetInlineStart: SELECT_W }}>{text}</td>;
              const dateCell = <td className="num sticky z-[1] text-fg-2" data-sticky="start" style={{ insetInlineStart: `calc(${SELECT_W} + ${W.seq})` }}><bdi dir="ltr">{dateOf(r)}</bdi></td>;
              const balance = <td className="text-end font-medium"><Amount fit={fit.balance} minor={r.runningBalanceMinor} currency={currency} showCurrency={false} className={r.runningBalanceMinor < 0 ? 'text-neg' : ''} /></td>;

              if (r.kind === 'txn') {
                const t = r.txn;
                return (
                  <tr key={k} id={`row-${k}`} data-kind="txn" className={cx('t-row hover:[--row-tint:color-mix(in_oklab,var(--raised)_55%,transparent)]', tint)}>
                    {sel}
                    {seqCell(t.customerSeq !== null ? `#${t.customerSeq}` : '—')}
                    {dateCell}
                    <td>
                      <button type="button" onClick={() => openDetail(t.id)} className="block w-full min-w-0 text-start outline-none focus-visible:outline-2 focus-visible:outline-focus">
                        <div className="flex items-center gap-2">
                          <Trunc className="min-w-0 flex-1">حوالة من {t.payerName || t.payerEmail || '—'}</Trunc>
                          {t.holdStatus && <Badge tone="outline" className="shrink-0">{t.holdStatus === 'on_hold' ? 'محجوزة' : 'eCheck معلّق'}</Badge>}
                        </div>
                        {t.payerNote && <Trunc className="text-[12px] text-fg-3">{t.payerNote}</Trunc>}
                      </button>
                    </td>
                    <td className="text-end"><Amount fit={fit.gross} minor={t.grossMinor} currency={currency} showCurrency={false} className="text-fg-2" /></td>
                    <td className="text-end"><Amount fit={fit.fee} minor={t.feeMinor} currency={currency} showCurrency={false} className="text-fg-2" /></td>
                    <td className="text-end"><Amount fit={fit.net} minor={t.netMinor} currency={currency} showCurrency={false} className="text-fg-2" /></td>
                    <td className="text-end">
                      <Amount fit={fit.commission} minor={t.commissionMinor} currency={currency} showCurrency={false} className="text-fg-2" />
                      <div className="num text-[12px] text-fg-3">{t.commissionMode === 'percent' && t.commissionBps !== null ? <bdi dir="ltr">{formatBps(t.commissionBps)}</bdi> : t.commissionMode === 'fixed' ? 'ثابتة' : ''}</div>
                    </td>
                    <td className="text-end"><Amount fit={fit.credit} minor={t.customerAmountMinor} currency={currency} showCurrency={false} className="font-medium text-pos" /></td>
                    <td />
                    {balance}
                    <td><SentCell t={t} onPayout={toPayout} /></td>
                    <td className="text-fg-3">—</td>
                    <td className="text-[13px] text-fg-3"><div dir="ltr" className="num truncate text-right" title={t.paypalTxnId}>{t.paypalTxnId}</div></td>
                    <td>{t.matched ? <span className="inline-flex items-center gap-1 text-[13px] text-pos"><Check className="size-3.5" strokeWidth={2.2} />مطابق</span> : <span className="text-fg-3">—</span>}</td>
                    <td><Trunc className="text-[13px] text-fg-2">{t.note ?? ''}</Trunc></td>
                    <td>{t.inCustomerExcel && <span title="في ملف العميل" aria-label="في ملف العميل" className="inline-flex text-pos"><Check className="size-4" strokeWidth={2} /></span>}</td>
                    <td className="sticky z-[1] pe-2" data-sticky="end" style={{ insetInlineEnd: 0 }}>
                      <MenuTrigger>
                        <Button variant="quiet" size="icon" aria-label="إجراءات الحوالة"><MoreHorizontal /></Button>
                        <Popover placement="bottom end" className="min-w-52 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                          <Menu className="outline-none" onAction={(key) => onTxnMenu(t, String(key))}>
                            <MenuItem id="detail" className={menuItem}>عرض التفاصيل</MenuItem>
                            {!t.payout && <MenuItem id="prepare" className={menuItem}>تجهيز دفعة لهذه الحوالة</MenuItem>}
                            <MenuItem id="match" className={menuItem}>{t.matched ? 'إزالة المطابقة' : 'مطابق'}</MenuItem>
                            {t.allowedActions.filter((a) => a !== 'set_matched').map((a) => (
                              <MenuItem key={a} id={a} className={cx(menuItem, (a === 'unapprove' || a === 'delete') && 'text-neg')}>{actionLabel[a]}</MenuItem>
                            ))}
                          </Menu>
                        </Popover>
                      </MenuTrigger>
                    </td>
                  </tr>
                );
              }

              if (r.kind === 'payout') {
                const p = r.payout;
                const cancelled = p.status === 'cancelled';
                return (
                  <tr key={k} id={`row-${k}`} data-kind="payout" className={cx('t-row', tint, cancelled && 'text-fg-3')}>
                    {sel}
                    {seqCell(<span className="font-medium text-fg">دفعة {p.seq}</span>)}
                    {dateCell}
                    <td>
                      <Trunc className={cx(cancelled && 'line-through')}>دفعة {payoutMethod[p.details.method]}{p.details.platform ? ` — ${p.details.platform}` : ''}</Trunc>
                      <div className="num text-[12px] text-fg-3">{p.rangeLabel} · {transferCountLabel(p.txnCount)}</div>
                    </td>
                    <td /><td /><td /><td /><td />
                    <td className="text-end"><Amount fit={fit.debit} minor={p.amountMinor} currency={currency} showCurrency={false}
                      className={cx('font-medium', cancelled ? 'text-fg-3 line-through' : p.status === 'draft' ? 'text-fg-3' : 'text-fg')} /></td>
                    {balance}
                    <td><Badge tone={payoutTone[p.status]}>{payoutStatus[p.status]}</Badge></td>
                    <td><Trunc className="text-[13px] text-fg-2">{[payoutMethod[p.details.method], p.details.platform, p.details.network].filter(Boolean).join(' · ')}</Trunc></td>
                    <td className="text-[13px] text-fg-3">{p.details.reference && <div dir="ltr" className="num truncate text-right" title={p.details.reference}>{p.details.reference}</div>}</td>
                    <td className="text-fg-3">—</td>
                    <td><Trunc className="text-[13px] text-fg-2">{p.details.note ?? ''}</Trunc></td>
                    <td>{p.inCustomerExcel && <span title="في ملف العميل" aria-label="في ملف العميل" className="inline-flex text-pos"><Check className="size-4" strokeWidth={2} /></span>}</td>
                    <td className="sticky z-[1] pe-2" data-sticky="end" style={{ insetInlineEnd: 0 }}>
                      <MenuTrigger>
                        <Button variant="quiet" size="icon" aria-label="إجراءات الدفعة"><MoreHorizontal /></Button>
                        <Popover placement="bottom end" className="min-w-52 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                          <Menu className="outline-none" onAction={(key) => setDialog({ kind: key as 'send' | 'cancel' | 'details' | 'items', payout: p })}>
                            <MenuItem id="items" className={menuItem}>الحوالات المشمولة</MenuItem>
                            {p.status === 'draft' && <MenuItem id="send" className={menuItem}>تأكيد الإرسال</MenuItem>}
                            {!cancelled && <MenuItem id="details" className={menuItem}>تعديل التفاصيل</MenuItem>}
                            {!cancelled && <MenuItem id="cancel" className={cx(menuItem, 'text-neg')}>إلغاء الدفعة</MenuItem>}
                          </Menu>
                        </Popover>
                      </MenuTrigger>
                    </td>
                  </tr>
                );
              }

              const e = r.entry;
              const reversed = e.reversedByEntryId !== null;
              return (
                <tr key={k} id={`row-${k}`} data-kind="entry" className={cx('t-row hover:[--row-tint:color-mix(in_oklab,var(--raised)_55%,transparent)]', tint)}>
                  {sel}
                  {seqCell(<span className="text-fg-3">—</span>)}
                  {dateCell}
                  <td>
                    <Trunc className={cx(reversed && 'text-fg-3 line-through decoration-fg-3/60')}>{e.description}</Trunc>
                    {(e.payoutMethod || reversed || e.reversesEntryId !== null) && (
                      <div className="text-[12px] text-fg-3">{e.payoutMethod ? payoutMethod[e.payoutMethod] : ''}{reversed ? ' عُكس بقيد لاحق' : ''}{e.reversesEntryId !== null ? ' يعكس قيداً سابقاً' : ''}</div>
                    )}
                  </td>
                  <td /><td /><td /><td />
                  <td className="text-end">{e.amountMinor > 0 && <Amount fit={fit.credit} minor={e.amountMinor} currency={currency} showCurrency={false} className={reversed ? 'text-fg-3 line-through' : 'text-pos'} />}</td>
                  <td className="text-end">{e.amountMinor < 0 && <Amount fit={fit.debit} minor={-e.amountMinor} currency={currency} showCurrency={false} className={reversed ? 'text-fg-3 line-through' : ''} />}</td>
                  {balance}
                  <td className="text-fg-3">—</td>
                  <td><Trunc className="text-[13px] text-fg-2">{e.payoutMethod ? payoutMethod[e.payoutMethod] : ''}</Trunc></td>
                  <td className="text-[13px] text-fg-3">{e.reference && <div dir="ltr" className="truncate text-right" title={e.reference}>{e.reference}</div>}</td>
                  <td className="text-fg-3">—</td>
                  <td />
                  <td>{e.inCustomerExcel && <span title="في ملف العميل" aria-label="في ملف العميل" className="inline-flex text-pos"><Check className="size-4" strokeWidth={2} /></span>}</td>
                  <td className="sticky z-[1] pe-2" data-sticky="end" style={{ insetInlineEnd: 0 }}>
                    <MenuTrigger>
                      <Button variant="quiet" size="icon" aria-label="إجراءات القيد"><MoreHorizontal /></Button>
                      <Popover placement="bottom end" className="w-60 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                        <Menu className="outline-none" disabledKeys={['no-delete']} onAction={(key) => setDialog({ kind: key === 'delete' ? 'delete-entry' : 'reverse', entry: e })}>
                          {!reversed && e.reversesEntryId === null && <MenuItem id="reverse" className={menuItem}>عكس القيد</MenuItem>}
                          {e.deletable
                            ? <MenuItem id="delete" className={cx(menuItem, 'text-neg')}>حذف القيد</MenuItem>
                            : <MenuItem id="no-delete" textValue="لا يمكن حذفه" className="flex cursor-default flex-col rounded-[6px] px-2.5 py-1.5 text-[12.5px] leading-snug text-fg-3 outline-none">
                                <span className="text-fg-2">لا يمكن حذفه</span>{e.notDeletableReasonAr}
                              </MenuItem>}
                        </Menu>
                      </Popover>
                    </MenuTrigger>
                  </td>
                </tr>
              );
            })}
            {st.data && rows.length === 0 && (
              <tr><td colSpan={18} className="py-10 text-center text-fg-3">{show === 'unpaid' ? 'لا حوالات غير مدفوعة' : show === 'payouts' ? 'لا دفعات بعد' : 'لا أسطر في هذه الفترة'}</td></tr>
            )}
          </tbody>
        </table>
        {st.data && (
          <TotalsTable label="الرصيد الختامي" minWidth={W.min} widths={widths}>
            <tr>
              <TotalsCell sticky="start" colSpan={3} className="!ps-4 text-fg-2">الرصيد الختامي <span className="text-fg-3">{currency}</span></TotalsCell>
              <TotalsCell colSpan={7} />
              <TotalsCell align="end" className="text-sm font-medium"><Amount fit={fit.balance} minor={st.data.closingBalanceMinor} currency={currency} showCurrency={false} className={st.data.closingBalanceMinor < 0 ? 'text-neg' : 'text-accent-ink'} /></TotalsCell>
              <TotalsCell colSpan={6} />
              <TotalsCell sticky="end" />
            </tr>
          </TotalsTable>
        )}
      </TableFrame>

      {detail !== null && <DetailPanel id={detail} onClose={() => openDetail(null)} />}
      {dialog?.kind === 'reverse' && <ReverseDialog entry={dialog.entry} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete-entry' && <DeleteEntryDialog entry={dialog.entry} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'send' && <MarkSentDialog payout={dialog.payout} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'cancel' && <CancelPayoutDialog payout={dialog.payout} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'details' && <PayoutDetailsDialog payout={dialog.payout} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'items' && <PayoutItemsDialog payout={dialog.payout} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'statement' && <AddToStatementDialog customer={customer} items={dialog.items} onClose={() => setDialog(null)} onDone={() => setPicked(new Set())} />}
    </div>
  );
}
