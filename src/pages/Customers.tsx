import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MenuTrigger, Menu, MenuItem, Popover, type Key } from 'react-aria-components';
import { MoreHorizontal, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import type { Customer, CustomerInput } from '@/lib/contract';
import { bpsToPercentText, formatAmount, formatBps, percentTextToBps } from '@/lib/money';
import { useAction } from '@/lib/useAction';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { SearchField, Checkbox } from '@/components/ui/Field';
import { Segmented } from '@/components/ui/Segmented';
import { Table, TableFrame, TableHeader, Column, TableBody, Row, Cell, sumWidths } from '@/components/ui/Table';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/TextField';
import { Trunc } from '@/components/ui/Trunc';
import { cx } from '@/components/ui/cx';
import { DangerConfirm, deletedToast } from '@/components/ui/DangerConfirm';

type ActiveFilter = 'active' | 'inactive' | 'all';

/** Customers table: the name keeps its place, the balance column takes the remaining width. */
const W = { name: '190px', phone: '150px', commission: '112px', pending: '136px', menu: '48px' };
const CW = { ...W, min: sumWidths([...Object.values(W), '180px']) };

/**
 * One chip per currency; red when the customer owes (negative balance). `oneLine` (tables)
 * shows two chips and "+N" for the rest, with every balance in the tooltip, so a row never grows.
 */
export function BalanceChips({ c, oneLine }: { c: Pick<Customer, 'balances'>; oneLine?: boolean }) {
  const nonZero = c.balances.filter((b) => b.minor !== 0);
  if (nonZero.length === 0) return <span className="text-fg-3">لا رصيد</span>;
  const shown = oneLine && nonZero.length > 2 ? nonZero.slice(0, 2) : nonZero;
  const rest = nonZero.length - shown.length;
  return (
    <div className={cx('gap-1.5', oneLine ? 'inline-flex flex-nowrap' : 'flex flex-wrap')}
      title={oneLine ? nonZero.map((b) => formatAmount(b.minor, b.currency)).join('\n') : undefined}>
      {rest > 0 && <span className="num inline-flex h-7 items-center rounded-[6px] bg-raised px-2 text-[13px] text-fg-2">+{rest}</span>}
      {shown.map((b) => (
        <span key={b.currency} className={cx('inline-flex h-7 items-center rounded-[6px] px-2 text-[13.5px]', b.minor < 0 ? 'bg-neg-soft text-neg' : 'bg-raised text-fg')}>
          <Amount minor={b.minor} currency={b.currency} className={b.minor < 0 ? '[&_span]:text-neg/80' : ''} />
          {b.minor < 0 && <span className="ms-1.5 text-[12px]">عليه</span>}
        </span>
      ))}
    </div>
  );
}

export function CustomersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [params, setParams] = useSearchParams();
  const [active, setActive] = useState<ActiveFilter>('active');
  // dashboard "بانتظار الموافقة" opens this list filtered (SPEC 6.2)
  const pendingOnly = params.get('pending') === '1';
  const setPendingOnly = (v: boolean) => {
    const p = new URLSearchParams(params);
    if (v) p.set('pending', '1'); else p.delete('pending');
    setParams(p, { replace: true });
  };
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const { run } = useAction();
  useEffect(() => { const t = setTimeout(() => setQ(search), 200); return () => clearTimeout(t); }, [search]);

  const list = useQuery({
    queryKey: ['customers', { q, active, pendingOnly }],
    queryFn: () => api.customersList({ search: q || undefined, active: active === 'all' ? undefined : active === 'active', hasPending: pendingOnly || undefined }),
  });

  const onMenu = (c: Customer, k: Key) => {
    if (k === 'ledger') navigate(`/customers/${c.id}`);
    if (k === 'edit') setEditing(c);
    if (k === 'delete') setDeleting(c);
    if (k === 'toggle') void run(() => api.customerSetActive(c.id, !c.isActive), c.isActive ? `عُطّل ${c.name}` : `فُعّل ${c.name}`);
  };

  return (
    <div className="mx-auto flex min-h-full max-w-[1560px] flex-col px-6 pb-8 pt-6">
      <PageHeader title="العملاء" subtitle="أرصدة كل عميل لكل عملة، وما ينتظر موافقته"
        actions={<Button variant="primary" onPress={() => setEditing('new')}><Plus />إضافة عميل</Button>} />

      <div className="mb-4 flex items-center gap-2">
        <SearchField label="بحث بالاسم أو الهاتف" value={search} onChange={setSearch} className="w-[300px]" />
        <Segmented label="الحالة" value={active} onChange={setActive} className="w-[240px]"
          options={[{ id: 'active', label: 'النشطون' }, { id: 'inactive', label: 'المعطّلون' }, { id: 'all', label: 'الكل' }]} />
        <Checkbox isSelected={pendingOnly} onChange={setPendingOnly} className="ms-2">لديهم بانتظار الموافقة</Checkbox>
      </div>

      <TableFrame>
        <Table aria-label="العملاء" onRowAction={(k) => navigate(pendingOnly ? `/customers/${k}?tab=pending` : `/customers/${k}`)} minWidth={CW.min}>
          <TableHeader>
            <Column isRowHeader width={CW.name} sticky="start">الاسم</Column>
            <Column width={CW.phone}>الهاتف</Column>
            <Column align="end" width={CW.commission}>العمولة الافتراضية</Column>
            <Column align="end">الرصيد</Column>
            <Column align="end" width={CW.pending}>بانتظار الموافقة</Column>
            <Column width={CW.menu} sticky="end"><span className="sr-only">إجراءات</span></Column>
          </TableHeader>
          <TableBody items={list.data ?? []} renderEmptyState={() => (
            <div className="py-16 text-center">
              <p className="text-fg-2">{pendingOnly ? 'لا عميل لديه معاملات بانتظار الموافقة' : q ? 'لا عميل بهذا الاسم' : active === 'inactive' ? 'لا عملاء معطّلون' : 'لا عملاء بعد'}</p>
              {!q && !pendingOnly && active !== 'inactive' && <Button variant="secondary" className="mt-3" onPress={() => setEditing('new')}><Plus />إضافة أول عميل</Button>}
            </div>
          )}>
            {(c) => (
              <Row id={c.id} className="cursor-default">
                <Cell sticky="start">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <Trunc className={c.isActive ? 'text-fg' : 'text-fg-3'}>{c.name}</Trunc>
                      {c.notes && <Trunc className="text-[12px] text-fg-3">{c.notes}</Trunc>}
                    </div>
                    {!c.isActive && <Badge tone="outline" className="shrink-0">معطّل</Badge>}
                  </div>
                </Cell>
                <Cell>{c.phone ? <div dir="ltr" className="num truncate text-right text-fg-2" title={c.phone}>{c.phone}</div> : <span className="text-fg-3">—</span>}</Cell>
                <Cell align="end"><bdi dir="ltr" className="num text-fg-2">{formatBps(c.defaultCommissionBps)}</bdi></Cell>
                <Cell align="end"><BalanceChips c={c} oneLine /></Cell>
                <Cell align="end">{c.pendingCount > 0 ? <Badge tone="accent"><span className="num">{c.pendingCount}</span></Badge> : <span className="text-fg-3">—</span>}</Cell>
                <Cell sticky="end" className="pe-2">
                  <MenuTrigger>
                    <Button variant="quiet" size="icon" aria-label="إجراءات"><MoreHorizontal /></Button>
                    <Popover placement="bottom end" className="min-w-44 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                      <Menu className="outline-none" onAction={(k) => onMenu(c, k)}>
                        <MenuItem id="ledger" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">فتح الدفتر</MenuItem>
                        <MenuItem id="edit" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">تعديل</MenuItem>
                        <MenuItem id="toggle" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">{c.isActive ? 'تعطيل' : 'تفعيل'}</MenuItem>
                        <MenuItem id="delete" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm text-neg outline-none data-[focused]:bg-raised">حذف العميل</MenuItem>
                      </Menu>
                    </Popover>
                  </MenuTrigger>
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
      </TableFrame>
      <p className="mt-3 text-[12.5px] text-fg-3">تعطيل العميل يخفيه من قوائم التخصيص ويُبقي دفتره وأرصدته</p>

      {editing && <CustomerDialog customer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteCustomerDialog customer={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

export function CustomerDialog({ customer, onClose, onCreated }: { customer: Customer | null; onClose: () => void; onCreated?: (c: Customer) => void }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [pct, setPct] = useState(customer ? bpsToPercentText(customer.defaultCommissionBps) : '');
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [isActive, setIsActive] = useState(customer?.isActive ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { run, pending } = useAction();

  useEffect(() => {
    if (!customer && pct === '' && settings.data) setPct(bpsToPercentText(settings.data.defaultCommissionBps));
  }, [settings.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const bps = percentTextToBps(pct);
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'الاسم إلزامي';
    if (bps === null) e.defaultCommissionBps = 'نسبة بين 0 و100';
    setErrors(e);
    if (Object.keys(e).length) return;
    const input: CustomerInput = { name: name.trim(), phone: phone.trim() || null, defaultCommissionBps: bps!, notes: notes.trim() || null, isActive };
    const r = customer
      ? await run(() => api.customerUpdate(customer.id, input), 'حُفظ العميل')
      : await run(() => api.customerCreate(input), `أُضيف ${input.name}`);
    if (r.ok) { if (!customer) onCreated?.(r.value); onClose(); }
    else if (r.error.field) setErrors({ [r.error.field]: r.error.messageAr });
  };

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={customer ? `تعديل ${customer.name}` : 'إضافة عميل'}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" onPress={submit} isPending={pending}>{customer ? 'حفظ' : 'إضافة'}</Button>
      </>}>
      <div className="grid grid-cols-2 gap-4">
        <TextField label="الاسم" value={name} onChange={(v) => { setName(v); setErrors({ ...errors, name: '' }); }} isRequired autoFocus errorMessage={errors.name} description="فريد، يظهر في قوائم التخصيص" />
        <TextField label="الهاتف" ltr value={phone} onChange={setPhone} />
        <TextField label="العمولة الافتراضية" ltr suffix="%" value={pct} onChange={(v) => { setPct(v); setErrors({ ...errors, defaultCommissionBps: '' }); }} errorMessage={errors.defaultCommissionBps}
          description={customer ? 'لا يؤثر التغيير على المعاملات المخصّصة سابقاً' : 'تُنسخ إلى كل معاملة عند تخصيصها'} />
        <div className="flex items-end pb-7">{customer && <Checkbox isSelected={isActive} onChange={setIsActive}>نشط</Checkbox>}</div>
        <TextField label="ملاحظات" multiline value={notes} onChange={setNotes} className="col-span-2" />
      </div>
    </Dialog>
  );
}

/** SPEC 4.7: deletes the customer and their whole ledger; their transactions return to unassigned. */
export function DeleteCustomerDialog({ customer, onClose, onDeleted }: { customer: Customer; onClose: () => void; onDeleted?: () => void }) {
  const preview = useQuery({ queryKey: ['customer_delete_preview', customer.id], queryFn: () => api.customerDeletePreview(customer.id), staleTime: 0 });
  const [mismatch, setMismatch] = useState<string>();
  const { run, pending } = useAction();
  const p = preview.data;
  return (
    <DangerConfirm title={`حذف ${customer.name}`} confirmLabel="حذف العميل ودفتره" pending={pending} isLoading={!p} backup="auto" withReason={false}
      onClose={onClose}
      typeToConfirm={{ label: <>اكتب اسم العميل للتأكيد: <b className="font-medium text-fg">{customer.name}</b></>, expected: customer.name, error: mismatch }}
      onConfirm={async () => {
        setMismatch(undefined);
        const r = await run(() => api.customerDelete(customer.id, customer.name), undefined, { quiet: (e) => e.code === 'confirm_mismatch' });
        if (r.ok) { deletedToast(`حُذف ${customer.name}`, r.value.backup); onClose(); onDeleted?.(); }
        else if (r.error.code === 'confirm_mismatch') setMismatch(r.error.messageAr);
      }}>
      {p && (
        <div className="flex flex-col gap-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 rounded-card bg-raised/60 px-4 py-3">
            <dt className="text-fg-3">معاملاته</dt><dd><span className="num">{p.assignedCount}</span>{p.approvedCount > 0 && <>، منها <span className="num">{p.approvedCount}</span> معتمدة</>}</dd>
            <dt className="text-fg-3">قيود دفتره</dt><dd className="num">{p.ledgerEntryCount}</dd>
            <dt className="text-fg-3">أرصدته</dt><dd><BalanceChips c={{ balances: p.balances }} /></dd>
          </dl>
          <ul className="list-disc space-y-1 ps-5 text-fg-2">
            <li className="text-neg">يُحذف دفتره بالكامل، وتختفي أرصدته من لوحة التحكم.</li>
            {p.assignedCount > 0 && <li>معاملاته لا تُحذف: ترجع «غير مخصّصة» ويمكن تخصيصها لعميل آخر.</li>}
          </ul>
          {customer.isActive && (
            <div className="flex items-center justify-between gap-3 rounded-card border border-line px-4 py-3">
              <span className="text-fg-2">تريد إخفاءه فقط؟ التعطيل يبقي دفتره وأرصدته.</span>
              <Button size="sm" variant="secondary" onPress={async () => { const r = await run(() => api.customerSetActive(customer.id, false), `عُطّل ${customer.name}`); if (r.ok) onClose(); }}>تعطيل بدلاً من ذلك</Button>
            </div>
          )}
        </div>
      )}
    </DangerConfirm>
  );
}
