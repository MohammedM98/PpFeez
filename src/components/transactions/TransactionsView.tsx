import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Tabs, TabList, Tab, MenuTrigger, Menu, MenuItem, Popover, type SortDescriptor, type Selection, type Key } from 'react-aria-components';
import { ChevronLeft, ChevronRight, CornerDownLeft, FileSpreadsheet, MoreHorizontal, X } from 'lucide-react';
import { api, native } from '@/lib/api';
import { useAction } from '@/lib/useAction';
import { toast } from '@/components/ui/Toast';
import type { Period, Transaction, TxnAction, TxnFilter, TxnSortKey, TxnStatus } from '@/lib/contract';
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
import { DetailPanel } from './DetailPanel';
import { actionLabel, useTxnActions } from './TxnActions';

/**
 * SPEC 6.3: the transactions screen is an inbox of what is not assigned yet; the moment a row is
 * assigned it moves to the customer's page (6.5), where it is approved. One view, two scopes.
 */
export type TxnScope = { kind: 'inbox' } | { kind: 'customer'; customerId: number };

const TABS = {
  inbox: ['unassigned', 'excluded'] as TxnStatus[],
  customer: ['pending_approval', 'approved'] as TxnStatus[],
};
const PAGE_SIZE = 50;
/** the payer column takes the remaining width, never less than this */
const PAYER_MIN = '160px';

/** Row menu entries: the core's allowedActions, plus "move to another customer" for a pending row. */
type MenuKey = TxnAction | 'move' | 'detail';

export function TransactionsView({ scope, exportSlot }: { scope: TxnScope; exportSlot?: HTMLElement | null }) {
  const inbox = scope.kind === 'inbox';
  const customerId = scope.kind === 'customer' ? scope.customerId : undefined;
  const tabs = inbox ? TABS.inbox : TABS.customer;
  const tabKey = inbox ? 'tab' : 'sub';
  const [params, setParams] = useSearchParams();
  const asTab = (v: string | null) => (v && tabs.includes(v as TxnStatus) ? (v as TxnStatus) : null);
  const [tab, setTabState] = useState<TxnStatus>(asTab(params.get(tabKey)) ?? tabs[0]);
  const tabChosen = useRef(!!asTab(params.get(tabKey)));
  const [currency, setCurrency] = useState<string>('all');
  const [mailboxId, setMailboxId] = useState<string>('all');
  const [preset, setPreset] = useState<PeriodPreset>('all');
  const [custom, setCustom] = useState<Period>({});
  const [needsFeeOnly, setNeedsFeeOnly] = useState(params.get('needsFee') === '1');
  const [needsReviewOnly, setNeedsReviewOnly] = useState(params.get('needsReview') === '1');
  const [sort, setSort] = useState<SortDescriptor>({ column: 'occurredAt', direction: 'descending' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Selection>(new Set());
  const [detailId, setDetailId] = useState<number | null>(params.get('detail') ? Number(params.get('detail')) : null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const actions = useTxnActions();
  const { run } = useAction();

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

  useEffect(() => { setPage(1); setSelected(new Set()); }, [filter, tab, sort]);

  const counts = useQuery({ queryKey: ['txn_counts', filter], queryFn: () => api.txnCounts(filter) });
  // the customer page opens on "awaiting approval" when there is something there, otherwise on "approved"
  useEffect(() => {
    if (inbox || tabChosen.current || !counts.data) return;
    if (counts.data.pending_approval === 0 && counts.data.approved > 0) setTabState('approved');
    tabChosen.current = true;
  }, [inbox, counts.data]);

  const sortInput = { key: sort.column as TxnSortKey, dir: sort.direction === 'ascending' ? 'asc' as const : 'desc' as const };
  const list = useQuery({
    queryKey: ['txn_list', filter, tab, sort, page],
    queryFn: () => api.txnList({ ...filter, status: tab }, sortInput, page, PAGE_SIZE),
    placeholderData: keepPreviousData,
  });
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: api.mailboxList, enabled: inbox });
  const currencies = useMemo(() => [...new Set(['USD', 'EUR', 'TRY', ...(list.data?.totals.map((t) => t.currency) ?? [])])], [list.data]);

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const selectedRows: Transaction[] = selected === 'all' ? items : items.filter((t) => selected.has(t.id));
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));
  const totals = list.data?.totals;

  // a row opened from search: bring it into view and mark it for a moment
  useEffect(() => {
    if (flashId === null || !items.some((t) => t.id === flashId)) return;
    document.querySelector(`[role=row][data-key="${flashId}"]`)?.scrollIntoView({ block: 'center' });
    const t = setTimeout(() => setFlashId(null), 1800);
    return () => clearTimeout(t);
  }, [flashId, items]);

  const fit = useMemo(() => {
    const col = (row: (t: Transaction) => number | null, tot?: (x: NonNullable<typeof totals>[number]) => number) =>
      amountFit([...items.map((t) => ({ minor: row(t), currency: t.currency })), ...(tot ? (totals ?? []).map((x) => ({ minor: tot(x), currency: x.currency })) : [])]);
    return {
      gross: col((t) => t.grossMinor, (x) => x.grossMinor),
      fee: col((t) => t.feeMinor, (x) => x.feeMinor),
      net: col((t) => t.netMinor, (x) => x.netMinor),
      commission: col((t) => t.commissionMinor),
      toCustomer: col((t) => t.customerAmountMinor, (x) => x.customerAmountMinor),
    };
  }, [items, totals]);
  const W = useMemo(() => {
    const base = {
      date: '96px', note: inbox ? '130px' : '110px', menu: '48px',
      gross: amountWidth(fit.gross, true, 72), fee: amountWidth(fit.fee, false, 100), net: amountWidth(fit.net, false, 64),
    };
    const commission = inbox ? undefined : amountWidth(fit.commission, false, 72);
    const toCustomer = inbox ? undefined : amountWidth(fit.toCustomer, false, 72);
    return { ...base, commission, toCustomer, min: sumWidths([SELECT_W, ...Object.values(base), commission, toCustomer, PAYER_MIN]) };
  }, [fit, inbox]);
  const widths = inbox
    ? [SELECT_W, W.date, undefined, W.note, W.gross, W.fee, W.net, W.menu]
    : [SELECT_W, W.date, undefined, W.note, W.gross, W.fee, W.net, W.commission, W.toCustomer, W.menu];

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
  return (
    <div className="flex flex-col">
      <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as TxnStatus)} className="mb-4">
        <TabList aria-label={inbox ? 'الوارد' : 'معاملات العميل'} className="flex gap-1 border-b border-line">
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
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
        {exportSlot && createPortal(
          <Button variant="secondary" onPress={exportExcel} isDisabled={!list.data?.total}><FileSpreadsheet />تصدير إلى Excel</Button>, exportSlot)}
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
          <Button size="sm" variant="quiet" className="text-neg" onPress={() => actions.open({ kind: 'delete', rows: selectedRows })}>حذف</Button>
          <Button size="icon" variant="quiet" aria-label="إلغاء التحديد" className="ms-auto" onPress={() => setSelected(new Set())}><X /></Button>
        </div>
      )}

      <TableFrame>
        <Table aria-label={inbox ? 'الوارد' : 'معاملات العميل'} selectionMode="multiple" selectionBehavior="toggle" selectedKeys={selected} onSelectionChange={setSelected}
          sortDescriptor={sort} onSortChange={setSort} onRowAction={(k: Key) => openDetail(Number(k))} minWidth={W.min}>
          <TableHeader>
            <Column id="occurredAt" allowsSorting isRowHeader width={W.date} sticky="start" stickyOffset={SELECT_W}>{s.cols.date}</Column>
            <Column id="payerName" allowsSorting>{s.cols.payer}</Column>
            <Column id="payerNote" width={W.note}>{s.cols.payerNote}</Column>
            <Column id="grossMinor" allowsSorting align="end" width={W.gross}>{s.cols.gross}</Column>
            <Column id="feeMinor" allowsSorting align="end" width={W.fee}>{s.cols.fee}</Column>
            <Column id="netMinor" allowsSorting align="end" width={W.net}>{s.cols.net}</Column>
            {!inbox && <Column id="commission" align="end" width={W.commission}>العمولة</Column>}
            {!inbox && <Column id="customerAmountMinor" allowsSorting align="end" width={W.toCustomer}>{s.cols.toCustomer}</Column>}
            <Column id="menu" width={W.menu} sticky="end"><span className="sr-only">إجراءات</span></Column>
          </TableHeader>
          <TableBody items={items} renderEmptyState={() => (
            <div className="py-16 text-center">
              <p className="text-fg-2">{tab === 'unassigned' ? 'الوارد فارغ: كل المعاملات مخصّصة' : tab === 'pending_approval' ? 'لا شيء بانتظار الموافقة' : 'لا معاملات هنا'}</p>
              {inbox && tab === 'unassigned' && <p className="mt-1 text-[13px] text-fg-3">المعاملات المخصّصة في صفحات العملاء، وتجدها بالبحث <kbd className="num rounded border border-line px-1 text-[12px]">Ctrl K</kbd></p>}
            </div>
          )}>
            {(t) => (
              <Row id={t.id} className={cx(flashId === t.id ? '[--row-tint:var(--accent-soft)]' : detailId === t.id && '[--row-tint:var(--raised)]')}>
                <Cell sticky="start" stickyOffset={SELECT_W}><DateCell iso={t.occurredAt} /></Cell>
                <Cell><PayerCell t={t} /></Cell>
                <Cell><Trunc className="text-fg-2" title={t.payerNote ?? ''}>{t.payerNote ?? ''}</Trunc></Cell>
                <Cell align="end"><Amount fit={fit.gross} minor={t.grossMinor} currency={t.currency} className={t.grossMinor < 0 ? 'text-neg' : ''} /></Cell>
                <Cell align="end"><FeeCell t={t} fit={fit.fee} /></Cell>
                <Cell align="end"><Amount fit={fit.net} minor={t.netMinor} currency={t.currency} showCurrency={false} /></Cell>
                {!inbox && (
                  <Cell align="end">
                    <Amount fit={fit.commission} minor={t.commissionMinor} currency={t.currency} showCurrency={false} className="text-fg-2" />
                    <div className="num text-[12px] text-fg-3">{t.commissionMode === 'percent' && t.commissionBps !== null ? <bdi dir="ltr">{formatBps(t.commissionBps)}</bdi> : t.commissionMode === 'fixed' ? 'ثابتة' : ''}</div>
                  </Cell>
                )}
                {!inbox && <Cell align="end"><Amount fit={fit.toCustomer} minor={t.customerAmountMinor} currency={t.currency} showCurrency={false} className="font-medium" /></Cell>}
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
        {!!totals?.length && (
          <TotalsTable label={s.totals} minWidth={W.min} widths={widths}>
            {totals.map((x, i) => (
              <tr key={x.currency}>
                <TotalsCell sticky="start" />
                <TotalsCell sticky="start" stickyOffset={SELECT_W} className="text-[13px] text-fg-3">{i === 0 ? s.totals : ''}</TotalsCell>
                <TotalsCell className="text-[13px] text-fg-3">{txnCountLabel(x.count)}</TotalsCell>
                <TotalsCell />
                <TotalsCell align="end"><Amount fit={fit.gross} minor={x.grossMinor} currency={x.currency} className="text-fg-2" /></TotalsCell>
                <TotalsCell align="end"><Amount fit={fit.fee} minor={x.feeMinor} currency={x.currency} showCurrency={false} className="text-fg-2" /></TotalsCell>
                <TotalsCell align="end"><Amount fit={fit.net} minor={x.netMinor} currency={x.currency} showCurrency={false} className="text-fg-2" /></TotalsCell>
                {!inbox && <TotalsCell />}
                {!inbox && <TotalsCell align="end"><Amount fit={fit.toCustomer} minor={x.customerAmountMinor} currency={x.currency} showCurrency={false} className="font-medium text-fg" /></TotalsCell>}
                <TotalsCell sticky="end" />
              </tr>
            ))}
          </TotalsTable>
        )}
      </TableFrame>

      {pages > 1 && (
        <nav className="mt-3 flex items-center justify-between text-[13px] text-fg-3" aria-label="الصفحات">
          <span className="num">{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, list.data?.total ?? 0)} من {list.data?.total}</span>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="quiet" isDisabled={page <= 1} onPress={() => setPage(page - 1)}><ChevronRight />السابقة</Button>
            <span className="num px-2">{page} / {pages}</span>
            <Button size="sm" variant="quiet" isDisabled={page >= pages} onPress={() => setPage(page + 1)}>التالية<ChevronLeft /></Button>
          </div>
        </nav>
      )}

      {detailId !== null && <DetailPanel id={detailId} onClose={() => openDetail(null)} />}
    </div>
  );
}
