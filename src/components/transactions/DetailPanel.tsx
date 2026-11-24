import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MenuTrigger, Menu, MenuItem, Popover } from 'react-aria-components';
import { FileText, MoreHorizontal, Pencil, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { Transaction, TxnAction } from '@/lib/contract';
import { holdHint, holdStatus, txn as s, txnType } from '@/lib/strings';
import { formatBps } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { DateTime } from '@/components/ui/DateTime';
import { EmailViewer } from '@/components/emails/EmailViewer';
import { Breakdown, StatusBadge, fromTxn } from './bits';
import { actionLabel, useTxnActions } from './TxnActions';

const PRIMARY: TxnAction[] = ['confirm_review', 'approve', 'assign', 'set_fee', 'include'];

export function commissionHint(t: Transaction) {
  return t.commissionMode === 'percent' && t.commissionBps !== null ? formatBps(t.commissionBps) : t.commissionMode === 'fixed' ? 'ثابتة' : undefined;
}

export function DetailPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: t } = useQuery({ queryKey: ['txn', id], queryFn: () => api.txnGet(id) });
  const { data: history } = useQuery({ queryKey: ['txn_history', id], queryFn: () => api.txnHistory(id) });
  const actions = useTxnActions();
  const [emailOpen, setEmailOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!t) return null;
  const primary = PRIMARY.find((a) => t.allowedActions.includes(a));
  const rest = t.allowedActions.filter((a) => a !== primary && a !== 'edit_note' && !(t.needsReview && a === 'edit_details'));

  return (
    <aside className="fixed inset-y-3 left-3 z-30 flex w-[392px] flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-(--shadow-float)" aria-label="تفاصيل المعاملة">
      <header className="flex items-start justify-between gap-3 border-b border-line p-5">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-1.5">
            <StatusBadge status={t.status} />
            {t.type !== 'payment' && <Badge tone="neg">{txnType[t.type]}</Badge>}
            {t.source === 'manual' && <Badge tone="outline">يدوية</Badge>}
          </div>
          <div className="truncate text-[17px] font-medium"><bdi>{t.payerName ?? '—'}</bdi></div>
          {t.payerEmail && <div className="truncate text-[13px] text-fg-3"><bdi dir="ltr">{t.payerEmail}</bdi></div>}
        </div>
        <Button variant="quiet" size="icon" aria-label="إغلاق" onPress={onClose}><X /></Button>
      </header>

      <div className="flex-1 space-y-5 overflow-auto p-5">
        {t.needsReview && (
          <div className="rounded-card bg-warn-soft px-4 py-3 text-sm">
            <div className="font-medium text-warn">تحتاج مراجعة قبل الاعتماد</div>
            {t.reviewReasonAr && <div className="mt-0.5 text-fg-2">{t.reviewReasonAr}</div>}
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="secondary" onPress={() => actions.act('edit_details', t)}>تعديل البيانات</Button>
              {t.rawEmailId && <Button size="sm" variant="quiet" onPress={() => setEmailOpen(true)}>مقارنة بالرسالة</Button>}
            </div>
          </div>
        )}
        {t.holdStatus && (
          <div className="rounded-card border border-line px-4 py-3 text-sm">
            <div className="font-medium text-fg">{holdStatus[t.holdStatus]}</div>
            <div className="text-fg-3">{holdHint[t.holdStatus]}</div>
          </div>
        )}
        {t.refundedBy.length > 0 && (
          <div className="rounded-card bg-neg-soft px-4 py-3 text-sm text-neg">
            {s.refunded}: {t.refundedBy.map((r) => <span key={r.id}>{' '}<Amount minor={r.grossMinor} currency={t.currency} /></span>)}
            {t.status === 'approved' && <div className="mt-1 text-[13px] text-fg-2">راجع القيد العكسي المقترح في لوحة التحكم</div>}
          </div>
        )}
        {t.type === 'payment' && <Breakdown v={fromTxn(t, commissionHint(t))} />}
        {t.type !== 'payment' && (
          <div className="rounded-card bg-raised/60 p-4 text-sm text-fg-2">
            {txnType[t.type]} بقيمة <Amount minor={t.grossMinor} currency={t.currency} className="text-neg" /> للمعاملة <bdi dir="ltr" className="num">{t.relatedTxnId}</bdi>
          </div>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
          <dt className="text-fg-3">{s.cols.date}</dt><dd><DateTime iso={t.occurredAt} /></dd>
          <dt className="text-fg-3">{s.detail.paypalId}</dt><dd><bdi dir="ltr" className="num select-all text-fg-2">{t.paypalTxnId}</bdi></dd>
          <dt className="text-fg-3">{s.cols.customer}</dt><dd>{t.customer?.name ?? '—'}</dd>
          <dt className="text-fg-3">{s.detail.mailbox}</dt><dd>{t.mailbox?.label ?? 'إدخال يدوي'}</dd>
          {t.approvedAt && <><dt className="text-fg-3">اعتُمدت</dt><dd><DateTime iso={t.approvedAt} /></dd></>}
          {t.payerNote && <><dt className="text-fg-3">{s.cols.payerNote}</dt><dd><bdi>{t.payerNote}</bdi></dd></>}
        </dl>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[13px] text-fg-3">{s.detail.myNote}</span>
            <Button size="sm" variant="quiet" onPress={() => actions.act('edit_note', t)}><Pencil />تعديل</Button>
          </div>
          <p className={t.note ? 'text-sm text-fg' : 'text-sm text-fg-3'}>{t.note ?? 'لا ملاحظة'}</p>
        </div>

        <div>
          <div className="mb-2 text-[13px] text-fg-3">{s.detail.history}</div>
          <ol className="space-y-3 border-s border-line ps-4">
            {history?.map((h) => (
              <li key={h.id} className="relative text-sm">
                <span className="absolute -start-[21px] top-2 size-2 rounded-full border-2 border-surface bg-line-strong" aria-hidden />
                <div className="text-fg-2">{h.labelAr}</div>
                <DateTime iso={h.createdAt} className="text-[12.5px] text-fg-3" />
              </li>
            ))}
          </ol>
        </div>
      </div>

      <footer className="flex gap-2 border-t border-line p-4">
        {primary === 'approve' && (
          <Button variant="primary" className="flex-1" onPress={() => actions.act('approve', t)}>
            اعتماد <Amount minor={t.customerAmountMinor} currency={t.currency} className="[&_span]:text-accent-fg/75" />
          </Button>
        )}
        {primary && primary !== 'approve' && <Button variant="primary" className="flex-1" onPress={() => actions.act(primary, t)}>{actionLabel[primary]}</Button>}
        {t.rawEmailId && <Button variant="secondary" onPress={() => setEmailOpen(true)} className={primary ? '' : 'flex-1'}><FileText />{s.detail.viewEmail}</Button>}
        {rest.length > 0 && (
          <MenuTrigger>
            <Button variant="secondary" size="icon" aria-label="إجراءات أخرى" className="size-9"><MoreHorizontal /></Button>
            <Popover placement="top end" className="min-w-48 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
              <Menu className="outline-none" onAction={(k) => actions.act(k as TxnAction, t)}>
                {rest.map((a) => (
                  <MenuItem key={a} id={a} className={`flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised ${a === 'unapprove' ? 'text-neg' : ''}`}>{actionLabel[a]}</MenuItem>
                ))}
              </Menu>
            </Popover>
          </MenuTrigger>
        )}
      </footer>
      {emailOpen && t.rawEmailId && <EmailViewer id={t.rawEmailId} onClose={() => setEmailOpen(false)} />}
    </aside>
  );
}
