import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { MenuTrigger, Menu, MenuItem, Popover, Tooltip, TooltipTrigger, Button as RacButton } from 'react-aria-components';
import { Check, ChevronDown, ChevronUp, Download, FileSpreadsheet, MoreHorizontal, Printer, X } from 'lucide-react';
import { api, native } from '@/lib/api';
import type { Customer, CustomerExcelItemRef, ExcelStatus, LedgerEntry, Payout, PayoutSelection, Period, StatementFilter, StatementRow, Transaction, TxnAction } from '@/lib/contract';
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
import { HeadLabel, SELECT_W, TableFrame, TotalsCell, TotalsTable, sumWidths } from '@/components/ui/Table';
import { Trunc } from '@/components/ui/Trunc';
import { DateTime } from '@/components/ui/DateTime';
import { toast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { DetailPanel } from '@/components/transactions/DetailPanel';
import { InToolbar } from '@/components/layout/ToolbarSlot';
import { actionLabel, useTxnActions } from '@/components/transactions/TxnActions';
import { AddRangeDialog, AddToStatementDialog, excelWhy, sendUnexported } from './CustomerExcel';
import { DeleteEntryDialog, ReverseDialog } from './EntryDialogs';
import { CancelPayoutDialog, MarkSentDialog, PayoutDetailsDialog, PayoutItemsDialog } from './PayoutDialogs';

/*
 * SPEC 6.5: one statement per currency. Transfers (له), payouts (عليه), adjustments and reversals in
 * one table with a running balance, under the eight figures of SPEC 4.8. Every number comes from the core.
 */

type Show = NonNullable<StatementFilter['show']>;
const SHOWS: { id: Show; label: string }[] = [
  { id: 'all', label: 'الكل' }, { id: 'unpaid', label: 'غير المدفوع' }, { id: 'paid', label: 'المدفوع' }, { id: 'payouts', label: 'الدفعات فقط' },
  { id: 'not_exported', label: 'غير المُصدَّر إلى Excel' },
];

/** Typing in a field or working in a dialog: the page's single-key shortcuts stay quiet. */
const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  if (t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'radio') return true;
  return !!t?.closest('textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]');
};

const keyOf = (r: StatementRow) => (r.kind === 'txn' ? `t:${r.txn.id}` : r.kind === 'payout' ? `p:${r.payout.id}` : `e:${r.entry.id}`);
const dateOf = (r: StatementRow) => (r.kind === 'txn' ? formatDateTime(r.txn.occurredAt).slice(0, 10) : r.kind === 'payout' ? r.payout.date : r.entry.entryDate);

function Fig({ label, children, tone }: { label: string; children: ReactNode; tone?: 'accent' | 'neg' }) {
  return (
    <div className="min-w-0 flex-auto px-2 py-1">
      <div className="truncate text-[11.5px] leading-4 text-fg-3" title={label}>{label}</div>
      <div className={cx('truncate text-[13px] font-medium leading-5', tone === 'accent' ? 'text-accent-ink' : tone === 'neg' ? 'text-neg' : 'text-fg')}>{children}</div>
    </div>
  );
}

const STRIP_KEY = 'ppfeez.summaryCollapsed';
const readCollapsed = () => { try { return localStorage.getItem(STRIP_KEY) === '1'; } catch { return false; } };

/**
 * The eight figures (SPEC 4.8), as the owner's own workbook shows them, in one thin strip above the table
 * (SPEC 6.5). It folds to "المتبقي · غير مدفوع"; the choice is remembered.
 */
export function SummaryBar({ customerId, currency }: { customerId: number; currency: string }) {
  const s = useQuery({ queryKey: ['customer_summary', customerId, currency], queryFn: () => api.customerSummary(customerId, currency) }).data;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem(STRIP_KEY, collapsed ? '0' : '1'); } catch { /* the choice just isn't kept */ }
  };
  const money = (m: number | undefined) => (m === undefined ? '—' : <Amount minor={m} currency={currency} showCurrency={false} />);
  const owes = !!s && s.remainingMinor < 0;
  const remaining = <>{money(s?.remainingMinor)}{owes && <span className="ms-1.5 text-[12px]">عليه</span>}</>;
  return (
    <section aria-label={`ملخص ${currency}`} data-collapsed={collapsed || undefined} className="mb-2 flex shrink-0 overflow-hidden rounded-card border border-line bg-surface">
      {collapsed ? (
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <span className="text-fg-3">المتبقي</span>
          <span className={cx('font-medium', owes ? 'text-neg' : 'text-accent-ink')}>{remaining}</span>
          <span className="text-fg-3">·</span>
          <span className="text-fg-3">غير مدفوع</span>
          <span className="font-medium text-fg">{s ? transferCountLabel(s.notPaidCount) : '—'}</span>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 divide-x divide-x-reverse divide-line">
          <Fig label="الصافي المكتمل">{money(s?.netCompletedMinor)}</Fig>
          <Fig label="المُرسل">{money(s?.sentMinor)}</Fig>
          <Fig label="المتبقي" tone={owes ? 'neg' : 'accent'}>{remaining}</Fig>
          <Fig label="غير مدفوع">{s ? transferCountLabel(s.notPaidCount) : '—'}</Fig>
          <Fig label="المبلغ قبل العمولة">{money(s?.grossBeforeCommissionMinor)}</Fig>
          <Fig label="إجمالي العمولة">{money(s?.commissionMinor)}</Fig>
          <Fig label="عدد المعاملات"><span className="num">{s?.txnCount ?? '—'}</span></Fig>
          <Fig label="عدد المدفوع"><span className="num">{s?.paidCount ?? '—'}</span></Fig>
        </div>
      )}
      <button type="button" onClick={toggle} aria-expanded={!collapsed} aria-label={collapsed ? 'إظهار الأرقام الثمانية' : 'طيّ الأرقام'} title={collapsed ? 'إظهار الأرقام الثمانية' : 'طيّ الأرقام'}
        className="grid w-8 shrink-0 place-items-center border-s border-line text-fg-3 outline-none hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
        {collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </button>
    </section>
  );
}

/** ✓ صُدّرت / ⏳ بانتظار التصدير / — لم تُصدَّر (SPEC 6.8.3): an icon and words, never the colour alone. */
/** The files a row went to, fetched when its tooltip opens and kept for the session (SPEC 6.8.4). */
function ItemFiles({ customerId, item }: { customerId: number; item: CustomerExcelItemRef }) {
  const q = useQuery({
    queryKey: ['customer_excel_item_files', customerId, item.kind, item.id],
    queryFn: () => api.customerExcelItemFiles(customerId, item),
    staleTime: Infinity,
  });
  if (!q.data) return <span className="text-fg-3">…</span>;
  if (!q.data.length) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {q.data.map((f) => (
        <li key={f.fileId} className="num text-[12px] text-fg-2">
          {f.label || f.path.split(/[\\/]/).pop()!.replace(/\.xlsx$/i, '')} · <DateTime iso={f.exportedAt} />
        </li>
      ))}
    </ul>
  );
}

/** ✓ صُدّرت / ⏳ بانتظار التصدير / — لم تُصدَّر (SPEC 6.8.3): an icon and words, never the colour alone. */
function ExcelCell({ status, excel, customerId, item }: { status: ExcelStatus; excel: Customer['excel']; customerId: number; item: CustomerExcelItemRef }) {
  if (!excel) return <td />;
  const v = {
    exported: { icon: '✓', text: 'صُدّرت', cls: 'text-pos', title: excel.filesCount > 1 ? 'صُدّرت إلى الملف الحالي' : 'في ملف العميل' },
    pending: { icon: '⏳', text: 'بانتظار', cls: 'text-warn', title: `بانتظار التصدير${excel.lastError ? `: ${excelWhy(excel.lastError)}` : ''}` },
    not_exported: { icon: '—', text: 'لم تُصدَّر', cls: 'text-fg-3', title: excel.filesCount > 1 ? 'ليست في الملف الحالي' : 'ليست في ملف العميل. حدّدها ثم «إضافة إلى ملف العميل» أو اضغط E' },
  }[status];
  return (
    <td data-excel={status}>
      <TooltipTrigger delay={300}>
        <RacButton aria-label={`${v.text}: ${v.title}`} className={cx('inline-flex items-center gap-1 rounded-[4px] text-[12.5px] outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus', v.cls)}>
          <span aria-hidden>{v.icon}</span>{v.text}
        </RacButton>
        <Tooltip placement="top" className="max-w-72 rounded-card border border-line bg-surface px-3 py-2 text-[12.5px] text-fg shadow-(--shadow-float)">
          <div>{v.title}</div>
          {excel.filesCount > 1 && <><div className="mt-1 text-fg-3">الملفات التي صُدّرت إليها:</div><ItemFiles customerId={customerId} item={item} /></>}
        </Tooltip>
      </TooltipTrigger>
    </td>
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
    | { kind: 'range' }
    | null>(null);
  const anchor = useRef<string | null>(null);
  const shift = useRef(false);
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
      select: SELECT_W, seq: '60px', date: '92px',
      gross: amountWidth(fit.gross, false, 156), fee: amountWidth(fit.fee, false, 100), net: amountWidth(fit.net, false, 128),
      commission: amountWidth(fit.commission, false, 76), credit: amountWidth(fit.credit, false, 64), debit: amountWidth(fit.debit, false, 64),
      balance: amountWidth(fit.balance, false, 80), sent: '124px', method: '148px', ref: '128px', matched: '76px', notes: '140px', excel: '100px', menu: '48px',
    };
    return { ...w, min: sumWidths([...Object.values(w), '150px']) };
  }, [fit]);
  // له / عليه / الرصيد / تم الإرسال come first after the description, so they fit at 1100 without scrolling
  const widths = [W.select, W.seq, W.date, undefined, W.credit, W.debit, W.balance, W.sent, W.gross, W.fee, W.net, W.commission, W.method, W.ref, W.matched, W.notes, W.excel, W.menu];

  const pickedRows = rows.filter((r) => picked.has(keyOf(r)));
  const pickedTxns = pickedRows.flatMap((r) => (r.kind === 'txn' ? [r.txn] : []));
  /** a click picks one row; Shift+click picks the rows between it and the last one clicked */
  const toggle = (k: string, on: boolean) => {
    const keys = rows.map(keyOf);
    const from = anchor.current ? keys.indexOf(anchor.current) : -1;
    const to = keys.indexOf(k);
    const span = shift.current && from >= 0 && to >= 0 ? keys.slice(Math.min(from, to), Math.max(from, to) + 1) : [k];
    shift.current = false;
    anchor.current = k;
    setPicked((prev) => { const n = new Set(prev); for (const x of span) { if (on) n.add(x); else n.delete(x); } return n; });
  };
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

  // E: the picked rows (or the row in focus) to the customer's file; Shift+E: everything not exported (SPEC 6.8.3)
  const qc = useQueryClient();
  const keys = useRef({ pickedRows, rows });
  keys.current = { pickedRows, rows };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyE' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || typing(e) || document.querySelector('[role=dialog]')) return;
      e.preventDefault();
      if (!customer.excel) { toast.error('لا ملف Excel لهذا العميل', 'أنشئ ملفاً أو اربطه من شارة Excel أعلى الصفحة.'); return; }
      if (e.shiftKey) { void sendUnexported(customer.id, qc, customer.name); return; }
      const { pickedRows: chosen, rows: all } = keys.current;
      const focused = (document.activeElement as HTMLElement | null)?.closest('tr[id^="row-"]')?.id.slice(4);
      const rs = chosen.length ? chosen : all.filter((r) => keyOf(r) === focused);
      if (rs.length) setDialog({ kind: 'statement', items: excelItems(rs) });
      else toast.error('حدّد صفاً أولاً', 'E يضيف الصفوف المحددة إلى ملف العميل، وShift+E يرسل كل غير المُصدَّر.');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [customer.excel, customer.id, customer.name, qc]);
  const toExcel = (item: CustomerExcelItemRef) => setDialog({ kind: 'statement', items: [item] });

  const menuItem = 'flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised data-[disabled]:text-fg-3';
  const onTxnMenu = (t: Transaction, k: string) => {
    if (k === 'detail') openDetail(t.id);
    else if (k === 'prepare') onPrepare({ kind: 'ids', txnIds: [t.id] });
    else if (k === 'excel') toExcel({ kind: 'txn', id: t.id });
    else if (k === 'match') void run(() => api.txnSetMatched([t.id], !t.matched), t.matched ? 'أُزيلت المطابقة' : 'وُضعت علامة مطابق');
    else actions.act(k as TxnAction, t);
  };

  const shows = SHOWS.filter((o) => o.id !== 'not_exported' || customer.excel);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <InToolbar>
        <Select label="عرض" value={show} onChange={(k) => setShow(k as Show)} className="w-[188px]" options={shows} />
        <Select label="الفترة" value={preset} onChange={(k) => setPreset(k as PeriodPreset)} className="w-[132px]"
          options={(Object.keys(periodLabels) as PeriodPreset[]).map((k) => ({ id: k, label: periodLabels[k] }))} />
        {preset === 'custom' && <DateRangePicker label="الفترة المخصّصة" value={custom} onChange={setCustom} className="w-[250px]" />}
        <MenuTrigger>
          <Button variant="secondary" size="sm" className="ms-auto"><Download />تصدير وطباعة</Button>
          <Popover placement="bottom end" className="min-w-56 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
            <Menu className="outline-none" onAction={(k) => {
              if (k === 'xlsx') void exportExcel();
              if (k === 'csv') void exportCsv();
              if (k === 'print') print();
              if (k === 'range') setDialog({ kind: 'range' });
              if (k === 'unexported') void sendUnexported(customer.id, qc, customer.name);
            }}>
              <MenuItem id="xlsx" className={cx(menuItem, 'gap-2')}><FileSpreadsheet className="size-4 text-fg-3" />تصدير Excel…</MenuItem>
              <MenuItem id="csv" className={cx(menuItem, 'gap-2')}><Download className="size-4 text-fg-3" />تصدير CSV…</MenuItem>
              <MenuItem id="print" className={cx(menuItem, 'gap-2')}><Printer className="size-4 text-fg-3" />طباعة كشف</MenuItem>
              {customer.excel && <MenuItem id="range" className={cx(menuItem, 'gap-2')}><FileSpreadsheet className="size-4 text-fg-3" />إضافة نطاق إلى ملف العميل…</MenuItem>}
              {customer.excel && <MenuItem id="unexported" className={cx(menuItem, 'justify-between gap-4')}>إرسال غير المُصدَّر<kbd className="num text-[12px] text-fg-3">Shift+E</kbd></MenuItem>}
            </Menu>
          </Popover>
        </MenuTrigger>
      </InToolbar>

      {pickedRows.length > 0 ? (
        <div className="mb-2 flex h-[46px] shrink-0 items-center gap-1 rounded-card bg-accent-soft pe-2 ps-4 text-sm" role="toolbar" aria-label="إجراءات على المحدد">
          <span className="me-3 text-fg">محدّد <span className="num">{pickedRows.length}</span></span>
          {pickedTxns.length > 0 && pickedTxns.every((t) => !t.payout) && (
            <Button size="sm" variant="quiet" onPress={() => onPrepare({ kind: 'ids', txnIds: pickedTxns.map((t) => t.id) })}>تجهيز دفعة من المحدد</Button>
          )}
          {pickedTxns.length > 0 && <>
            <Button size="sm" variant="quiet" onPress={() => void run(() => api.txnSetMatched(pickedTxns.map((t) => t.id), true), 'وُضعت علامة مطابق')}>مطابق</Button>
            <Button size="sm" variant="quiet" onPress={() => void run(() => api.txnSetMatched(pickedTxns.map((t) => t.id), false), 'أُزيلت المطابقة')}>إزالة المطابقة</Button>
          </>}
          <Button size="sm" variant="quiet" onPress={() => setDialog({ kind: 'statement', items: excelItems(pickedRows) })}><FileSpreadsheet />إضافة إلى ملف العميل<kbd className="text-[12px] text-fg-3">E</kbd></Button>
          {pickedTxns.length === 1 && pickedRows.length === 1 && (
            <Button size="sm" variant="quiet" onPress={() => actions.act('unapprove', pickedTxns[0])}>إلغاء الاعتماد</Button>
          )}
          {pickedTxns.length > 0 && pickedTxns.length === pickedRows.length && (
            <Button size="sm" variant="quiet" className="text-neg" onPress={() => actions.open({ kind: 'delete', rows: pickedTxns })}>حذف</Button>
          )}
          <Button size="icon" variant="quiet" aria-label="إلغاء التحديد" className="ms-auto" onPress={() => setPicked(new Set())}><X /></Button>
        </div>
      ) : (
        <SummaryBar customerId={customer.id} currency={currency} />
      )}

      <TableFrame fill>
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
              <th className="text-end"><HeadLabel>له</HeadLabel></th>
              <th className="text-end"><HeadLabel>عليه</HeadLabel></th>
              <th className="text-end"><HeadLabel>الرصيد</HeadLabel></th>
              <th className="text-start"><HeadLabel>تم الإرسال؟</HeadLabel></th>
              <th className="text-end"><HeadLabel>المبلغ الكامل من PayPal</HeadLabel></th>
              <th className="text-end"><HeadLabel>خصم PayPal</HeadLabel></th>
              <th className="text-end"><HeadLabel>الصافي من PayPal</HeadLabel></th>
              <th className="text-end"><HeadLabel>العمولة</HeadLabel></th>
              <th className="text-start"><HeadLabel>طريقة الدفع</HeadLabel></th>
              <th className="text-start"><HeadLabel>المرجع</HeadLabel></th>
              <th className="text-start"><HeadLabel>المطابقة</HeadLabel></th>
              <th className="text-start"><HeadLabel>ملاحظات</HeadLabel></th>
              <th className="text-start"><HeadLabel>Excel</HeadLabel></th>
              <th className="sticky z-[2]" data-sticky="end" style={{ insetInlineEnd: 0 }}><span className="sr-only">إجراءات</span></th>
            </tr>
          </thead>
          <tbody className="[&>tr>td]:h-(--row-h) [&>tr>td]:border-b [&>tr>td]:border-line [&>tr>td]:px-2.5 [&>tr>td]:leading-tight [&>tr>td]:whitespace-nowrap [&>tr:last-child>td]:border-b-0">
            {st.data && period.from && (
              <tr className="t-row [--row-tint:color-mix(in_oklab,var(--raised)_40%,transparent)] text-fg-2">
                <td colSpan={6}>رصيد سابق حتى <bdi dir="ltr" className="num">{period.from}</bdi></td>
                <td className="text-end"><Amount fit={fit.balance} minor={st.data.openingBalanceMinor} currency={currency} showCurrency={false} tone="signed" /></td>
                <td colSpan={11} />
              </tr>
            )}
            {rows.map((r) => {
              const k = keyOf(r);
              const tint = flash === k ? '[--row-tint:var(--accent-soft)]'
                : r.kind === 'payout' ? '[--row-tint:color-mix(in_oklab,var(--accent)_7%,transparent)]'
                  : r.kind === 'txn' && detail === r.txn.id ? '[--row-tint:var(--raised)]' : '';
              const sel = (
                <td className="sticky z-[1] !ps-4" data-sticky="start-inner" style={{ insetInlineStart: 0 }} onClickCapture={(ev) => { shift.current = ev.shiftKey; }}>
                  <Checkbox aria-label="تحديد السطر" isSelected={picked.has(k)} onChange={(on) => toggle(k, on)} />
                </td>
              );
              const seqCell = (text: ReactNode) => <td className="num sticky z-[1] text-fg-2" data-sticky="start-inner" style={{ insetInlineStart: SELECT_W }}>{text}</td>;
              const dateCell = <td className="num sticky z-[1] text-fg-2" data-sticky="start" style={{ insetInlineStart: `calc(${SELECT_W} + ${W.seq})` }}><bdi dir="ltr">{dateOf(r)}</bdi></td>;
              const balance = <td className="text-end font-medium"><Amount fit={fit.balance} minor={r.runningBalanceMinor} currency={currency} showCurrency={false} className={r.runningBalanceMinor < 0 ? 'text-neg' : ''} /></td>;

              if (r.kind === 'txn') {
                const t = r.txn;
                return (
                  <tr key={k} id={`row-${k}`} data-kind="txn" data-opens-detail=""
                    onClick={(ev) => { if (!(ev.target as Element).closest('button, input, a, label, [role=checkbox]')) openDetail(t.id); }}
                    className={cx('t-row hover:[--row-tint:color-mix(in_oklab,var(--raised)_55%,transparent)]', tint)}>
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
                    <td className="text-end"><Amount fit={fit.credit} minor={t.customerAmountMinor} currency={currency} showCurrency={false} className="font-medium text-pos" /></td>
                    <td />
                    {balance}
                    <td><SentCell t={t} onPayout={toPayout} /></td>
                    <td className="text-end"><Amount fit={fit.gross} minor={t.grossMinor} currency={currency} showCurrency={false} className="text-fg-2" /></td>
                    <td className="text-end"><Amount fit={fit.fee} minor={t.feeMinor} currency={currency} showCurrency={false} className="text-fg-2" /></td>
                    <td className="text-end"><Amount fit={fit.net} minor={t.netMinor} currency={currency} showCurrency={false} className="text-fg-2" /></td>
                    <td className="text-end">
                      <Amount fit={fit.commission} minor={t.commissionMinor} currency={currency} showCurrency={false} className="text-fg-2" />
                      <div className="num text-[12px] text-fg-3">{t.commissionMode === 'percent' && t.commissionBps !== null ? <bdi dir="ltr">{formatBps(t.commissionBps)}</bdi> : t.commissionMode === 'fixed' ? 'ثابتة' : ''}</div>
                    </td>
                    <td className="text-fg-3">—</td>
                    <td className="text-[13px] text-fg-3"><div dir="ltr" className="num truncate text-right" title={t.paypalTxnId}>{t.paypalTxnId}</div></td>
                    <td>{t.matched ? <span className="inline-flex items-center gap-1 text-[13px] text-pos"><Check className="size-3.5" strokeWidth={2.2} />مطابق</span> : <span className="text-fg-3">—</span>}</td>
                    <td><Trunc className="text-[13px] text-fg-2">{t.note ?? ''}</Trunc></td>
                    <ExcelCell status={t.excelStatus} excel={customer.excel} customerId={customer.id} item={{ kind: 'txn', id: t.id }} />
                    <td className="sticky z-[1] pe-2" data-sticky="end" style={{ insetInlineEnd: 0 }}>
                      <MenuTrigger>
                        <Button variant="quiet" size="icon" aria-label="إجراءات الحوالة"><MoreHorizontal /></Button>
                        <Popover placement="bottom end" className="min-w-52 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                          <Menu className="outline-none" onAction={(key) => onTxnMenu(t, String(key))}>
                            <MenuItem id="detail" className={menuItem}>عرض التفاصيل</MenuItem>
                            {!t.payout && <MenuItem id="prepare" className={menuItem}>تجهيز دفعة لهذه الحوالة</MenuItem>}
                            {customer.excel && t.excelStatus !== 'exported' && <MenuItem id="excel" className={cx(menuItem, 'justify-between gap-4')}>إضافة إلى ملف العميل<kbd className="text-[12px] text-fg-3">E</kbd></MenuItem>}
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
                    <td />
                    <td className="text-end"><Amount fit={fit.debit} minor={p.amountMinor} currency={currency} showCurrency={false}
                      className={cx('font-medium', cancelled ? 'text-fg-3 line-through' : p.status === 'draft' ? 'text-fg-3' : 'text-fg')} /></td>
                    {balance}
                    <td><Badge tone={payoutTone[p.status]}>{payoutStatus[p.status]}</Badge></td>
                    <td /><td /><td /><td />
                    <td><Trunc className="text-[13px] text-fg-2">{[payoutMethod[p.details.method], p.details.platform, p.details.network].filter(Boolean).join(' · ')}</Trunc></td>
                    <td className="text-[13px] text-fg-3">{p.details.reference && <div dir="ltr" className="num truncate text-right" title={p.details.reference}>{p.details.reference}</div>}</td>
                    <td className="text-fg-3">—</td>
                    <td><Trunc className="text-[13px] text-fg-2">{p.details.note ?? ''}</Trunc></td>
                    {p.status === 'sent' ? <ExcelCell status={p.excelStatus} excel={customer.excel} customerId={customer.id} item={{ kind: 'payout', id: p.id }} /> : <td />}
                    <td className="sticky z-[1] pe-2" data-sticky="end" style={{ insetInlineEnd: 0 }}>
                      <MenuTrigger>
                        <Button variant="quiet" size="icon" aria-label="إجراءات الدفعة"><MoreHorizontal /></Button>
                        <Popover placement="bottom end" className="min-w-52 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                          <Menu className="outline-none" onAction={(key) => (key === 'excel' ? toExcel({ kind: 'payout', id: p.id }) : setDialog({ kind: key as 'send' | 'cancel' | 'details' | 'items', payout: p }))}>
                            <MenuItem id="items" className={menuItem}>الحوالات المشمولة</MenuItem>
                            {customer.excel && p.status === 'sent' && p.excelStatus !== 'exported' && <MenuItem id="excel" className={cx(menuItem, 'justify-between gap-4')}>إضافة إلى ملف العميل<kbd className="text-[12px] text-fg-3">E</kbd></MenuItem>}
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
                  <td className="text-end">{e.amountMinor > 0 && <Amount fit={fit.credit} minor={e.amountMinor} currency={currency} showCurrency={false} className={reversed ? 'text-fg-3 line-through' : 'text-pos'} />}</td>
                  <td className="text-end">{e.amountMinor < 0 && <Amount fit={fit.debit} minor={-e.amountMinor} currency={currency} showCurrency={false} className={reversed ? 'text-fg-3 line-through' : ''} />}</td>
                  {balance}
                  <td className="text-fg-3">—</td>
                  <td /><td /><td /><td />
                  <td><Trunc className="text-[13px] text-fg-2">{e.payoutMethod ? payoutMethod[e.payoutMethod] : ''}</Trunc></td>
                  <td className="text-[13px] text-fg-3">{e.reference && <div dir="ltr" className="truncate text-right" title={e.reference}>{e.reference}</div>}</td>
                  <td className="text-fg-3">—</td>
                  <td />
                  <ExcelCell status={e.excelStatus} excel={customer.excel} customerId={customer.id} item={{ kind: 'ledger', id: e.id }} />
                  <td className="sticky z-[1] pe-2" data-sticky="end" style={{ insetInlineEnd: 0 }}>
                    <MenuTrigger>
                      <Button variant="quiet" size="icon" aria-label="إجراءات القيد"><MoreHorizontal /></Button>
                      <Popover placement="bottom end" className="w-60 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                        <Menu className="outline-none" disabledKeys={['no-delete']} onAction={(key) => (key === 'excel' ? toExcel({ kind: 'ledger', id: e.id }) : setDialog({ kind: key === 'delete' ? 'delete-entry' : 'reverse', entry: e }))}>
                          {customer.excel && e.excelStatus !== 'exported' && <MenuItem id="excel" className={cx(menuItem, 'justify-between gap-4')}>إضافة إلى ملف العميل<kbd className="text-[12px] text-fg-3">E</kbd></MenuItem>}
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
              <TotalsCell colSpan={3} />
              <TotalsCell align="end" className="text-sm font-medium"><Amount fit={fit.balance} minor={st.data.closingBalanceMinor} currency={currency} showCurrency={false} className={st.data.closingBalanceMinor < 0 ? 'text-neg' : 'text-accent-ink'} /></TotalsCell>
              <TotalsCell colSpan={10} />
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
      {dialog?.kind === 'range' && <AddRangeDialog customer={customer} currency={currency} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'statement' && <AddToStatementDialog customer={customer} items={dialog.items} onClose={() => setDialog(null)} onDone={() => setPicked(new Set())} />}
    </div>
  );
}
