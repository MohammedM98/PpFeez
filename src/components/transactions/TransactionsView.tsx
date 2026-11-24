import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Tabs, TabList, Tab, MenuTrigger, Menu, MenuItem, Popover, type SortDescriptor, type Selection, type Key } from 'react-aria-components';
import { ChevronLeft, ChevronRight, CornerDownLeft, FileSpreadsheet, MoreHorizontal, X } from 'lucide-react';
import { api, native } from '@/lib/api';
import { useAction } from '@/lib/useAction';
import { toast } from '@/components/ui/Toast';
import type { Period, Transaction, TxnAction, TxnFilter, TxnSortKey, TxnStatus } from '@/lib/contract';
import { txn as s, txnStatus, txnType } from '@/lib/strings';
import { formatBps } from '@/lib/money';
import { formatDateTime } from '@/lib/dates';
import { periodLabels, presetPeriod, type PeriodPreset } from '@/lib/period';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox, SearchField, Select } from '@/components/ui/Field';
import { DateRangePicker } from '@/components/ui/DateFields';
import { Table, TableHeader, Column, TableBody, Row, Cell } from '@/components/ui/Table';
import { cx } from '@/components/ui/cx';
import { Trunc } from '@/components/ui/Trunc';
import { FeeCell, StatusBadge, TxnFlags } from './bits';
import { DetailPanel } from './DetailPanel';
import { actionLabel, useTxnActions } from './TxnActions';

const TABS: (TxnStatus | 'all')[] = ['all', 'unassigned', 'pending_approval', 'approved', 'excluded'];
const PAGE_SIZE = 50;

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/**
 * Tabs + filters + table + totals + detail panel. Used by the transactions page and,
 * with `customerId`, by the customer ledger ("معاملاته").
 */
export function TransactionsView({ customerId, exportSlot }: { customerId?: number; exportSlot?: HTMLElement | null }) {
  const [params, setParams] = useSearchParams();
  const embedded = customerId !== undefined;
  const [tab, setTab] = useState<TxnStatus | 'all'>((params.get('tab') as TxnStatus) || 'all');
  const [search, setSearch] = useState('');
  const [currency, setCurrency] = useState<string>('all');
  const [mailboxId, setMailboxId] = useState<string>('all');
  const [customer, setCustomer] = useState<string>('all');
  const [preset, setPreset] = useState<PeriodPreset>('all');
  const [custom, setCustom] = useState<Period>({});
  const [needsFeeOnly, setNeedsFeeOnly] = useState(params.get('needsFee') === '1');
  const [needsReviewOnly, setNeedsReviewOnly] = useState(params.get('needsReview') === '1');
  const [sort, setSort] = useState<SortDescriptor>({ column: 'occurredAt', direction: 'descending' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Selection>(new Set());
  const [detailId, setDetailId] = useState<number | null>(params.get('detail') ? Number(params.get('detail')) : null);
  const actions = useTxnActions();
  const { run } = useAction();

  // Follow links that change the query while this page stays mounted (dashboard cards, deep links).
  const pDetail = params.get('detail'), pTab = params.get('tab'), pNeedsFee = params.get('needsFee'), pNeedsReview = params.get('needsReview');
  useEffect(() => { if (!embedded) setDetailId(pDetail ? Number(pDetail) : null); }, [pDetail, embedded]);
  useEffect(() => { if (!embedded && pTab) setTab(pTab as TxnStatus); }, [pTab, embedded]);
  useEffect(() => { if (!embedded && pNeedsFee) setNeedsFeeOnly(pNeedsFee === '1'); }, [pNeedsFee, embedded]);
  useEffect(() => { if (!embedded && pNeedsReview) setNeedsReviewOnly(pNeedsReview === '1'); }, [pNeedsReview, embedded]);

  const q = useDebounced(search);
  const period = preset === 'custom' ? custom : presetPeriod(preset);
  const filter = useMemo<Omit<TxnFilter, 'status'>>(() => ({
    search: q || undefined,
    currency: currency === 'all' ? undefined : currency,
    mailboxId: mailboxId === 'all' ? undefined : Number(mailboxId),
    customerId: customerId ?? (customer === 'all' ? undefined : Number(customer)),
    period: period.from || period.to ? period : undefined,
    needsFeeOnly: needsFeeOnly || undefined,
    needsReviewOnly: needsReviewOnly || undefined,
  }), [q, currency, mailboxId, customer, customerId, period.from, period.to, needsFeeOnly, needsReviewOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setPage(1); setSelected(new Set()); }, [filter, tab, sort]);

  const counts = useQuery({ queryKey: ['txn_counts', filter], queryFn: () => api.txnCounts(filter) });
  const list = useQuery({
    queryKey: ['txn_list', filter, tab, sort, page],
    queryFn: () => api.txnList({ ...filter, status: tab }, { key: sort.column as TxnSortKey, dir: sort.direction === 'ascending' ? 'asc' : 'desc' }, page, PAGE_SIZE),
    placeholderData: keepPreviousData,
  });
  const customers = useQuery({ queryKey: ['customers', {}], queryFn: () => api.customersList({}), enabled: !embedded });
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: api.mailboxList });
  const currencies = useMemo(() => {
    const set = new Set(['USD', 'EUR', 'TRY', ...(list.data?.totals.map((t) => t.currency) ?? [])]);
    return [...set];
  }, [list.data]);

  const items = list.data?.items ?? [];
  const selectedRows: Transaction[] = selected === 'all' ? items : items.filter((t) => selected.has(t.id));
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));

  const exportExcel = async () => {
    const path = await native.saveXlsx(`PpFeez-معاملات-${new Date().toISOString().slice(0, 10)}.xlsx`);
    if (!path) return;
    const r = await run(() => api.excelExportTransactions({ ...filter, status: tab }, { key: sort.column as TxnSortKey, dir: sort.direction === 'ascending' ? 'asc' : 'desc' }, path));
    if (r.ok) toast.ok('صُدّرت المعاملات إلى Excel', `${r.value.rows} صف، كل الصفحات بالفلتر الحالي`);
  };

  const openDetail = (id: number | null) => {
    setDetailId(id);
    if (!embedded) {
      const p = new URLSearchParams(params);
      if (id === null) p.delete('detail'); else p.set('detail', String(id));
      setParams(p, { replace: true });
    }
  };

  return (
    <div className="flex flex-col">
      <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as TxnStatus | 'all')} className="mb-4">
        <TabList aria-label="حالة المعاملة" className="flex gap-1 border-b border-line">
          {TABS.map((k) => (
            <Tab key={k} id={k} className={({ isSelected }) => cx(
              'relative -mb-px flex h-10 cursor-default items-center gap-2 px-3 text-sm outline-none transition-colors duration-150',
              'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
              isSelected ? 'text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent' : 'text-fg-3 hover:text-fg-2')}>
              {k === 'all' ? s.tabAll : txnStatus[k]}
              <span className="num text-[12.5px] text-fg-3">{counts.data?.[k] ?? ''}</span>
            </Tab>
          ))}
        </TabList>
      </Tabs>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchField label={s.search} value={search} onChange={setSearch} className="min-w-[220px] max-w-[320px] flex-1" />
        <Select label={s.allCurrencies} value={currency} onChange={(k) => setCurrency(String(k))} className="w-[120px]"
          options={[{ id: 'all', label: s.allCurrencies }, ...currencies.map((c) => ({ id: c, label: c }))]} />
        {!embedded && (
          <Select label={s.allCustomers} value={customer} onChange={(k) => setCustomer(String(k))} className="w-[150px]"
            options={[{ id: 'all', label: s.allCustomers }, ...(customers.data ?? []).map((c) => ({ id: String(c.id), label: c.name }))]} />
        )}
        {(mailboxes.data?.length ?? 0) > 1 && (
          <Select label={s.allMailboxes} value={mailboxId} onChange={(k) => setMailboxId(String(k))} className="w-[150px]"
            options={[{ id: 'all', label: 'كل البريد' }, ...(mailboxes.data ?? []).map((m) => ({ id: String(m.id), label: m.label }))]} />
        )}
        <Select label="الفترة" value={preset} onChange={(k) => setPreset(k as PeriodPreset)} className="w-[130px]"
          options={(Object.keys(periodLabels) as PeriodPreset[]).map((k) => ({ id: k, label: periodLabels[k] }))} />
        {preset === 'custom' && <DateRangePicker label="الفترة المخصّصة" value={custom} onChange={setCustom} className="w-[250px]" />}
        <div className="ms-1 flex gap-4">
          <Checkbox isSelected={needsFeeOnly} onChange={setNeedsFeeOnly}>{s.needsFeeOnly}<span className="num text-fg-3">{counts.data?.needsFee}</span></Checkbox>
          {(!!counts.data?.needsReview || needsReviewOnly) && (
            <Checkbox isSelected={needsReviewOnly} onChange={setNeedsReviewOnly}>تحتاج مراجعة<span className="num text-warn">{counts.data?.needsReview}</span></Checkbox>
          )}
        </div>
        {exportSlot && createPortal(
          <Button variant="secondary" onPress={exportExcel} isDisabled={!list.data?.total}><FileSpreadsheet />تصدير إلى Excel</Button>, exportSlot)}
      </div>

      {selectedRows.length > 0 && (
        <div className="mb-3 flex h-11 items-center gap-1 rounded-card bg-accent-soft pe-2 ps-4 text-sm" role="toolbar" aria-label="إجراءات جماعية">
          <span className="me-3 text-fg">محدّد <span className="num">{selectedRows.length}</span></span>
          <Button size="sm" variant="quiet" onPress={() => actions.open({ kind: 'bulk_assign', ids: selectedRows.map((t) => t.id) })}>تخصيص لعميل</Button>
          <Button size="sm" variant="quiet" onPress={() => actions.open({ kind: 'bulk_approve', rows: selectedRows })}>اعتماد</Button>
          <Button size="sm" variant="quiet" onPress={() => actions.bulk('unassign', selectedRows)}>إلغاء التخصيص</Button>
          <Button size="sm" variant="quiet" onPress={() => actions.bulk('exclude', selectedRows)}>استبعاد</Button>
          <Button size="sm" variant="quiet" className="text-neg" onPress={() => actions.open({ kind: 'delete', rows: selectedRows })}>حذف</Button>
          <Button size="icon" variant="quiet" aria-label="إلغاء التحديد" className="ms-auto" onPress={() => setSelected(new Set())}><X /></Button>
        </div>
      )}

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="overflow-x-auto">
          <Table aria-label={s.title} selectionMode="multiple" selectionBehavior="toggle" selectedKeys={selected} onSelectionChange={setSelected}
            sortDescriptor={sort} onSortChange={setSort} onRowAction={(k: Key) => openDetail(Number(k))}>
            <TableHeader>
              <Column id="occurredAt" allowsSorting isRowHeader>{s.cols.date}</Column>
              <Column id="payerName" allowsSorting>{s.cols.payer}</Column>
              <Column id="payerNote">{s.cols.payerNote}</Column>
              <Column id="grossMinor" allowsSorting align="end">{s.cols.gross}</Column>
              <Column id="feeMinor" allowsSorting align="end">{s.cols.fee}</Column>
              <Column id="netMinor" allowsSorting align="end">{s.cols.net}</Column>
              <Column id="customer">{s.cols.customer}</Column>
              <Column id="customerAmountMinor" allowsSorting align="end">{s.cols.toCustomer}</Column>
              <Column id="status" allowsSorting>{s.cols.status}</Column>
              <Column id="menu"><span className="sr-only">إجراءات</span></Column>
            </TableHeader>
            <TableBody items={items} renderEmptyState={() => (
              <div className="py-16 text-center">
                <p className="text-fg-2">لا معاملات بهذا الفلتر</p>
                <p className="mt-1 text-[13px] text-fg-3">غيّر التبويب أو امسح البحث</p>
              </div>
            )}>
              {(t) => (
                <Row id={t.id} className={cx(detailId === t.id && 'bg-raised')}>
                  <Cell>
                    <div className="num whitespace-nowrap leading-tight">{formatDateTime(t.occurredAt).slice(0, 10)}</div>
                    <div className="num text-[12px] leading-tight text-fg-3">{formatDateTime(t.occurredAt).slice(11)}</div>
                  </Cell>
                  <Cell className="max-w-[160px]">
                    <div className="flex items-center gap-1.5 leading-tight">
                      <Trunc className="min-w-0">{t.payerName ?? '—'}</Trunc>
                      {t.type !== 'payment' && <Badge tone="neg">{txnType[t.type]}</Badge>}
                      {t.source === 'manual' && <Badge tone="outline">يدوية</Badge>}
                      <TxnFlags t={t} />
                    </div>
                    {t.refundedBy.length
                      ? <div className="text-[12px] leading-tight text-neg">{s.refunded}</div>
                      : <Trunc className="text-[12px] leading-tight text-fg-3">{t.payerEmail || t.paypalTxnId}</Trunc>}
                  </Cell>
                  <Cell className="max-w-[104px]"><Trunc className="text-fg-2" title={t.payerNote ?? ''}>{t.payerNote ?? ''}</Trunc></Cell>
                  <Cell align="end"><Amount minor={t.grossMinor} currency={t.currency} className={t.grossMinor < 0 ? 'text-neg' : ''} /></Cell>
                  <Cell align="end"><FeeCell t={t} /></Cell>
                  <Cell align="end"><Amount minor={t.netMinor} currency={t.currency} showCurrency={false} /></Cell>
                  <Cell>
                    {t.customer ? (
                      <>
                        <div className="whitespace-nowrap leading-tight">{t.customer.name}</div>
                        <div className="whitespace-nowrap text-[12px] leading-tight text-fg-3">
                          عمولة {t.commissionMode === 'percent' && t.commissionBps !== null ? <bdi dir="ltr" className="num">{formatBps(t.commissionBps)}</bdi> : 'ثابتة'}
                        </div>
                      </>
                    ) : <span className="text-fg-3">—</span>}
                  </Cell>
                  <Cell align="end"><Amount minor={t.customerAmountMinor} currency={t.currency} showCurrency={false} className="font-medium" /></Cell>
                  <Cell><StatusBadge status={t.status} dot={false} /></Cell>
                  <Cell className="pe-2">
                    <MenuTrigger>
                      <Button variant="quiet" size="icon" aria-label="إجراءات"><MoreHorizontal /></Button>
                      <Popover placement="bottom end" className="min-w-48 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                        <Menu className="outline-none" onAction={(k) => (k === 'detail' ? openDetail(t.id) : actions.act(k as TxnAction, t))}>
                          {t.allowedActions.map((a) => (
                            <MenuItem key={a} id={a} className={cx('flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised', (a === 'unapprove' || a === 'delete') && 'text-neg')}>{actionLabel[a]}</MenuItem>
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
        </div>
        {!!list.data?.totals.length && (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-t border-line bg-raised/40 px-4 py-3 text-[13px]">
            <span className="text-fg-3">{s.totals}</span>
            {list.data.totals.map((x) => (
              <span key={x.currency} className="flex items-center gap-3">
                <span className="text-fg-2"><Amount minor={x.grossMinor} currency={x.currency} /></span>
                <span className="text-fg-3">رسوم <Amount minor={x.feeMinor} currency={x.currency} showCurrency={false} className="text-fg-2" /></span>
                <span className="text-fg-3">للعملاء <Amount minor={x.customerAmountMinor} currency={x.currency} showCurrency={false} className="text-fg-2" /></span>
                <span className="num text-fg-3">{x.count} معاملة</span>
              </span>
            ))}
          </div>
        )}
      </div>

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
