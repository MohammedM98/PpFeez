import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Tabs, TabList, Tab, MenuTrigger, Menu, MenuItem, Popover, type Selection, type Key } from 'react-aria-components';
import { ChevronLeft, ChevronRight, MoreHorizontal, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import type { BulkResult, ParseStatus, RawEmailSummary } from '@/lib/contract';
import { parseStatus } from '@/lib/strings';
import { formatDateTime } from '@/lib/dates';
import { useAction } from '@/lib/useAction';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/Field';
import { Table, TableHeader, Column, TableBody, Row, Cell } from '@/components/ui/Table';
import { Trunc } from '@/components/ui/Trunc';
import { Dialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { EmailViewer } from '@/components/emails/EmailViewer';
import { useTxnActions } from '@/components/transactions/TxnActions';

const TABS: ParseStatus[] = ['failed', 'ignored', 'parsed'];
const PAGE_SIZE = 50;

export function EmailsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<ParseStatus>('failed');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Selection>(new Set());
  const [viewing, setViewing] = useState<RawEmailSummary | null>(null);
  const [report, setReport] = useState<BulkResult | null>(null);
  const actions = useTxnActions();
  const { run, pending } = useAction();
  useEffect(() => { const t = setTimeout(() => setQ(search), 220); return () => clearTimeout(t); }, [search]);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [tab, q]);

  const list = useQuery({
    queryKey: ['emails', tab, q, page],
    queryFn: () => api.emailsList({ status: tab, search: q || undefined, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const counts = useQuery({
    queryKey: ['emails', 'counts'],
    queryFn: async () => Object.fromEntries(await Promise.all(TABS.map(async (s) => [s, (await api.emailsList({ status: s, page: 1, pageSize: 1 })).total]))) as Record<ParseStatus, number>,
  });
  const items = list.data?.items ?? [];
  const ids = selected === 'all' ? items.map((e) => e.id) : [...selected].map(Number);
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));

  const reparse = async (list: number[]) => {
    const r = await run(() => api.emailReparse(list));
    if (!r.ok) return;
    setSelected(new Set());
    if (r.value.failed.length === 0) toast.ok(`أُعيد تحليل ${r.value.ok.length} رسالة بنجاح`);
    else setReport(r.value);
  };
  const createTxn = (e: RawEmailSummary) => {
    setViewing(null);
    actions.open({ kind: 'manual', rawEmailId: e.id, prefill: { occurredAt: formatDateTime(e.receivedAt) } });
  };
  const ignore = (e: RawEmailSummary) => { setViewing(null); void run(() => api.emailSetIgnored(e.id), 'نُقلت الرسالة إلى المتجاهلة'); };
  const onMenu = (e: RawEmailSummary, k: Key) => {
    if (k === 'view') setViewing(e);
    if (k === 'reparse') void reparse([e.id]);
    if (k === 'create') createTxn(e);
    if (k === 'ignore') ignore(e);
    if (k === 'txn') navigate(`/transactions?detail=${e.transactionId}`);
  };

  return (
    <div className="mx-auto flex min-h-full max-w-[1560px] flex-col px-6 pb-8 pt-6">
      <PageHeader title="الرسائل" subtitle="رسائل PayPal المسحوبة من البريد ونتيجة قراءتها" />

      <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as ParseStatus)} className="mb-4">
        <TabList aria-label="حالة الرسالة" className="flex gap-1 border-b border-line">
          {TABS.map((k) => (
            <Tab key={k} id={k} className={({ isSelected }) => cx(
              'relative -mb-px flex h-10 cursor-default items-center gap-2 px-3 text-sm outline-none transition-colors duration-150',
              'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
              isSelected ? 'text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent' : 'text-fg-3 hover:text-fg-2')}>
              {parseStatus[k]}
              <span className={cx('num text-[12.5px]', k === 'failed' && (counts.data?.failed ?? 0) > 0 ? 'text-warn' : 'text-fg-3')}>{counts.data?.[k] ?? ''}</span>
            </Tab>
          ))}
        </TabList>
      </Tabs>

      <div className="mb-4 flex items-center gap-2">
        <SearchField label="بحث بالموضوع أو المرسل" value={search} onChange={setSearch} className="w-[320px]" />
        {tab === 'failed' && (
          <Button variant="secondary" className="ms-auto" isPending={pending} isDisabled={items.length === 0} onPress={() => reparse(ids.length ? ids : items.map((e) => e.id))}>
            <RefreshCw />{ids.length ? `إعادة تحليل المحدّد (${ids.length})` : 'إعادة تحليل الكل'}
          </Button>
        )}
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <Table aria-label="الرسائل" selectionMode={tab === 'failed' ? 'multiple' : 'none'} selectionBehavior="toggle" selectedKeys={selected} onSelectionChange={setSelected}
          onRowAction={(k) => { const e = items.find((x) => x.id === Number(k)); if (e) setViewing(e); }}>
          <TableHeader>
            <Column isRowHeader>التاريخ</Column>
            <Column>من</Column>
            <Column>الموضوع</Column>
            <Column>{tab === 'parsed' ? 'المحلّل' : 'السبب'}</Column>
            <Column>البريد</Column>
            <Column><span className="sr-only">إجراءات</span></Column>
          </TableHeader>
          <TableBody items={items} renderEmptyState={() => (
            <div className="py-16 text-center text-fg-2">{tab === 'failed' ? 'لا رسائل فاشلة. كل ما سُحب قُرئ' : 'لا رسائل هنا'}</div>
          )}>
            {(e) => (
              <Row id={e.id}>
                <Cell><bdi dir="ltr" className="num whitespace-nowrap text-fg-2">{formatDateTime(e.receivedAt)}</bdi></Cell>
                <Cell className="max-w-[220px]"><Trunc className="text-fg-2">{e.fromAddr}</Trunc></Cell>
                <Cell className="max-w-[340px]"><Trunc>{e.subject}</Trunc></Cell>
                <Cell className="max-w-[260px]">
                  {tab === 'parsed'
                    ? <span className="text-[13px] text-fg-3">{e.transactionId ? 'أنشأت معاملة' : '—'}</span>
                    : <span className={cx('text-[13px]', tab === 'failed' ? 'text-warn' : 'text-fg-2')}>{e.parseReasonAr ?? e.parseReason ?? '—'}</span>}
                </Cell>
                <Cell className="whitespace-nowrap text-[13px] text-fg-3">{e.mailboxLabel}</Cell>
                <Cell className="w-12 pe-2">
                  <MenuTrigger>
                    <Button variant="quiet" size="icon" aria-label="إجراءات"><MoreHorizontal /></Button>
                    <Popover placement="bottom end" className="min-w-56 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                      <Menu className="outline-none" onAction={(k) => onMenu(e, k)}>
                        <MenuItem id="view" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">عرض الرسالة</MenuItem>
                        {e.transactionId !== null && <MenuItem id="txn" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">فتح المعاملة</MenuItem>}
                        {e.parseStatus !== 'parsed' && <MenuItem id="reparse" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">إعادة التحليل</MenuItem>}
                        {e.transactionId === null && <MenuItem id="create" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">إنشاء معاملة يدوياً منها</MenuItem>}
                        {e.parseStatus === 'failed' && <MenuItem id="ignore" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">تجاهل</MenuItem>}
                      </Menu>
                    </Popover>
                  </MenuTrigger>
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
      </div>

      {pages > 1 && (
        <nav className="mt-3 flex items-center justify-end gap-1 text-[13px] text-fg-3" aria-label="الصفحات">
          <Button size="sm" variant="quiet" isDisabled={page <= 1} onPress={() => setPage(page - 1)}><ChevronRight />السابقة</Button>
          <span className="num px-2">{page} / {pages}</span>
          <Button size="sm" variant="quiet" isDisabled={page >= pages} onPress={() => setPage(page + 1)}>التالية<ChevronLeft /></Button>
        </nav>
      )}

      {viewing && (
        <EmailViewer id={viewing.id} onClose={() => setViewing(null)} actions={viewing.transactionId === null && (
          <span className="me-auto flex gap-2">
            <Button variant="primary" onPress={() => createTxn(viewing)}>إنشاء معاملة يدوياً منها</Button>
            {viewing.parseStatus === 'failed' && <Button variant="quiet" onPress={() => ignore(viewing)}>تجاهل</Button>}
          </span>
        )} />
      )}
      {report && (
        <Dialog isOpen onOpenChange={(o) => !o && setReport(null)} title={`إعادة التحليل: نجح ${report.ok.length}، فشل ${report.failed.length}`} width="md"
          footer={<Button variant="primary" onPress={() => setReport(null)}>تم</Button>}>
          <ul className="divide-y divide-line rounded-card border border-line">
            {report.failed.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <Trunc className="min-w-0 flex-1">{items.find((x) => x.id === f.id)?.subject ?? `#${f.id}`}</Trunc>
                <span className="shrink-0 text-neg">{f.messageAr}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[13px] text-fg-3">أنشئ معاملة يدوياً من الرسالة إن بقي القالب غير معروف</p>
        </Dialog>
      )}
    </div>
  );
}
