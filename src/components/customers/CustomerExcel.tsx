import { useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { MenuTrigger, Menu, MenuItem, Popover } from 'react-aria-components';
import { FileSpreadsheet, MoreHorizontal, TriangleAlert } from 'lucide-react';
import { api, native, toAppError } from '@/lib/api';
import type { Customer, CustomerExcelItemRef, CustomerExcelPreview } from '@/lib/contract';
import { useAction } from '@/lib/useAction';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox } from '@/components/ui/Field';
import { Amount } from '@/components/ui/Amount';
import { DateTime } from '@/components/ui/DateTime';
import { Trunc } from '@/components/ui/Trunc';
import { toast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';

/*
 * The customer's Excel statement (SPEC 6.8.2): one file per customer that the owner hands over
 * instead of the app. The owner adds approved transfers and payouts/adjustments to it by hand.
 */

/**
 * A Windows path with Arabic folder names keeps its order inside the RTL page: shown left to right,
 * with a left-to-right mark after each separator so neighbouring Arabic names don't merge into one run.
 */
export function PathText({ path, className }: { path: string; className?: string }) {
  return <div dir="ltr" title={path} className={cx('truncate text-right', className)}>{path.replace(/([\\/])/g, '$1\u200E')}</div>;
}

const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || path;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** "سطر واحد" / "سطران" / "3 أسطر" / "11 سطراً" */
export function linesLabel(n: number): string {
  if (n === 1) return 'سطر واحد';
  if (n === 2) return 'سطران';
  return n >= 3 && n <= 10 ? `${n} أسطر` : `${n} سطراً`;
}

export const openFileAction = (path: string) => ({ label: 'فتح الملف', onPress: () => void api.openPath(path).catch(() => toast.error('تعذّر فتح الملف')) });

/** Adds after an approve / payout (the dialogs' checkbox). The money action already succeeded, so a failure only warns. */
export async function addToStatementAfter(customerId: number, item: CustomerExcelItemRef, qc: QueryClient) {
  try {
    const r = await api.customerExcelAdd(customerId, [item]);
    await qc.invalidateQueries();
    if (r.added) toast.action('أُضيفت إلى ملف العميل', [openFileAction(r.path)], fileName(r.path));
  } catch (raw) {
    const e = toAppError(raw);
    const why = e.code === 'file_locked' ? 'الملف مفتوح في Excel' : e.messageAr;
    toast.error(`لم تُضف لملف العميل: ${why}`, 'العملية نفسها تمّت. أضفها لاحقاً بالتحديد ثم «إضافة إلى ملف العميل».');
  }
}

/** "أضف إلى ملف العميل" in the approve and payout dialogs; the last choice is kept per customer. */
export function StatementCheckbox({ customerId, value, onChange }: { customerId: number; value: boolean | null; onChange: (v: boolean) => void }) {
  const customer = useQuery({ queryKey: ['customer', customerId], queryFn: () => api.customerGet(customerId) });
  const excel = customer.data?.excel;
  if (!excel) return null;
  const checked = value ?? excel.addToExcelByDefault;
  return (
    <Checkbox isSelected={checked} onChange={(v) => { onChange(v); void api.customerExcelSetDefault(customerId, v).catch(() => undefined); }}>
      أضف إلى ملف العميل <span className="text-fg-3">({fileName(excel.path)})</span>
    </Checkbox>
  );
}

/** Whether the dialog's checkbox ends up on (its own state, or the customer's remembered default). */
export function useStatementChoice(customerId: number | undefined) {
  const [value, setValue] = useState<boolean | null>(null);
  const customer = useQuery({ queryKey: ['customer', customerId], queryFn: () => api.customerGet(customerId!), enabled: customerId !== undefined });
  const excel = customer.data?.excel;
  return { value, setValue, on: !!excel && (value ?? excel.addToExcelByDefault) };
}

// ---------------------------------------------------------------- header card
export function CustomerExcelCard({ customer }: { customer: Customer }) {
  const qc = useQueryClient();
  const { run } = useAction();
  const [creating, setCreating] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const x = customer.excel;

  const link = async () => {
    const path = await native.pickXlsx();
    if (!path) return;
    const r = await run(() => api.customerExcelLink(customer.id, path), 'رُبط ملف العميل', { quiet: (e) => e.code === 'excel_layout' });
    if (!r.ok && r.error.code === 'excel_layout') setLinkError(r.error.messageAr);
    await qc.invalidateQueries();
  };

  return (
    <div className="mb-6 flex items-center gap-4 rounded-card border border-line bg-surface px-4 py-3" data-testid="customer-excel">
      <FileSpreadsheet className="size-5 shrink-0 text-fg-3" strokeWidth={1.6} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg">ملف Excel للعميل</div>
        {x ? (
          <div className="flex min-w-0 items-center gap-3 text-[12.5px] text-fg-3">
            <PathText path={x.path} className={cx('min-w-0 max-w-[420px]', x.exists ? 'text-fg-2' : 'text-warn')} />
            {!x.exists && <span className="shrink-0 text-warn">الملف غير موجود في مكانه</span>}
            {x.updatedAt && <span className="shrink-0">آخر تحديث <DateTime iso={x.updatedAt} /></span>}
          </div>
        ) : (
          <div className="text-[12.5px] text-fg-3">كشف حساب Excel تسلّمه للعميل بدل البرنامج، وتضيف إليه ما تريد بيدك</div>
        )}
      </div>
      {x ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" isDisabled={!x.exists} onPress={() => openFileAction(x.path).onPress()}>فتح الملف</Button>
          <MenuTrigger>
            <Button size="icon" variant="quiet" aria-label="خيارات ملف العميل" className="size-8"><MoreHorizontal /></Button>
            <Popover placement="bottom end" className="min-w-44 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
              <Menu className="outline-none" onAction={(k) => {
                if (k === 'folder') void run(() => api.openPath(folderOf(x.path)));
                if (k === 'change') void link();
                if (k === 'unlink') setUnlinking(true);
              }}>
                <MenuItem id="folder" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">فتح المجلد</MenuItem>
                <MenuItem id="change" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">تغيير الملف…</MenuItem>
                <MenuItem id="unlink" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm text-neg outline-none data-[focused]:bg-raised">إلغاء الربط</MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
        </div>
      ) : (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="quiet" onPress={() => void link()}>ربط ملف موجود</Button>
          <Button size="sm" variant="secondary" onPress={() => setCreating(true)}>إنشاء ملف للعميل</Button>
        </div>
      )}

      {creating && <CreateStatementDialog customer={customer} onClose={() => setCreating(false)} />}
      {unlinking && x && (
        <Dialog isOpen onOpenChange={(o) => !o && setUnlinking(false)} width="sm" title="إلغاء ربط ملف العميل"
          footer={<>
            <Button variant="secondary" onPress={() => setUnlinking(false)}>تراجع</Button>
            <Button variant="danger" onPress={async () => { const r = await run(() => api.customerExcelUnlink(customer.id), 'أُلغي الربط'); if (r.ok) setUnlinking(false); }}>إلغاء الربط</Button>
          </>}>
          <div className="flex flex-col gap-1 text-sm text-fg-2"><p>لا يُحذف الملف، ويبقى كما هو في:</p><PathText path={folderOf(x.path)} className="text-fg" /><p>يمكنك ربطه من جديد لاحقاً.</p></div>
        </Dialog>
      )}
      {linkError && (
        <Dialog isOpen onOpenChange={(o) => !o && setLinkError(null)} width="sm" title="لم يُربط الملف"
          footer={<>
            <Button variant="secondary" onPress={() => setLinkError(null)}>تم</Button>
            <Button variant="primary" onPress={() => { setLinkError(null); setCreating(true); }}>إنشاء ملف للعميل</Button>
          </>}>
          <div className="flex flex-col gap-2 text-sm">
            <p className="rounded-card bg-warn-soft px-4 py-3 text-fg">{linkError}</p>
            <p className="text-fg-2">يُربط فقط كشف حساب أنشأه البرنامج لهذا العميل.</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- create
export function CreateStatementDialog({ customer, onClose, onCreated }: { customer: Customer; onClose: () => void; onCreated?: () => void }) {
  const [includeExisting, setIncludeExisting] = useState(false);
  const { run, pending } = useAction();
  // counts only (no money): approved transfers, and ledger lines that are not approval credits
  const counts = useQuery({
    queryKey: ['customer-excel-counts', customer.id],
    queryFn: async () => {
      const c = await api.txnCounts({ customerId: customer.id });
      const cards = await api.ledgerBalances(customer.id);
      const views = await Promise.all(cards.map((b) => api.ledgerEntries(customer.id, b.currency)));
      return { txns: c.approved, entries: views.flatMap((v) => v.entries).filter((e) => e.type !== 'credit').length };
    },
  });
  const create = async () => {
    const path = await native.saveXlsx(`كشف حساب - ${customer.name}.xlsx`);
    if (!path) return;
    const r = await run(() => api.customerExcelCreate(customer.id, path, includeExisting), undefined, { quiet: (e) => e.code === 'file_locked' });
    if (r.ok) {
      onClose();
      onCreated?.();
      toast.action('أُنشئ ملف العميل', [openFileAction(r.value.path)], includeExisting ? `أُضيف ${linesLabel(r.value.added)}` : fileName(r.value.path));
    } else if (r.error.code === 'file_locked') toast.error('الملف مفتوح في Excel', 'اختر اسماً آخر أو أغلق الملف ثم أعد المحاولة.');
  };
  const n = counts.data;
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={`ملف Excel لـ ${customer.name}`}
      description="كشف حساب عربي، ورقة لكل عملة، فيه المستحق والمدفوع والرصيد، تضيف إليه بيدك ما تريد"
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isPending={pending} onPress={() => void create()}>اختيار مكان الحفظ وإنشاء</Button>
      </>}>
      <Checkbox isSelected={includeExisting} onChange={setIncludeExisting}>
        أضف كل الحوالات المعتمدة والدفعات الحالية
        {n && <span className="num ms-1 text-fg-3">({n.txns} حوالة، {n.entries} قيد)</span>}
      </Checkbox>
      <p className="mt-2 text-[13px] text-fg-3">أو اتركه فارغاً وأضف لاحقاً ما تختاره من «معتمدة» أو من الدفتر.</p>
    </Dialog>
  );
}

// ---------------------------------------------------------------- add (preview, then write)
export function AddToStatementDialog({ customer, items, onClose, onDone }: { customer: Customer; items: CustomerExcelItemRef[]; onClose: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const { run, pending } = useAction();
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const preview = useQuery({
    queryKey: ['customer_excel_preview', customer.id, items],
    queryFn: () => api.customerExcelPreview(customer.id, items),
    enabled: !!customer.excel,
  });
  const p: CustomerExcelPreview | undefined = preview.data;

  const add = async () => {
    setProblem(null);
    const r = await run(() => api.customerExcelAdd(customer.id, items), undefined,
      { quiet: (e) => e.code === 'file_locked' || e.code === 'excel_layout' || e.code === 'no_export_path' });
    if (r.ok) {
      onClose();
      onDone?.();
      toast.action(`أُضيف ${linesLabel(r.value.added)} إلى ملف العميل`, [openFileAction(r.value.path)],
        r.value.skippedDuplicates ? `تُخطّي ${linesLabel(r.value.skippedDuplicates)} موجودة أصلاً` : fileName(r.value.path));
      return;
    }
    const e = r.error;
    if (e.code === 'file_locked') setProblem({ code: e.code, message: 'الملف مفتوح في Excel. أغلقه ثم أعد المحاولة؛ لم يُكتب شيء.' });
    else if (e.code === 'excel_layout') setProblem({ code: e.code, message: e.messageAr });
    else if (e.code === 'no_export_path') setProblem({ code: e.code, message: 'لا ملف Excel مرتبط بهذا العميل.' });
  };

  if (!customer.excel || problem?.code === 'no_export_path') {
    return (
      <>
        <Dialog isOpen={!creating} onOpenChange={(o) => !o && onClose()} width="sm" title="لا ملف Excel لهذا العميل"
          footer={<>
            <Button variant="secondary" onPress={onClose}>تراجع</Button>
            <Button variant="primary" onPress={() => setCreating(true)}>إنشاء ملف للعميل</Button>
          </>}>
          <p className="text-sm text-fg-2">أنشئ له كشف حساب Excel أولاً، ثم أضف إليه ما اخترت.</p>
        </Dialog>
        {creating && <CreateStatementDialog customer={customer} onClose={() => { setCreating(false); onClose(); }} onCreated={() => void qc.invalidateQueries()} />}
      </>
    );
  }

  const Line = ({ l }: { l: CustomerExcelPreview['toAdd'][number] }) => (
    <li className="grid grid-cols-[88px_1fr_auto] items-center gap-3 px-3 py-2 text-[13px]">
      <bdi dir="ltr" className="num text-right text-fg-2">{l.date}</bdi>
      <Trunc className="min-w-0 text-fg">{l.labelAr}</Trunc>
      <Amount minor={l.amountMinor} currency={l.currency} className={l.amountMinor < 0 ? 'text-neg' : ''} />
    </li>
  );

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title="إضافة إلى ملف العميل"
      description={<PathText path={customer.excel.path} className="text-fg-3" />}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isPending={pending} isDisabled={!p || p.toAdd.length === 0} onPress={() => void add()}>
          {p && p.toAdd.length ? `إضافة ${linesLabel(p.toAdd.length)}` : 'إضافة'}
        </Button>
      </>}>
      {!p ? <p className="text-sm text-fg-3">جارٍ التحقق من الملف…</p> : (
        <div className="flex flex-col gap-4">
          {problem && (
            <div className="flex gap-2 rounded-card bg-warn-soft px-4 py-3 text-sm text-fg">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />{problem.message}
            </div>
          )}
          <section>
            <h3 className="mb-1.5 text-sm font-medium text-fg">ستُضاف {p.toAdd.length ? linesLabel(p.toAdd.length) : 'لا أسطر'}</h3>
            {p.toAdd.length > 0 && <ul className="max-h-[200px] divide-y divide-line overflow-auto rounded-card border border-line">{p.toAdd.map((l) => <Line key={`${l.kind}${l.id}`} l={l} />)}</ul>}
            {p.olderThanLastRow > 0 && <p className="mt-1.5 text-[12.5px] text-fg-3">{p.olderThanLastRow === 1 ? 'سطر تاريخه' : `${linesLabel(p.olderThanLastRow)} تواريخها`} أقدم من آخر سطر في الكشف؛ تُضاف في آخره مرتّبةً بالتاريخ.</p>}
          </section>
          {p.duplicates.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-sm font-medium text-fg">موجودة أصلاً في ملف العميل: {p.duplicates.length} <span className="font-normal text-fg-3">(لن تُضاف)</span></h3>
              <ul className="max-h-[160px] divide-y divide-line overflow-auto rounded-card border border-line bg-raised/40 opacity-80">{p.duplicates.map((l) => <Line key={`${l.kind}${l.id}`} l={l} />)}</ul>
            </section>
          )}
          {p.notAllowed.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-sm font-medium text-fg">لا تُضاف: {p.notAllowed.length}</h3>
              <ul className="flex flex-col gap-1 text-[13px] text-fg-2">
                {[...new Set(p.notAllowed.map((x) => x.reasonAr))].map((r) => (
                  <li key={r}>{r} <span className="num text-fg-3">({p.notAllowed.filter((x) => x.reasonAr === r).length})</span></li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}
