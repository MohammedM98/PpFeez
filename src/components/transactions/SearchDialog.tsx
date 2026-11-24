import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Autocomplete, Dialog, Input, ListBox, ListBoxItem, Modal, ModalOverlay, SearchField } from 'react-aria-components';
import { FileSpreadsheet, Search } from 'lucide-react';
import { api } from '@/lib/api';
import type { AppError, Transaction, TxnLocation, TxnSearchHit } from '@/lib/contract';
import { formatDateTime } from '@/lib/dates';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { Trunc } from '@/components/ui/Trunc';
import { cx } from '@/components/ui/cx';
import { excelWhy, movesLabel, sendUnexported } from '@/components/customers/CustomerExcel';

type Item = { id: string; cmd: { customerId: number; customerName: string; pending: number; notExported: number; lastError: AppError | null } } | { id: string; hit: TxnSearchHit };

/** Opens the search from anywhere (the inbox's search box, Ctrl+K). */
export const openSearch = () => window.dispatchEvent(new Event('ppfeez:search'));

export function locationLabel(l: TxnLocation): string {
  if (l.kind === 'inbox') return 'الوارد';
  if (l.kind === 'excluded') return 'مستبعدة';
  return `${l.customerName} · ${l.status === 'approved' ? 'معتمدة' : 'بانتظار الموافقة'}`;
}

/** Where a transaction lives now (SPEC 6.3), from the transaction itself. */
export function txnHref(t: Transaction): string {
  if ((t.status === 'pending_approval' || t.status === 'approved') && t.customer) return `/customers/${t.customer.id}?tab=${t.status === 'approved' ? t.currency : 'pending'}&detail=${t.id}`;
  return `/transactions?tab=${t.status === 'excluded' ? 'excluded' : 'unassigned'}&detail=${t.id}`;
}

/** Where a result opens: the inbox tab, or the customer's transactions tab, on that row. */
export function locationHref({ txn, location: l }: TxnSearchHit): string {
  if (l.kind === 'customer') return `/customers/${l.customerId}?tab=${l.status === 'approved' ? txn.currency : 'pending'}&detail=${txn.id}`;
  return `/transactions?tab=${l.kind === 'excluded' ? 'excluded' : 'unassigned'}&detail=${txn.id}`;
}

/**
 * SPEC 6.3 global search: every transaction in every state, by PayPal id, payer, e-mail, payer note
 * or amount. Each result says where the transaction lives and opens it there.
 */
export function SearchDialog() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [isOpen, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(t); }, [text]);

  useEffect(() => {
    const open = () => { setText(''); setQ(''); setOpen(true); };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
    };
    window.addEventListener('ppfeez:search', open);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('ppfeez:search', open); window.removeEventListener('keydown', onKey); };
  }, []);

  const results = useQuery({
    queryKey: ['txn_search_all', q],
    queryFn: () => api.txnSearchAll(q, 50),
    enabled: isOpen && q.length >= 2,
    placeholderData: keepPreviousData,
  });
  const hits = q.length >= 2 ? results.data ?? [] : [];
  // commands (SPEC 6.8.3): "إرسال غير المُصدَّر لـ …" for each customer whose file is behind
  const unexported = useQuery({ queryKey: ['customer_excel_unexported_summary'], queryFn: api.customerExcelUnexportedSummary, enabled: isOpen });
  const plain = (x: string) => x.replace(/[\u064B-\u0652]/g, '').toLowerCase();
  const typed = plain(text.trim());
  const cmds = typed ? (unexported.data ?? []).filter((c) => {
    const label = plain(`إرسال غير المُصدَّر لـ ${c.customerName} excel اكسل إكسل تصدير`);
    return typed.split(/\s+/).every((w) => label.includes(w));
  }) : [];
  const items: Item[] = [...cmds.map((c) => ({ id: `cmd-${c.customerId}`, cmd: c })), ...hits.map((h) => ({ id: `t-${h.txn.id}`, hit: h }))];

  const go = (hit: TxnSearchHit) => {
    setOpen(false);
    navigate(locationHref(hit));
  };
  const act = (key: string) => {
    const it = items.find((x) => x.id === key);
    if (!it) return;
    if ('hit' in it) { go(it.hit); return; }
    setOpen(false);
    void sendUnexported(it.cmd.customerId, qc, it.cmd.customerName);
  };

  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={setOpen} isDismissable
      className="fixed inset-0 z-50 flex justify-center bg-black/55 px-6 pt-[12vh] transition-opacity duration-150 data-[entering]:opacity-0 data-[exiting]:opacity-0">
      <Modal className="h-fit w-[640px] max-w-full overflow-hidden rounded-panel border border-line bg-surface shadow-(--shadow-float)">
        <Dialog aria-label="البحث في كل المعاملات" className="outline-none">
          <Autocomplete inputValue={text} onInputChange={setText}>
            <SearchField aria-label="البحث في كل المعاملات" autoFocus className="flex items-center gap-2 border-b border-line px-4">
              <Search className="size-[18px] shrink-0 text-fg-3" strokeWidth={1.7} />
              <Input placeholder="رقم المعاملة، المرسل، الإيميل، الملاحظة أو المبلغ"
                className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden" />
              <kbd className="num rounded border border-line px-1.5 text-[11.5px] text-fg-3">Esc</kbd>
            </SearchField>
            <ListBox aria-label="نتائج البحث" items={items} onAction={(k) => act(String(k))}
              className="max-h-[56vh] overflow-auto p-1.5 outline-none"
              renderEmptyState={() => (
                <p className="px-3 py-8 text-center text-sm text-fg-3">
                  {text.trim().length < 2 ? 'اكتب حرفين على الأقل. يبحث في كل المعاملات: الوارد والمستبعدة وصفحات العملاء' : results.isFetching ? 'جارٍ البحث…' : 'لا معاملة بهذا البحث'}
                </p>
              )}>
              {(it) => 'cmd' in it ? (
                <ListBoxItem id={it.id} textValue={`إرسال غير المُصدَّر لـ ${it.cmd.customerName}`}
                  className="flex cursor-default items-center gap-3 rounded-ctl px-3 py-2 outline-none data-[focused]:bg-raised">
                  <FileSpreadsheet className="size-[18px] shrink-0 text-fg-3" strokeWidth={1.6} />
                  <div className="min-w-0 flex-1">
                    <Trunc className="text-sm text-fg">إرسال غير المُصدَّر لـ {it.cmd.customerName}</Trunc>
                    <div className="text-[12px] text-fg-3">{movesLabel(it.cmd.pending + it.cmd.notExported)} ليست في ملفه{it.cmd.lastError ? ` · ${excelWhy(it.cmd.lastError)}` : ''}</div>
                  </div>
                  <Badge tone="outline" className="shrink-0">أمر</Badge>
                </ListBoxItem>
              ) : ((h) => (
                <ListBoxItem id={it.id} textValue={h.txn.payerName || h.txn.payerEmail || h.txn.paypalTxnId}
                  className="flex cursor-default items-center gap-3 rounded-ctl px-3 py-2 outline-none data-[focused]:bg-raised">
                  <div className="min-w-0 flex-1">
                    <Trunc className="text-sm text-fg">{h.txn.payerName || h.txn.payerEmail || '—'}</Trunc>
                    <div className="flex items-center gap-2 text-[12px] text-fg-3">
                      <span className="num" dir="ltr">{formatDateTime(h.txn.occurredAt)}</span>
                      <span className="num truncate" dir="ltr">{h.txn.paypalTxnId}</span>
                    </div>
                  </div>
                  <Badge tone={h.location.kind === 'customer' ? (h.location.status === 'approved' ? 'pos' : 'accent') : h.location.kind === 'excluded' ? 'outline' : 'neutral'}
                    className={cx('max-w-[200px] shrink-0 overflow-hidden')}>
                    <span className="truncate">{locationLabel(h.location)}</span>
                  </Badge>
                  <Amount minor={h.txn.grossMinor} currency={h.txn.currency} className="shrink-0 text-sm" />
                </ListBoxItem>
              ))(it.hit)}
            </ListBox>
          </Autocomplete>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
