import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabList, Tab, MenuTrigger, Menu, MenuItem, Popover, type SortDescriptor, type Selection } from 'react-aria-components';
import { CloudDownload, MoreHorizontal, Plus, X, FileText, CornerDownLeft } from 'lucide-react';
import { api } from '@/lib/api';
import type { Transaction, TxnAction, TxnSortKey, TxnStatus } from '@/lib/contract';
import { txn as s, txnStatus, txnType } from '@/lib/strings';
import { formatBps } from '@/lib/money';
import { formatDateTime } from '@/lib/dates';
import { DateTime } from '@/components/ui/DateTime';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox, SearchField, Select } from '@/components/ui/Field';
import { Table, TableHeader, Column, TableBody, Row, Cell } from '@/components/ui/Table';
import { cx } from '@/components/ui/cx';

const TABS: (TxnStatus | 'all')[] = ['all', 'unassigned', 'pending_approval', 'approved', 'excluded'];

const actionLabel: Record<TxnAction, string> = {
  assign: 'تخصيص لعميل', unassign: 'إلغاء التخصيص', set_fee: 'تعديل الرسوم', set_commission: 'تعديل العمولة',
  approve: 'اعتماد', unapprove: 'إلغاء الاعتماد', exclude: 'استبعاد', include: 'إرجاع', edit_note: 'تعديل الملاحظة',
};

export function StatusBadge({ status, dot = true }: { status: TxnStatus; dot?: boolean }) {
  const tone = { unassigned: 'neutral', pending_approval: 'accent', approved: 'pos', excluded: 'outline' } as const;
  return <Badge tone={tone[status]} dot={dot && status !== 'excluded'}>{txnStatus[status]}</Badge>;
}

function FeeCell({ t }: { t: Transaction }) {
  if (t.feeMinor === null) return <Badge tone="warn">{s.needsFee}</Badge>;
  if (t.feeIsEstimated)
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <Amount minor={t.feeMinor} currency={t.currency} showCurrency={false} estimated className="italic" />
        <span className="text-[11.5px] text-fg-3">{s.estimated}</span>
      </span>
    );
  return <Amount minor={t.feeMinor} currency={t.currency} showCurrency={false} className="text-fg-2" />;
}

function Breakdown({ t }: { t: Transaction }) {
  const rows: [string, number | null, string?, string?][] = [
    [s.detail.gross, t.grossMinor],
    [s.detail.fee, t.feeMinor === null ? null : -t.feeMinor],
    [s.detail.net, t.netMinor, 'rule'],
    [s.detail.commission, t.commissionMinor === null ? null : -t.commissionMinor, undefined, t.commissionMode === 'percent' && t.commissionBps !== null ? formatBps(t.commissionBps) : t.commissionMode === 'fixed' ? 'ثابتة' : undefined],
    [s.detail.toCustomer, t.customerAmountMinor, 'total'],
  ];
  return (
    <div className="rounded-card bg-raised/60 p-4">
      <div className="mb-2 text-[13px] text-fg-3">{s.detail.breakdown}</div>
      <dl className="flex flex-col">
        {rows.map(([label, v, kind, hint]) => (
          <div key={label} className={cx('flex items-center justify-between py-1.5', kind && 'mt-1 border-t border-line pt-2.5')}>
            <dt className={cx('text-sm', kind === 'total' ? 'text-fg' : 'text-fg-2')}>{label}{hint && <>{' '}<bdi dir="ltr" className="num text-fg-3">{hint}</bdi></>}</dt>
            <dd className={cx(kind === 'total' && 'text-[17px] font-medium')}>
              {v === null ? <span className="text-[13px] text-warn">{label === s.detail.fee ? s.needsFee : '—'}</span> : <Amount minor={v} currency={t.currency} showCurrency={kind === 'total'} className={kind === 'total' ? 'text-accent-ink' : ''} />}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DetailPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: t } = useQuery({ queryKey: ['txn', id], queryFn: () => api.txnGet(id) });
  const { data: history } = useQuery({ queryKey: ['txn_history', id], queryFn: () => api.txnHistory(id) });
  if (!t) return null;
  return (
    <aside className="absolute inset-y-3 end-3 z-20 flex w-[380px] flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-(--shadow-float)" aria-label="تفاصيل المعاملة">
      <header className="flex items-start justify-between gap-3 border-b border-line p-5">
        <div className="min-w-0">
          <div className="mb-1.5"><StatusBadge status={t.status} /></div>
          <div className="truncate text-[17px] font-medium" dir="auto">{t.payerName}</div>
          <div className="truncate text-[13px] text-fg-3" dir="ltr" style={{ textAlign: 'right' }}>{t.payerEmail}</div>
        </div>
        <Button variant="quiet" size="icon" aria-label="إغلاق" onPress={onClose}><X /></Button>
      </header>
      <div className="flex-1 space-y-5 overflow-auto p-5">
        <Breakdown t={t} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
          <dt className="text-fg-3">{s.cols.date}</dt><dd><DateTime iso={t.occurredAt} /></dd>
          <dt className="text-fg-3">{s.detail.paypalId}</dt><dd><bdi dir="ltr" className="num select-all text-fg-2">{t.paypalTxnId}</bdi></dd>
          <dt className="text-fg-3">{s.cols.customer}</dt><dd>{t.customer?.name ?? '—'}</dd>
          <dt className="text-fg-3">{s.detail.mailbox}</dt><dd>{t.mailbox?.label ?? 'يدوية'}</dd>
          {t.payerNote && (<><dt className="text-fg-3">{s.cols.payerNote}</dt><dd><bdi>{t.payerNote}</bdi></dd></>)}
        </dl>
        <div>
          <div className="mb-2 text-[13px] text-fg-3">{s.detail.history}</div>
          <ol className="space-y-2.5 border-s border-line ps-4">
            {history?.map((h) => (
              <li key={h.id} className="relative text-sm">
                <span className="absolute -start-[21px] top-2 size-2 rounded-full bg-line-strong" aria-hidden />
                <div className="text-fg-2">{h.labelAr}</div>
                <DateTime iso={h.createdAt} className="text-[12.5px] text-fg-3" />
              </li>
            ))}
          </ol>
        </div>
      </div>
      <footer className="flex gap-2 border-t border-line p-4">
        {t.allowedActions.includes('approve') && <Button variant="primary" className="flex-1">اعتماد <Amount minor={t.customerAmountMinor} currency={t.currency} className="text-accent-fg [&_span]:text-accent-fg/75" /></Button>}
        {t.allowedActions.includes('assign') && <Button variant="primary" className="flex-1">تخصيص لعميل</Button>}
        <Button variant="secondary"><FileText />{s.detail.viewEmail}</Button>
      </footer>
    </aside>
  );
}

export function TransactionsPage() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TxnStatus | 'all'>((params.get('tab') as TxnStatus) ?? 'all');
  const [search, setSearch] = useState('');
  const [currency, setCurrency] = useState<string>('all');
  const [needsFeeOnly, setNeedsFeeOnly] = useState(false);
  const [sort, setSort] = useState<SortDescriptor>({ column: 'occurredAt', direction: 'descending' });
  const [selected, setSelected] = useState<Selection>(new Set());
  const detailId = params.get('detail') ? Number(params.get('detail')) : null;

  const filter = useMemo(() => ({ search: search || undefined, currency: currency === 'all' ? undefined : currency, needsFeeOnly: needsFeeOnly || undefined }), [search, currency, needsFeeOnly]);
  const counts = useQuery({ queryKey: ['txn_counts', filter], queryFn: () => api.txnCounts(filter) });
  const list = useQuery({
    queryKey: ['txn_list', filter, tab, sort],
    queryFn: () => api.txnList({ ...filter, status: tab }, { key: sort.column as TxnSortKey, dir: sort.direction === 'ascending' ? 'asc' : 'desc' }, 1, 50),
    placeholderData: (prev) => prev,
  });
  const lastPull = useQuery({ queryKey: ['pull_runs', 1], queryFn: () => api.pullRunsList(1) });
  const run = lastPull.data?.[0];
  const selCount = selected === 'all' ? list.data?.total ?? 0 : selected.size;

  const openDetail = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id === null) p.delete('detail'); else p.set('detail', String(id));
    setParams(p, { replace: true });
  };

  return (
    <div className="relative mx-auto flex min-h-full max-w-[1560px] flex-col px-6 pb-8 pt-6">
      <header className="mb-5 flex items-end justify-between gap-6">
        <div>
          <h1 className="font-display text-[26px] font-medium leading-[1.35] text-fg">{s.title}</h1>
          {run && (
            <p className="text-[13.5px] text-fg-3">
              آخر سحب من {run.mailboxLabel} <DateTime iso={run.finishedAt} />، {run.newTransactionsCount} جديدة
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary"><Plus />{s.addManual}</Button>
          <Button variant="primary"><CloudDownload />{s.pull}</Button>
        </div>
      </header>

      <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as TxnStatus | 'all')} className="mb-4">
        <TabList aria-label="حالة المعاملة" className="flex gap-1 border-b border-line">
          {TABS.map((k) => (
            <Tab key={k} id={k} className={({ isSelected }) => cx(
              'relative -mb-px flex h-10 cursor-default items-center gap-2 px-3 text-sm outline-none transition-colors duration-150',
              'data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus',
              isSelected ? 'text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent' : 'text-fg-3 hover:text-fg-2')}>
              {k === 'all' ? s.tabAll : txnStatus[k]}
              <span className="num text-[12.5px] text-fg-3">{counts.data?.[k] ?? ''}</span>
            </Tab>
          ))}
        </TabList>
      </Tabs>

      <div className="mb-4 flex items-center gap-2">
        <SearchField label={s.search} value={search} onChange={setSearch} className="w-[340px]" />
        <Select label={s.allCurrencies} value={currency} onChange={(k) => setCurrency(String(k))} className="w-[150px]"
          options={[{ id: 'all', label: s.allCurrencies }, { id: 'USD', label: 'USD' }, { id: 'EUR', label: 'EUR' }, { id: 'TRY', label: 'TRY' }]} />
        <Select label={s.allCustomers} value="all" onChange={() => {}} className="w-[170px]" options={[{ id: 'all', label: s.allCustomers }]} />
        <div className="ms-2"><Checkbox isSelected={needsFeeOnly} onChange={setNeedsFeeOnly}>{s.needsFeeOnly}<span className="num text-fg-3">{counts.data?.needsFee}</span></Checkbox></div>
      </div>

      {selCount > 0 && (
        <div className="mb-3 flex h-11 items-center gap-2 rounded-card bg-accent-soft px-4 text-sm">
          <span className="text-fg">محدّد <span className="num">{selCount}</span></span>
          <span className="mx-2 h-4 w-px bg-line-strong" />
          <Button size="sm" variant="quiet">تخصيص لعميل</Button>
          <Button size="sm" variant="quiet">اعتماد</Button>
          <Button size="sm" variant="quiet">إلغاء التخصيص</Button>
          <Button size="sm" variant="quiet">استبعاد</Button>
        </div>
      )}

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="overflow-x-auto">
        <Table aria-label={s.title} selectionMode="multiple" selectionBehavior="toggle" selectedKeys={selected} onSelectionChange={setSelected}
          sortDescriptor={sort} onSortChange={setSort} onRowAction={(k) => openDetail(Number(k))}>
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
            <Column id="menu" width={40}><span className="sr-only">إجراءات</span></Column>
          </TableHeader>
          <TableBody items={list.data?.items ?? []} renderEmptyState={() => <div className="py-16 text-center text-fg-3">لا معاملات بهذا الفلتر</div>}>
            {(t) => (
              <Row id={t.id} className={cx(detailId === t.id && 'bg-raised')}>
                <Cell>
                  <div className="num whitespace-nowrap leading-tight">{formatDateTime(t.occurredAt).slice(0, 10)}</div>
                  <div className="num text-[12px] leading-tight text-fg-3">{formatDateTime(t.occurredAt).slice(11)}</div>
                </Cell>
                <Cell className="max-w-[160px]">
                  <div className="flex items-center gap-1.5 leading-tight">
                    <span className="truncate" dir="auto">{t.payerName}</span>
                    {t.type !== 'payment' && <Badge tone="neg">{txnType[t.type]}</Badge>}
                    {t.source === 'manual' && <Badge tone="outline">يدوية</Badge>}
                  </div>
                  <div className="truncate text-[12px] leading-tight text-fg-3" dir="ltr" style={{ textAlign: 'right' }}>
                    {t.refundedBy.length ? <span className="text-neg" dir="rtl">{s.refunded}</span> : t.payerEmail || t.paypalTxnId}
                  </div>
                </Cell>
                <Cell className="max-w-[104px]"><div className="truncate text-fg-2" dir="auto" title={t.payerNote ?? ''}>{t.payerNote ?? ''}</div></Cell>
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
                <Cell>
                  <MenuTrigger>
                    <Button variant="quiet" size="icon" aria-label="إجراءات"><MoreHorizontal /></Button>
                    <Popover placement="bottom end" className="min-w-48 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                      <Menu className="outline-none" onAction={(k) => k === 'detail' && openDetail(t.id)}>
                        {t.allowedActions.map((a) => (
                          <MenuItem key={a} id={a} className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">{actionLabel[a]}</MenuItem>
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
                <span className="text-fg-3">للعملاء <Amount minor={x.customerAmountMinor} currency={x.currency} showCurrency={false} className="text-fg-2" /></span>
                <span className="num text-fg-3">{x.count} معاملة</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {detailId !== null && <DetailPanel id={detailId} onClose={() => openDetail(null)} />}
    </div>
  );
}
