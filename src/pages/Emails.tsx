import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
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
import { Table, TableFrame, TableHeader, Column, TableBody, Row, Cell, SELECT_W, sumWidths, tablePage } from '@/components/ui/Table';
import { DateCell } from '@/components/transactions/bits';
import { txnHref } from '@/components/transactions/SearchDialog';
import { Trunc } from '@/components/ui/Trunc';
import { Dialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { EmailViewer } from '@/components/emails/EmailViewer';
import { useTxnActions } from '@/components/transactions/TxnActions';

const TABS: ParseStatus[] = ['failed', 'ignored', 'parsed'];

/** Arabic counted noun: واحدة / dual / 3–10 plural / 11+ singular. */
function ignoredCountAr(n: number) {
  if (n === 1) return 'رسالة متجاهلة واحدة';
  if (n === 2) return 'رسالتان متجاهلتان';
  return n <= 10 ? `${n} رسائل متجاهلة` : `${n} رسالة متجاهلة`;
}
const PAGE_SIZE = 50;

export function EmailsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<ParseStatus>((params.get('tab') as ParseStatus) || 'failed');
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
  const selectable = tab !== 'parsed';
  const EW = useMemo(() => {
    const w = { date: '100px', from: '160px', reason: tab === 'parsed' ? '130px' : '220px', mailbox: '104px', menu: '48px' };
    return { ...w, min: sumWidths([...(selectable ? [SELECT_W] : []), ...Object.values(w), '140px']) };
  }, [tab, selectable]);
  const ids = selected === 'all' ? items.map((e) => e.id) : [...selected].map(Number);
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));

  const unknown = useQuery({ queryKey: ['unknown_paypal_domains'], queryFn: api.unknownPaypalDomains });
  // Only the sender host is stored: table rows are memoised, so the domain and its count are
  // resolved against the latest unknown_paypal_domains list when the dialog renders.
  const [trustHost, setTrustHost] = useState<string | null>(null);
  const domainFor = (e: RawEmailSummary) => (e.fromAddr.split('@')[1] ?? e.fromAddr).toLowerCase();
  const setTrusting = setTrustHost;
  const trusting = (() => {
    if (!trustHost) return null;
    const hit = unknown.data?.find((d) => trustHost === d.domain || trustHost.endsWith('.' + d.domain));
    return hit ?? { domain: trustHost, count: 0 };
  })();
  const trust = async () => {
    if (!trusting) return;
    const r = await run(() => api.paypalDomainTrust(trusting.domain));
    if (!r.ok) return;
    setTrusting(null);
    const { ok, failed } = r.value.reparsed;
    if (failed.length === 0) toast.ok(`أصبح ${r.value.domain} موثوقاً`, `أُعيد تحليل ${ok.length} ${ok.length === 1 ? 'رسالة' : 'رسائل'} بنجاح. راجع المعاملات الجديدة`);
    else setReport(r.value.reparsed);
  };

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
    if (k === 'txn' && e.transactionId !== null) void api.txnGet(e.transactionId).then((t) => navigate(txnHref(t)), () => toast.error('المعاملة غير موجودة'));
    if (k === 'trust') setTrusting(domainFor(e));
  };

  return (
    <div className={cx(tablePage, 'max-w-[1560px]')}>
      <PageHeader compact title="الرسائل" subtitle="رسائل PayPal المسحوبة من البريد ونتيجة قراءتها" />

      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line">
        <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as ParseStatus)}>
          <TabList aria-label="حالة الرسالة" className="flex gap-1">
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
        <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
          <SearchField label="بحث بالموضوع أو المرسل" value={search} onChange={setSearch} className="w-[280px]" />
          {tab !== 'parsed' && (
            <Button variant="secondary" size="sm" className="ms-auto" isPending={pending} isDisabled={items.length === 0} onPress={() => reparse(ids.length ? ids : items.map((e) => e.id))}>
              <RefreshCw />{ids.length ? `إعادة تحليل المحدّد (${ids.length})` : 'إعادة تحليل الكل'}
            </Button>
          )}
        </div>
      </div>

      <TableFrame fill>
        <Table aria-label="الرسائل" selectionMode={selectable ? 'multiple' : 'none'} selectionBehavior="toggle" selectedKeys={selected} onSelectionChange={setSelected}
          onRowAction={(k) => { const e = items.find((x) => x.id === Number(k)); if (e) setViewing(e); }} minWidth={EW.min}>
          <TableHeader>
            <Column isRowHeader width={EW.date} sticky="start" stickyOffset={selectable ? SELECT_W : '0px'}>التاريخ</Column>
            <Column width={EW.from}>من</Column>
            <Column>الموضوع</Column>
            <Column width={EW.reason}>{tab === 'parsed' ? 'النتيجة' : 'السبب'}</Column>
            <Column width={EW.mailbox}>البريد</Column>
            <Column width={EW.menu} sticky="end"><span className="sr-only">إجراءات</span></Column>
          </TableHeader>
          <TableBody items={items} renderEmptyState={() => (
            <div className="py-16 text-center text-fg-2">{tab === 'failed' ? 'لا رسائل فاشلة. كل ما سُحب قُرئ' : 'لا رسائل هنا'}</div>
          )}>
            {(e) => (
              <Row id={e.id}>
                <Cell sticky="start" stickyOffset={selectable ? SELECT_W : '0px'}><DateCell iso={e.receivedAt} /></Cell>
                <Cell><Trunc className="text-fg-2">{e.fromAddr}</Trunc></Cell>
                <Cell><Trunc>{e.subject}</Trunc></Cell>
                <Cell>
                  {tab === 'parsed'
                    ? <span className="text-[13px] text-fg-3">{e.transactionId ? 'أنشأت معاملة' : '—'}</span>
                    : e.parseReason === 'unknown_paypal_domain'
                      ? <span className="flex items-center gap-2 text-[13px] text-warn">
                          <Trunc className="min-w-0 flex-1">{e.parseReasonAr ?? 'نطاق PayPal غير معروف'}</Trunc>
                          <Button size="sm" variant="secondary" className="h-7 shrink-0" onPress={() => setTrusting(domainFor(e))}>الوثوق بهذا النطاق</Button>
                        </span>
                      : e.parseReason === 'deleted_by_user'
                        ? <Trunc className="text-[13px] text-fg-2" title="حُذفت يدوياً. إعادة التحليل تعيدها معاملة غير مخصّصة">حُذفت يدوياً <span className="text-fg-3">(إعادة التحليل تعيدها)</span></Trunc>
                        : <Trunc className={cx('text-[13px]', tab === 'failed' ? 'text-warn' : 'text-fg-2')}>{e.parseReasonAr ?? e.parseReason ?? '—'}</Trunc>}
                </Cell>
                <Cell><Trunc className="text-[13px] text-fg-3">{e.mailboxLabel}</Trunc></Cell>
                <Cell sticky="end" className="pe-2">
                  <MenuTrigger>
                    <Button variant="quiet" size="icon" aria-label="إجراءات"><MoreHorizontal /></Button>
                    <Popover placement="bottom end" className="min-w-56 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                      <Menu className="outline-none" onAction={(k) => onMenu(e, k)}>
                        <MenuItem id="view" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">عرض الرسالة</MenuItem>
                        {e.transactionId !== null && <MenuItem id="txn" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">فتح المعاملة</MenuItem>}
                        {e.parseStatus !== 'parsed' && <MenuItem id="reparse" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">إعادة التحليل</MenuItem>}
                        {e.transactionId === null && <MenuItem id="create" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">إنشاء معاملة يدوياً منها</MenuItem>}
                        {e.parseReason === 'unknown_paypal_domain' && <MenuItem id="trust" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">الوثوق بهذا النطاق</MenuItem>}
                        {e.parseStatus === 'failed' && <MenuItem id="ignore" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">تجاهل</MenuItem>}
                      </Menu>
                    </Popover>
                  </MenuTrigger>
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
      </TableFrame>

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
            {viewing.parseReason === 'unknown_paypal_domain'
              ? <Button variant="primary" onPress={() => { setViewing(null); setTrusting(domainFor(viewing)); }}>الوثوق بهذا النطاق</Button>
              : <Button variant="primary" onPress={() => createTxn(viewing)}>إنشاء معاملة يدوياً منها</Button>}
            {viewing.parseStatus === 'failed' && <Button variant="quiet" onPress={() => ignore(viewing)}>تجاهل</Button>}
          </span>
        )} />
      )}
      {trusting && (
        <Dialog isOpen onOpenChange={(o) => !o && setTrusting(null)} title="الوثوق بنطاق PayPal" width="md"
          footer={<>
            <Button variant="secondary" onPress={() => setTrusting(null)}>تراجع</Button>
            <Button variant="primary" isPending={pending} onPress={trust}>الوثوق وإعادة التحليل</Button>
          </>}>
          <div className="flex flex-col gap-3 text-sm text-fg-2">
            <div className="rounded-card bg-raised/60 px-4 py-4 text-center">
              <bdi dir="ltr" className="text-[22px] font-medium text-fg">{trusting.domain}</bdi>
              {trusting.count > 0 && <div className="mt-1 text-[13px] text-fg-3">{ignoredCountAr(trusting.count)} من هذا النطاق</div>}
            </div>
            <p>رسائله موقّعة توقيعاً صحيحاً لكنه ليس في قائمة نطاقات PayPal المعروفة. ثق به فقط إن كان نطاق PayPal في بلدك أو بلد من يرسل لك.</p>
            <p>يُضاف إلى «نطاقات PayPal الإضافية» في الإعدادات، وتُعاد قراءة رسائله المتجاهلة. يمكنك حذفه من هناك لاحقاً.</p>
          </div>
        </Dialog>
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
