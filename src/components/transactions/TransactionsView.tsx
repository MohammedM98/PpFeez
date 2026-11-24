import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { Tabs, TabList, Tab, MenuTrigger, Menu, MenuItem, Popover, type SortDescriptor, type Selection, type Key } from 'react-aria-components';
import { Check, CornerDownLeft, FileCheck2, FileSpreadsheet, MoreHorizontal, X } from 'lucide-react';
import { api, native } from '@/lib/api';
import { useAction } from '@/lib/useAction';
import { toast } from '@/components/ui/Toast';
import type { CustomerExcelItemRef, Period, Transaction, TxnAction, TxnFilter, TxnSortKey, TxnStatus } from '@/lib/contract';
import { AddToStatementDialog } from '@/components/customers/CustomerExcel';
import { txn as s, txnCountLabel, txnStatus } from '@/lib/strings';
import { formatBps } from '@/lib/money';
import { periodLabels, presetPeriod, type PeriodPreset } from '@/lib/period';
import { Amount, amountFit, amountWidth } from '@/components/ui/Amount';
import { Button } from '@/components/ui/Button';
import { Checkbox, Select } from '@/components/ui/Field';
import { DateRangePicker } from '@/components/ui/DateFields';
import { Table, TableFrame, TableHeader, Column, TableBody, Row, Cell, SELECT_W, TotalsCell, TotalsTable, sumWidths } from '@/components/ui/Table';
import { cx } from '@/components/ui/cx';
import { Trunc } from '@/components/ui/Trunc';
import { DateCell, FeeCell, PayerCell } from './bits';
import { useRowWindow } from '@/components/ui/useRowWindow';
import { quietKey } from '@/lib/keys';
import { InlineCommission, InlineFee, type InlineField } from './InlineEdit';
import { useScreenMemory, type SavedView, type ScreenState } from '@/lib/uiPrefs';
import { ViewsMenu } from '@/components/ui/Views';
import { ColumnResizer, ColumnsMenu, useColumns, type ColDef } from '@/components/ui/Columns';
import { DetailPanel } from './DetailPanel';
import { actionLabel, useTxnActions } from './TxnActions';

/**
 * SPEC 6.3: the transactions screen is an inbox of what is not assigned yet; the moment a row is
 * assigned it moves to the customer's page (6.5), where it is approved. One view, two scopes.
 */
export type TxnScope = { kind: 'inbox' } | { kind: 'customer'; customerId: number };

const TABS = {
  inbox: ['unassigned', 'excluded'] as TxnStatus[],
  // approved transfers live in the customer's statement (SPEC 6.5); this tab is what awaits approval
  customer: ['pending_approval'] as TxnStatus[],
};
const BATCH = 500; // rows per request (the contract's maximum)
/** the payer column takes the remaining width, never less than this */
const PAYER_MIN = '160px';
const END = new Set(['grossMinor', 'feeMinor', 'netMinor', 'commission', 'customerAmountMinor']);
const SORTABLE = new Set(['payerName', 'grossMinor', 'feeMinor', 'netMinor', 'customerAmountMinor']);

/** Row menu entries: the core's allowedActions, plus "move to another customer" for a pending row. */
type MenuKey = TxnAction | 'move' | 'detail';

export function TransactionsView({ scope, exportSlot }: { scope: TxnScope; exportSlot?: HTMLElement | null }) {
  const inbox = scope.kind === 'inbox';
  const customerId = scope.kind === 'customer' ? scope.customerId : undefined;
  const tabs = inbox ? TABS.inbox : TABS.customer;
  const tabKey = inbox ? 'tab' : 'sub';
  const [params, setParams] = useSearchParams();
  const asTab = (v: string | null) => (v && tabs.includes(v as TxnStatus) ? (v as TxnStatus) : null);
  // the last tab and filters of this list come back (SPEC 6.10); a link's own params win
  const memory = useScreenMemory(inbox ? 'inbox' : `customer_txns:${customerId}`);
  const was = memory.saved ?? {};
  const linked = !!(asTab(params.get(tabKey)) || params.get('needsFee') || params.get('needsReview') || params.get('detail'));
  const from = linked ? {} : was;
  const [tab, setTabState] = useState<TxnStatus>(asTab(params.get(tabKey)) ?? asTab(from.tab ?? null) ?? tabs[0]);
  const tabChosen = useRef(!!asTab(params.get(tabKey)) || !!asTab(from.tab ?? null));
  const [currency, setCurrency] = useState<string>(from.currency ?? 'all');
  const [mailboxId, setMailboxId] = useState<string>(from.mailboxId ?? 'all');
  const [preset, setPreset] = useState<PeriodPreset>((from.preset as PeriodPreset) ?? 'all');
  const [custom, setCustom] = useState<Period>(from.custom ?? {});
  const [needsFeeOnly, setNeedsFeeOnly] = useState(params.get('needsFee') === '1' || !!from.needsFeeOnly);
  const [needsReviewOnly, setNeedsReviewOnly] = useState(params.get('needsReview') === '1' || !!from.needsReviewOnly);
  const [sort, setSort] = useState<SortDescriptor>(from.sort ?? { column: 'occurredAt', direction: 'descending' });
  const [selected, setSelected] = useState<Selection>(new Set());
  const [detailId, setDetailId] = useState<number | null>(params.get('detail') ? Number(params.get('detail')) : null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; field: InlineField } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const actions = useTxnActions();
  const { run } = useAction();
  const customer = useQuery({ queryKey: ['customer', customerId], queryFn: () => api.customerGet(customerId!), enabled: !inbox });
  const [statementItems, setStatementItems] = useState<CustomerExcelItemRef[] | null>(null);

  const setTab = (t: TxnStatus) => {
    tabChosen.current = true;
    setTabState(t);
  };

  // Follow links that change the query while this page stays mounted (dashboard cards, search results).
  const pDetail = params.get('detail'), pTab = asTab(params.get(tabKey)), pNeedsFee = params.get('needsFee'), pNeedsReview = params.get('needsReview');
  useEffect(() => {
    setDetailId(pDetail ? Number(pDetail) : null);
    if (pDetail) setFlashId(Number(pDetail));
  }, [pDetail]);
  useEffect(() => { if (pTab) { tabChosen.current = true; setTabState(pTab); } }, [pTab]);
  useEffect(() => { if (pNeedsFee) setNeedsFeeOnly(pNeedsFee === '1'); }, [pNeedsFee]);
  useEffect(() => { if (pNeedsReview) setNeedsReviewOnly(pNeedsReview === '1'); }, [pNeedsReview]);

  const period = preset === 'custom' ? custom : presetPeriod(preset);
  const filter = useMemo<Omit<TxnFilter, 'status'>>(() => ({
    currency: currency === 'all' ? undefined : currency,
    mailboxId: !inbox || mailboxId === 'all' ? undefined : Number(mailboxId),
    customerId,
    period: period.from || period.to ? period : undefined,
    needsFeeOnly: needsFeeOnly || undefined,
    needsReviewOnly: (inbox && needsReviewOnly) || undefined,
  }), [currency, mailboxId, inbox, customerId, period.from, period.to, needsFeeOnly, needsReviewOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setSelected(new Set()); scrollRef.current?.scrollTo({ top: 0 }); }, [filter, tab, sort]);
  const screenState = (): ScreenState => ({
    tab, currency, mailboxId, preset, custom, needsFeeOnly, needsReviewOnly,
    sort: { column: String(sort.column), direction: sort.direction === 'ascending' ? 'ascending' : 'descending' },
  });
  const { remember } = memory;
  useEffect(() => { remember(screenState()); }, [tab, currency, mailboxId, preset, custom, needsFeeOnly, needsReviewOnly, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const applyView = (v: SavedView) => {
    const st = v.state;
    if (st.tab && asTab(st.tab)) setTab(st.tab as TxnStatus);
    setCurrency(st.currency ?? 'all');
    setMailboxId(st.mailboxId ?? 'all');
    setPreset((st.preset as PeriodPreset) ?? 'all');
    setCustom(st.custom ?? {});
    setNeedsFeeOnly(!!st.needsFeeOnly);
    setNeedsReviewOnly(!!st.needsReviewOnly);
    if (st.sort) setSort(st.sort);
    if (v.columns) cols.replace(v.columns);
  };

  const counts = useQuery({ queryKey: ['txn_counts', filter], queryFn: () => api.txnCounts(filter) });
  // the customer page opens on "awaiting approval" when there is something there, otherwise on "approved"
  useEffect(() => {
    if (inbox || tabChosen.current || !counts.data) return;
    if (counts.data.pending_approval === 0 && counts.data.approved > 0) setTabState('approved');
    tabChosen.current = true;
  }, [inbox, counts.data]);

  const sortInput = { key: sort.column as TxnSortKey, dir: sort.direction === 'ascending' ? 'asc' as const : 'desc' as const };
  // long lists (SPEC 6.10): no pages on screen. The first batch gives the count and totals; the rows in
  // view are drawn and the batch they sit in is fetched from the core when it is needed (and kept).
  const listKey = ['txn_list', filter, tab, sort] as const;
  const fetchPage = (n: number) => api.txnList({ ...filter, status: tab }, sortInput, n, BATCH);
  const list = useQuery({ queryKey: [...listKey, 1], queryFn: () => fetchPage(1), placeholderData: keepPreviousData });
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: api.mailboxList, enabled: inbox });
  const first = list.data;
  const currencies = useMemo(() => [...new Set(['USD', 'EUR', 'TRY', ...(first?.totals.map((t) => t.currency) ?? [])])], [first]);
  const total = first?.total ?? 0;
  const win = useRowWindow(scrollRef, total);
  const pageNos = useMemo(() => {
    const out: number[] = [];
    for (let n = Math.floor(win.start / BATCH) + 1; n <= Math.floor(Math.max(win.end - 1, 0) / BATCH) + 1; n++) if (n > 1) out.push(n);
    return out;
  }, [win.start, win.end]);
  const more = useQueries({ queries: pageNos.map((n) => ({ queryKey: [...listKey, n], queryFn: () => fetchPage(n) })) });
  const batches = new Map<number, Transaction[]>([[1, first?.items ?? []]]);
  more.forEach((q, i) => { if (q.data) batches.set(pageNos[i], q.data.items); });
  const batchKey = [...batches.keys()].join(',') + more.map((q) => q.dataUpdatedAt).join(',') + (list.dataUpdatedAt ?? 0);
  // the rows of the loaded batches, in order (what the window draws and the selection refers to)
  const items = useMemo(() => [...batches.entries()].sort((x, y) => x[0] - y[0]).flatMap(([, rows]) => rows), [batchKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const out: Transaction[] = [];
    for (let i = win.start; i < win.end; i++) {
      const n = Math.floor(i / BATCH) + 1;
      const row = batches.get(n)?.[i - (n - 1) * BATCH];
      if (row) out.push(row);
    }
    return out;
  }, [win.start, win.end, batchKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // rows picked stay known while their batch scrolls away
  const known = useRef(new Map<number, Transaction>());
  const fitMax = useRef<{ key: string; f: Record<'gross' | 'fee' | 'net' | 'commission' | 'toCustomer', number> } | null>(null);
  useEffect(() => { known.current = new Map(); }, [filter, tab, sort]);
  for (const t of items) known.current.set(t.id, t);
  const selectedRows: Transaction[] = selected === 'all' ? items : [...selected].flatMap((k) => known.current.get(Number(k)) ?? []);
  const totals = first?.totals;
  // while the batch in view is on its way, its "loading" line sits where the eye is, not above the view
  const waiting = win.windowed && shown.length === 0 && total > 0;
  const marginTop = waiting ? Math.max(0, win.top - win.head) : win.padTop;
  const padBottom = waiting ? Math.max(0, win.padBottom + win.padTop + (win.end - win.start) * win.rowH - marginTop - win.rowH) : win.padBottom;

  // a row opened from search: bring it into view and mark it for a moment
  useEffect(() => {
    if (flashId === null || !items.some((t) => t.id === flashId)) return;
    const row = document.querySelector(`[role=row][data-key="${flashId}"]`);
    if (row) row.scrollIntoView({ block: 'center' });
    else if (scrollRef.current) scrollRef.current.scrollTop = items.findIndex((t) => t.id === flashId) * win.rowH; // not drawn yet
    const t = setTimeout(() => setFlashId(null), 1800);
    return () => clearTimeout(t);
  }, [flashId, items, win.rowH]);

  // SPEC 6.8.2: approved transfers show whether they are already in the customer's statement
  const showExcel = tab === 'approved';
  const fit = useMemo(() => {
    const col = (row: (t: Transaction) => number | null, tot?: (x: NonNullable<typeof totals>[number]) => number) =>
      amountFit([...items.map((t) => ({ minor: row(t), currency: t.currency })), ...(tot ? (totals ?? []).map((x) => ({ minor: tot(x), currency: x.currency })) : [])]);
    const f = {
      gross: col((t) => t.grossMinor, (x) => x.grossMinor),
      fee: col((t) => t.feeMinor, (x) => x.feeMinor),
      net: col((t) => t.netMinor, (x) => x.netMinor),
      commission: col((t) => t.commissionMinor),
      toCustomer: col((t) => t.customerAmountMinor, (x) => x.customerAmountMinor),
    };
    // batches come and go while scrolling a long list: columns only ever widen, so nothing jumps
    const key = JSON.stringify([filter, tab]);
    const prev = fitMax.current?.key === key ? fitMax.current.f : null;
    if (prev) for (const k of Object.keys(f) as (keyof typeof f)[]) f[k] = Math.max(f[k], prev[k]);
    fitMax.current = { key, f };
    return f;
  }, [items, totals, filter, tab]);
  const W = useMemo(() => {
    const base = {
      date: '96px', note: inbox ? '130px' : '110px', menu: '48px',
      gross: amountWidth(fit.gross, true, 72), fee: amountWidth(fit.fee, false, 100), net: amountWidth(fit.net, false, 64),
    };
    const commission = inbox ? undefined : amountWidth(fit.commission, false, 72);
    const toCustomer = inbox ? undefined : amountWidth(fit.toCustomer, false, 72);
    const excel = showExcel ? '52px' : undefined;
    return { ...base, commission, toCustomer, excel };
  }, [fit, inbox, showExcel]);
  // movable columns (SPEC 6.10); the selection, date and ⋯ columns stay put
  const defs: ColDef[] = useMemo(() => [
    { id: 'payerName', label: s.cols.payer, hideable: false },
    { id: 'payerNote', label: s.cols.payerNote, width: W.note },
    { id: 'grossMinor', label: s.cols.gross, width: W.gross, min: amountWidth(fit.gross, true), hideable: false },
    { id: 'feeMinor', label: s.cols.fee, width: W.fee, min: amountWidth(fit.fee, false) },
    { id: 'netMinor', label: s.cols.net, width: W.net, min: amountWidth(fit.net, false) },
    ...(inbox ? [] : [
      { id: 'commission', label: 'العمولة', width: W.commission, min: amountWidth(fit.commission, false) },
      { id: 'customerAmountMinor', label: s.cols.toCustomer, width: W.toCustomer, min: amountWidth(fit.toCustomer, false), hideable: false },
    ]),
    ...(showExcel ? [{ id: 'excel', label: 'في ملف العميل', width: W.excel }] : []),
  ], [W, fit, inbox, showExcel]);
  const cols = useColumns(inbox ? 'inbox' : 'customer_txns', defs, `calc(${SELECT_W} + ${W.date})`);
  const { columns } = cols;
  const anyPinned = columns.some((c) => c.pinned);
  const widths = [SELECT_W, W.date, ...columns.map((c) => c.w), W.menu];
  const minWidth = sumWidths([...widths, PAYER_MIN]);
  const colKey = columns.map((c) => `${c.id}:${c.w}:${c.pinned}`).join('|');

  const exportExcel = async () => {
    const path = await native.saveXlsx(`PpFeez-معاملات-${new Date().toISOString().slice(0, 10)}.xlsx`);
    if (!path) return;
    const r = await run(() => api.excelExportTransactions({ ...filter, status: tab }, sortInput, path));
    if (r.ok) toast.ok('صُدّرت المعاملات إلى Excel', `${r.value.rows} صف، كل الصفحات بالفلتر الحالي`);
  };

  const openDetail = (id: number | null) => {
    setDetailId(id);
    const p = new URLSearchParams(params);
    if (id === null) p.delete('detail'); else p.set('detail', String(id));
    setParams(p, { replace: true });
  };

  const menuKeys = (t: Transaction): MenuKey[] => {
    const keys: MenuKey[] = [];
    for (const a of t.allowedActions) {
      keys.push(a);
      if (a === 'unassign') keys.push('move');
    }
    return keys;
  };
  const onMenu = (t: Transaction, k: MenuKey) => {
    if (k === 'detail') openDetail(t.id);
    else if (k === 'move') actions.open({ kind: 'move', txn: t });
    else actions.act(k, t);
  };
  const label = (k: MenuKey) => (k === 'move' ? 'نقل لعميل آخر' : k === 'detail' ? 'عرض التفاصيل' : actionLabel[k]);

  const ids = selectedRows.map((t) => t.id);
  // table shortcuts (SPEC 6.10): J / K move like ↓ / ↑, A assigns, F edits the fee; none of them
  // runs a money action without its dialog
  const onTableKey = (e: ReactKeyboardEvent) => {
    if (quietKey(e.nativeEvent)) return;
    const rowEl = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[role=row][data-key]');
    const focused = rowEl ? items.find((t) => String(t.id) === rowEl.dataset.key) : undefined;
    const k = e.code;
    if ((k === 'KeyJ' || k === 'KeyK') && rowEl && !e.shiftKey) {
      e.preventDefault();
      const sib = (k === 'KeyJ' ? rowEl.nextElementSibling : rowEl.previousElementSibling) as HTMLElement | null;
      if (sib?.matches('[role=row][data-key]')) { sib.focus(); sib.scrollIntoView({ block: 'nearest' }); }
    } else if (k === 'KeyA' && !e.shiftKey && tab === 'unassigned') {
      const rows = selectedRows.length ? selectedRows : focused ? [focused] : [];
      if (!rows.length) return;
      e.preventDefault();
      if (rows.length === 1) actions.act('assign', rows[0]);
      else actions.open({ kind: 'bulk_assign', ids: rows.map((t) => t.id) });
    } else if (k === 'KeyF' && !e.shiftKey && focused?.allowedActions.includes('set_fee')) {
      e.preventDefault();
      actions.act('set_fee', focused);
    } else if (e.key === 'F2' && focused) {
      // F2 edits in the cell: the fee, or (Shift+F2) the commission of a transaction on a customer's page
      const field: InlineField = e.shiftKey && focused.allowedActions.includes('set_commission') ? 'commission' : 'fee';
      if (!focused.allowedActions.includes(field === 'fee' ? 'set_fee' : 'set_commission')) return;
      e.preventDefault();
      setEditing({ id: focused.id, field });
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* tabs and filters on one line (SPEC 6.5): the table starts high on the screen */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-2">
      {/* a single list (the customer's "awaiting approval") needs no tabs of its own */}
      <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as TxnStatus)} className={cx('-mb-2.5', tabs.length === 1 && 'hidden')}>
        <TabList aria-label={inbox ? 'الوارد' : 'معاملات العميل'} className="flex gap-1">
          {tabs.map((k) => (
            <Tab key={k} id={k} className={({ isSelected }) => cx(
              'relative -mb-px flex h-10 cursor-default items-center gap-2 px-3 text-sm outline-none transition-colors duration-150',
              'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
              isSelected ? 'text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent' : 'text-fg-3 hover:text-fg-2')}>
              {txnStatus[k]}
              <span className={cx('num text-[12.5px]', k === 'pending_approval' && counts.data?.[k] ? 'text-accent-ink' : 'text-fg-3')}>{counts.data?.[k] ?? ''}</span>
            </Tab>
          ))}
        </TabList>
      </Tabs>


        <Select label={s.allCurrencies} value={currency} onChange={(k) => setCurrency(String(k))} className="w-[130px]"
          options={[{ id: 'all', label: s.allCurrencies }, ...currencies.map((c) => ({ id: c, label: c }))]} />
        {inbox && (mailboxes.data?.length ?? 0) > 1 && (
          <Select label={s.allMailboxes} value={mailboxId} onChange={(k) => setMailboxId(String(k))} className="w-[150px]"
            options={[{ id: 'all', label: 'كل البريد' }, ...(mailboxes.data ?? []).map((m) => ({ id: String(m.id), label: m.label }))]} />
        )}
        <Select label="الفترة" value={preset} onChange={(k) => setPreset(k as PeriodPreset)} className="w-[130px]"
          options={(Object.keys(periodLabels) as PeriodPreset[]).map((k) => ({ id: k, label: periodLabels[k] }))} />
        {preset === 'custom' && <DateRangePicker label="الفترة المخصّصة" value={custom} onChange={setCustom} className="w-[250px]" />}
        <div className="ms-1 flex gap-4">
          {(inbox || !!counts.data?.needsFee || needsFeeOnly) && (
            <Checkbox isSelected={needsFeeOnly} onChange={setNeedsFeeOnly}>{s.needsFeeOnly}<span className="num text-fg-3">{counts.data?.needsFee}</span></Checkbox>
          )}
          {inbox && (!!counts.data?.needsReview || needsReviewOnly) && (
            <Checkbox isSelected={needsReviewOnly} onChange={setNeedsReviewOnly}>تحتاج مراجعة<span className="num text-warn">{counts.data?.needsReview}</span></Checkbox>
          )}
        </div>
        <div className="ms-auto flex gap-2">
          <ViewsMenu list={inbox ? 'inbox' : 'customer_txns'} capture={() => ({ state: screenState(), columns: cols.current })} apply={applyView} />
          <ColumnsMenu cols={cols} />
        </div>
        {exportSlot && createPortal(
          <Button variant="secondary" onPress={exportExcel} isDisabled={!total}><FileSpreadsheet />تصدير إلى Excel</Button>, exportSlot)}
      </div>

      {selectedRows.length > 0 && (
        <div className="mb-3 flex h-11 items-center gap-1 rounded-card bg-accent-soft pe-2 ps-4 text-sm" role="toolbar" aria-label="إجراءات جماعية">
          <span className="me-3 text-fg">محدّد <span className="num">{selectedRows.length}</span></span>
          {tab === 'unassigned' && <>
            <Button size="sm" variant="quiet" onPress={() => actions.open({ kind: 'bulk_assign', ids })}>تخصيص لعميل</Button>
            <Button size="sm" variant="quiet" onPress={() => actions.bulk('exclude', selectedRows)}>استبعاد</Button>
          </>}
          {tab === 'pending_approval' && <>
            <Button size="sm" variant="quiet" onPress={() => actions.open({ kind: 'bulk_approve', rows: selectedRows })}>اعتماد</Button>
            <Button size="sm" variant="quiet" onPress={() => actions.bulk('unassign', selectedRows)}>إلغاء التخصيص</Button>
          </>}
          {tab === 'approved' && customer.data && (
            <Button size="sm" variant="quiet" onPress={() => setStatementItems(selectedRows.map((t) => ({ kind: 'txn', id: t.id })))}><FileSpreadsheet />إضافة إلى ملف العميل</Button>
          )}
          <Button size="sm" variant="quiet" className="text-neg" onPress={() => actions.open({ kind: 'delete', rows: selectedRows })}>حذف</Button>
          <Button size="icon" variant="quiet" aria-label="إلغاء التحديد" className="ms-auto" onPress={() => setSelected(new Set())}><X /></Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onTableKey}>
      <TableFrame fill scrollRef={scrollRef}>
        <Table style={marginTop ? { marginTop } : undefined} aria-rowcount={total + 1} aria-label={inbox ? 'الوارد' : 'معاملات العميل'} selectionMode="multiple" selectionBehavior="toggle" selectedKeys={selected} onSelectionChange={setSelected}
          sortDescriptor={sort} onSortChange={setSort} onRowAction={(k: Key) => openDetail(Number(k))} minWidth={minWidth}>
          <TableHeader>
            <Column id="occurredAt" allowsSorting isRowHeader width={W.date} sticky="start" stickyOffset={SELECT_W} inner={anyPinned}>{s.cols.date}</Column>
            {columns.map((c) => (
              <Column key={c.id} id={c.id} allowsSorting={SORTABLE.has(c.id)} align={END.has(c.id) ? 'end' : 'start'} width={c.w}
                sticky={c.pinned ? 'start' : undefined} stickyOffset={c.offset} inner={c.pinned && !c.last} data-col={c.id} className="relative">
                {c.id === 'excel'
                  ? <span title="في ملف العميل" className="inline-flex"><FileCheck2 className="size-4" strokeWidth={1.7} aria-hidden /><span className="sr-only">في ملف العميل</span></span>
                  : c.label}
                <ColumnResizer col={c} onResize={(px) => cols.setWidth(c.id, px)} />
              </Column>
            ))}
            <Column id="menu" width={W.menu} sticky="end"><span className="sr-only">إجراءات</span></Column>
          </TableHeader>
          <TableBody items={shown} dependencies={[showExcel, inbox, flashId, detailId, fit, colKey, editing]} renderEmptyState={() => total > 0 ? <p className="py-6 text-center text-fg-3" role="status">جارٍ التحميل…</p> : (
            <div className="py-16 text-center">
              <p className="text-fg-2">{tab === 'unassigned' ? 'الوارد فارغ: كل المعاملات مخصّصة' : tab === 'pending_approval' ? 'لا شيء بانتظار الموافقة' : 'لا معاملات هنا'}</p>
              {inbox && tab === 'unassigned' && <p className="mt-1 text-[13px] text-fg-3">المعاملات المخصّصة في صفحات العملاء، وتجدها بالبحث <kbd className="num rounded border border-line px-1 text-[12px]">Ctrl K</kbd></p>}
            </div>
          )}>
            {(t) => (
              <Row id={t.id} data-opens-detail="" className={cx(flashId === t.id ? '[--row-tint:var(--accent-soft)]' : detailId === t.id && '[--row-tint:var(--raised)]')}>
                <Cell sticky="start" stickyOffset={SELECT_W} inner={anyPinned}><DateCell iso={t.occurredAt} /></Cell>
                {columns.map((c) => {
                  const g = { sticky: c.pinned ? 'start' as const : undefined, stickyOffset: c.offset, inner: c.pinned && !c.last };
                  switch (c.id) {
                    case 'payerName': return <Cell key={c.id} {...g}><PayerCell t={t} /></Cell>;
                    case 'payerNote': return <Cell key={c.id} {...g}><Trunc className="text-fg-2" title={t.payerNote ?? ''}>{t.payerNote ?? ''}</Trunc></Cell>;
                    case 'grossMinor': return <Cell key={c.id} {...g} align="end"><Amount fit={fit.gross} minor={t.grossMinor} currency={t.currency} className={t.grossMinor < 0 ? 'text-neg' : ''} /></Cell>;
                    case 'feeMinor': return (
                      <Cell key={c.id} {...g} align="end">
                        {editing?.id === t.id && editing.field === 'fee'
                          ? <InlineFee t={t} onDone={() => setEditing(null)} />
                          : <div onDoubleClick={() => t.allowedActions.includes('set_fee') && setEditing({ id: t.id, field: 'fee' })}><FeeCell t={t} fit={fit.fee} /></div>}
                      </Cell>
                    );
                    case 'netMinor': return <Cell key={c.id} {...g} align="end"><Amount fit={fit.net} minor={t.netMinor} currency={t.currency} showCurrency={false} /></Cell>;
                    case 'commission': return (
                      <Cell key={c.id} {...g} align="end">
                        {editing?.id === t.id && editing.field === 'commission' ? <InlineCommission t={t} onDone={() => setEditing(null)} /> : (
                          <div onDoubleClick={() => t.allowedActions.includes('set_commission') && setEditing({ id: t.id, field: 'commission' })}>
                            <Amount fit={fit.commission} minor={t.commissionMinor} currency={t.currency} showCurrency={false} className="text-fg-2" />
                            <div className="num text-[12px] text-fg-3">{t.commissionMode === 'percent' && t.commissionBps !== null ? <bdi dir="ltr">{formatBps(t.commissionBps)}</bdi> : t.commissionMode === 'fixed' ? 'ثابتة' : ''}</div>
                          </div>
                        )}
                      </Cell>
                    );
                    case 'customerAmountMinor': return <Cell key={c.id} {...g} align="end"><Amount fit={fit.toCustomer} minor={t.customerAmountMinor} currency={t.currency} showCurrency={false} className="font-medium" /></Cell>;
                    default: return <Cell key={c.id} {...g}>{t.inCustomerExcel && <span title="في ملف العميل" aria-label="في ملف العميل" className="inline-flex text-pos"><Check className="size-4" strokeWidth={2} /></span>}</Cell>;
                  }
                })}
                <Cell sticky="end" className="pe-2">
                  <MenuTrigger>
                    <Button variant="quiet" size="icon" aria-label="إجراءات"><MoreHorizontal /></Button>
                    <Popover placement="bottom end" className="min-w-48 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                      <Menu className="outline-none" onAction={(k) => onMenu(t, k as MenuKey)}>
                        {menuKeys(t).map((a) => (
                          <MenuItem key={a} id={a} className={cx('flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised', (a === 'unapprove' || a === 'delete') && 'text-neg')}>{label(a)}</MenuItem>
                        ))}
                        <MenuItem id="detail" className="flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2.5 text-sm text-fg-2 outline-none data-[focused]:bg-raised">عرض التفاصيل <CornerDownLeft className="ms-auto size-3.5" /></MenuItem>
                      </Menu>
                    </Popover>
                  </MenuTrigger>
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
        {padBottom > 0 && <div aria-hidden style={{ height: padBottom }} />}
        {!!totals?.length && (
          <TotalsTable label={s.totals} minWidth={minWidth} widths={widths}>
            {totals.map((x, i) => (
              <tr key={x.currency}>
                <TotalsCell sticky="start" />
                <TotalsCell sticky="start" stickyOffset={SELECT_W} className="text-[13px] text-fg-3">{i === 0 ? s.totals : ''}</TotalsCell>
                {columns.map((c) => {
                  const g = { sticky: c.pinned ? 'start' as const : undefined, stickyOffset: c.offset };
                  switch (c.id) {
                    case 'payerName': return <TotalsCell key={c.id} {...g} className="text-[13px] text-fg-3">{txnCountLabel(x.count)}</TotalsCell>;
                    case 'grossMinor': return <TotalsCell key={c.id} {...g} align="end"><Amount fit={fit.gross} minor={x.grossMinor} currency={x.currency} className="text-fg-2" /></TotalsCell>;
                    case 'feeMinor': return <TotalsCell key={c.id} {...g} align="end"><Amount fit={fit.fee} minor={x.feeMinor} currency={x.currency} showCurrency={false} className="text-fg-2" /></TotalsCell>;
                    case 'netMinor': return <TotalsCell key={c.id} {...g} align="end"><Amount fit={fit.net} minor={x.netMinor} currency={x.currency} showCurrency={false} className="text-fg-2" /></TotalsCell>;
                    case 'customerAmountMinor': return <TotalsCell key={c.id} {...g} align="end"><Amount fit={fit.toCustomer} minor={x.customerAmountMinor} currency={x.currency} showCurrency={false} className="font-medium text-fg" /></TotalsCell>;
                    default: return <TotalsCell key={c.id} {...g} />;
                  }
                })}
                <TotalsCell sticky="end" />
              </tr>
            ))}
          </TotalsTable>
        )}
      </TableFrame>
      </div>


      {detailId !== null && <DetailPanel id={detailId} onClose={() => openDetail(null)} />}
      {statementItems && customer.data && (
        <AddToStatementDialog customer={customer.data} items={statementItems} onClose={() => setStatementItems(null)} onDone={() => setSelected(new Set())} />
      )}
    </div>
  );
}
