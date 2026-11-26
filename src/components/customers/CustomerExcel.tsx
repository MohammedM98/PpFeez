import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Button as RacButton } from 'react-aria-components';
import { MenuTrigger, Menu, MenuItem, MenuPopover } from '@/components/ui/Menu';
import { FileSpreadsheet, TriangleAlert } from 'lucide-react';
import { api, events, native, toAppError } from '@/lib/api';
import type { AppError, Customer, CustomerExcelFile, CustomerExcelItemRef, CustomerExcelPreview, ExcelStart } from '@/lib/contract';
import { useAction } from '@/lib/useAction';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Select } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { DatePicker } from '@/components/ui/DateFields';
import { Amount } from '@/components/ui/Amount';
import { DateTime } from '@/components/ui/DateTime';
import { Trunc } from '@/components/ui/Trunc';
import { TextField } from '@/components/ui/TextField';
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
  if (!excel || excel.autoSync) return null; // auto-sync writes it anyway (SPEC 6.8.3)
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
  return { value, setValue, on: !!excel && !excel.autoSync && (value ?? excel.addToExcelByDefault) };
}

// ---------------------------------------------------------------- sending (SPEC 6.8.3)
/** "حركة واحدة" / "حركتان" / "3 حركات" / "11 حركة" */
export function movesLabel(n: number): string {
  if (n === 1) return 'حركة واحدة';
  if (n === 2) return 'حركتان';
  return n >= 3 && n <= 10 ? `${n} حركات` : `${n} حركة`;
}

/** Why a write to the customer's file did not happen, in the owner's words. */
export const excelWhy = (e: AppError) => (e.code === 'file_locked' ? 'الملف مفتوح في Excel' : e.messageAr);

/** "إرسال غير المُصدَّر": everything this customer has that is not in the file yet, in statement order. */
export async function sendUnexported(customerId: number, qc: QueryClient, customerName?: string): Promise<boolean> {
  const who = customerName ? `ملف ${customerName}` : 'ملف العميل';
  try {
    const r = await api.customerExcelSendUnexported(customerId);
    await qc.invalidateQueries();
    if (r.added) toast.action(`أُضيف ${movesLabel(r.added)} إلى ${who}`, [openFileAction(r.path)], fileName(r.path));
    else toast.ok(`${who} محدَّث، لا شيء لإرساله`);
    return true;
  } catch (raw) {
    const e = toAppError(raw);
    await qc.invalidateQueries();
    if (e.code === 'file_locked') {
      toast.warn(`لم يُرسل إلى ${who}: الملف مفتوح في Excel`, 'أغلقه في Excel ثم أرسل. لا شيء ضاع: الحركات بانتظار التصدير.',
        [{ label: 'إرسال الآن', onPress: () => void sendUnexported(customerId, qc, customerName) }]);
    } else toast.error(`لم يُرسل إلى ${who}`, e.messageAr);
    return false;
  }
}

const chipClass = 'inline-flex h-8 shrink-0 cursor-default items-center gap-1.5 rounded-full border px-3 text-[12.5px] outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus data-[hovered]:bg-raised data-[pressed]:bg-raised';

// ---------------------------------------------------------------- header chip
/**
 * The customer's Excel file in the one-line header (SPEC 6.5 / 6.8.3): its state in a few words,
 * "إرسال غير المُصدَّر (N)" when something is not in the file, and the file's actions in its menu.
 */
export function CustomerExcelChip({ customer }: { customer: Customer }) {
  const qc = useQueryClient();
  const { run } = useAction();
  const [creating, setCreating] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [askSend, setAskSend] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const x = customer.excel;
  const unsent = x ? x.pendingCount + x.notExportedCount : 0;
  const [starting, setStarting] = useState(false);
  const [listing, setListing] = useState(false);
  // after "إلغاء الربط" the customer's files stay listed (SPEC 6.8.4): one of them can become current again
  const files = useQuery({ queryKey: ['customer_excel_files', customer.id], queryFn: () => api.customerExcelFiles(customer.id), enabled: !x });

  const link = async () => {
    const path = await native.pickXlsx();
    if (!path) return;
    const r = await run(() => api.customerExcelLink(customer.id, path), 'رُبط ملف العميل', { quiet: (e) => e.code === 'excel_layout' });
    if (!r.ok && r.error.code === 'excel_layout') setLinkError(r.error.messageAr);
    await qc.invalidateQueries();
  };
  const send = async () => {
    setSending(true);
    await sendUnexported(customer.id, qc, customer.name);
    setSending(false);
  };
  const setAuto = async (on: boolean) => {
    const r = await run(() => api.customerExcelSetAuto(customer.id, on), on ? 'المزامنة التلقائية مفعّلة: كل حركة جديدة تُضاف للملف' : 'أُوقفت المزامنة التلقائية');
    await qc.invalidateQueries();
    if (r.ok && on && unsent > 0) setAskSend(unsent);
  };

  let state: { text: string; tone: string; title: string };
  if (!x) state = { text: 'غير مرتبط', tone: 'text-fg-3', title: 'لا ملف Excel لهذا العميل' };
  else if (!x.exists) state = { text: 'الملف غير موجود في مكانه', tone: 'text-warn', title: x.path };
  else if (x.lastError && x.pendingCount) state = { text: `⏳ بانتظار التصدير ${x.pendingCount}`, tone: 'text-warn', title: `${excelWhy(x.lastError)} — ${x.path}` };
  else if (unsent) state = { text: `لم تُصدَّر ${unsent}`, tone: 'text-warn', title: x.path };
  else state = { text: '✓ محدَّث', tone: 'text-pos', title: x.path };

  return (
    <div className="flex shrink-0 items-center gap-1.5" data-testid="customer-excel">
      <MenuTrigger>
        <RacButton aria-label={`ملف Excel للعميل: ${state.text}`} className={cx(chipClass, x ? 'border-line' : 'border-dashed border-line-strong')} data-state={state.text}>
          <FileSpreadsheet className="size-4 text-fg-3" strokeWidth={1.6} />
          <span className="text-fg-2">{x ? 'Excel' : 'ملف Excel'}</span>
          <span className="text-fg-3">·</span>
          <span className={cx('num', state.tone)} title={state.title}>{state.text}</span>
          {x && !x.autoSync && <span className="text-fg-3">· يدوي</span>}
        </RacButton>
        <MenuPopover data-testid="customer-excel-menu" className="w-72">
          {x && (
            <div className="border-b border-line px-2.5 pb-2 pt-1.5 text-[12.5px] text-fg-3">
              <PathText path={x.path} className={x.exists ? 'text-fg-2' : 'text-warn'} />
              <div className="num mt-0.5 flex gap-2">
                <span>صُدّرت {x.exportedCount}</span>
                {x.pendingCount > 0 && <span className="text-warn">بانتظار {x.pendingCount}</span>}
                {x.notExportedCount > 0 && <span>لم تُصدَّر {x.notExportedCount}</span>}
              </div>
              {x.updatedAt && <div>آخر تحديث <DateTime iso={x.updatedAt} /></div>}
              {x.lastError && <div className="text-warn">{excelWhy(x.lastError)}</div>}
            </div>
          )}
          <Menu onAction={(k) => {
            if (k === 'open' && x) openFileAction(x.path).onPress();
            if (k === 'folder' && x) void run(() => api.openPath(folderOf(x.path)));
            if (k === 'change' || k === 'link') void link();
            if (k === 'create') setCreating(true);
            if (k === 'new-file') setStarting(true);
            if (k === 'files') setListing(true);
            if (k === 'auto' && x) void setAuto(!x.autoSync);
            if (k === 'unlink') setUnlinking(true);
          }}>
            {x ? (
              <>
                <MenuItem id="open" isDisabled={!x.exists}>فتح الملف</MenuItem>
                <MenuItem id="folder">فتح المجلد</MenuItem>
                <MenuItem id="auto">{x.autoSync ? 'إيقاف المزامنة التلقائية' : 'تفعيل المزامنة التلقائية'}</MenuItem>
                <MenuItem id="new-file">بدء ملف جديد…</MenuItem>
                <MenuItem id="files">ملفات العميل <span className="num text-fg-3">({x.filesCount})</span>…</MenuItem>
                <MenuItem id="change">تغيير الملف…</MenuItem>
                <MenuItem id="unlink" variant="danger">إلغاء الربط</MenuItem>
              </>
            ) : (
              <>
                <MenuItem id="create">إنشاء ملف للعميل…</MenuItem>
                <MenuItem id="link">ربط ملف موجود…</MenuItem>
                {(files.data?.length ?? 0) > 0 && <MenuItem id="files">ملفات العميل السابقة <span className="num text-fg-3">({files.data!.length})</span>…</MenuItem>}
              </>
            )}
          </Menu>
        </MenuPopover>
      </MenuTrigger>
      {x && x.exists && unsent > 0 && (
        <Button size="sm" variant="secondary" isPending={sending} onPress={() => void send()}>
          إرسال غير المُصدَّر <span className="num">({unsent})</span>
        </Button>
      )}

      {creating && <CreateStatementDialog customer={customer} onClose={() => setCreating(false)} />}
      {starting && <NewFileDialog customer={customer} onClose={() => setStarting(false)} />}
      {listing && <FilesDialog customer={customer} onClose={() => setListing(false)} />}
      {askSend !== null && (
        <Dialog isOpen onOpenChange={(o) => !o && setAskSend(null)} width="sm" title="إرسالها الآن؟"
          footer={<>
            <Button variant="secondary" onPress={() => setAskSend(null)}>لاحقاً</Button>
            <Button variant="primary" onPress={() => { setAskSend(null); void send(); }}>إرسال الآن <span className="num">({askSend})</span></Button>
          </>}>
          <p className="text-sm text-fg-2">يوجد {movesLabel(askSend)} غير مُصدّرة إلى ملف العميل. المزامنة ترسل الحركات الجديدة فقط؛ القديمة تُرسل الآن أو لاحقاً بزر «إرسال غير المُصدَّر».</p>
        </Dialog>
      )}
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
  // the destination (SPEC 6.8.4): the current file, another of the customer's files, or a new one
  const files = useQuery({ queryKey: ['customer_excel_files', customer.id], queryFn: () => api.customerExcelFiles(customer.id), enabled: !!customer.excel });
  const [fileId, setFileId] = useState<number | undefined>(undefined);
  const [newFile, setNewFile] = useState(false);
  const target = files.data?.find((f) => (fileId === undefined ? f.isCurrent : f.id === fileId));
  const preview = useQuery({
    queryKey: ['customer_excel_preview', customer.id, items, fileId],
    queryFn: () => api.customerExcelPreview(customer.id, items, fileId),
    enabled: !!customer.excel,
  });
  const p: CustomerExcelPreview | undefined = preview.data;

  const add = async () => {
    setProblem(null);
    const r = await run(() => api.customerExcelAdd(customer.id, items, fileId), undefined,
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
    <>
    <Dialog isOpen={!newFile} onOpenChange={(o) => !o && onClose()} width="md" title="إضافة إلى ملف العميل"
      description={<PathText path={target?.path ?? customer.excel.path} className="text-fg-3" />}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isPending={pending} isDisabled={!p || p.toAdd.length === 0} onPress={() => void add()}>
          {p && p.toAdd.length ? `إضافة ${linesLabel(p.toAdd.length)}` : 'إضافة'}
        </Button>
      </>}>
      {(files.data?.length ?? 0) > 0 && (
        <div className="mb-4 flex items-center gap-3">
          <span className="shrink-0 text-[13px] text-fg-2">الوجهة</span>
          <Select label="الوجهة" className="min-w-0 flex-1" value={fileId === undefined ? 'current' : String(fileId)}
            onChange={(k) => { if (k === 'new') setNewFile(true); else setFileId(k === 'current' ? undefined : Number(k)); }}
            options={[
              ...(files.data ?? []).map((f) => ({ id: f.isCurrent ? 'current' : String(f.id), label: `${f.isCurrent ? 'الملف الحالي: ' : 'ملف سابق: '}${fileTitle(f)}` })),
              { id: 'new', label: 'ملف جديد…' },
            ]} />
        </div>
      )}
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
    {newFile && <NewFileDialog customer={customer} onClose={() => setNewFile(false)} onCreated={(f) => { setNewFile(false); void files.refetch(); setFileId(f.isCurrent ? undefined : f.id); }} />}
    </>
  );
}

// ---------------------------------------------------------------- several files (SPEC 6.8.4)
/** the name shown for a file: its label, or its file name without .xlsx (keeps a dated name readable in RTL) */
export const fileTitle = (f: CustomerExcelFile) => f.label || fileName(f.path).replace(/\.xlsx$/i, '');

const START_TEXT: Record<CustomerExcelFile['startMode'], string> = {
  carry_balance: 'برصيد مرحّل', all: 'بكل الحركات', from_date: 'من تاريخ', from_seq: 'من رقم حوالة',
};

/**
 * "بدء ملف جديد…": where to save, what the file starts with (a carried balance by default, every line,
 * or from a date / transfer number), and whether it becomes the current file.
 */
export function NewFileDialog({ customer, onClose, onCreated }: { customer: Customer; onClose: () => void; onCreated?: (f: CustomerExcelFile) => void }) {
  const qc = useQueryClient();
  const { run, pending } = useAction();
  const [kind, setKind] = useState<ExcelStart['kind']>('carry_balance');
  const [date, setDate] = useState<string | null>(null);
  const [seq, setSeq] = useState('');
  const [label, setLabel] = useState('');
  const [makeCurrent, setMakeCurrent] = useState(true);
  const [errors, setErrors] = useState<{ start?: string; path?: string }>({});
  const start: ExcelStart | null = kind === 'from_date' ? (date ? { kind, date } : null) : kind === 'from_seq' ? (/^\d+$/.test(seq) ? { kind, seq: Number(seq) } : null) : { kind };

  const create = async () => {
    if (!start) { setErrors({ start: kind === 'from_date' ? 'اختر التاريخ' : 'اكتب رقم الحوالة' }); return; }
    const path = await native.saveXlsx(`كشف حساب - ${customer.name} - ${new Date().toISOString().slice(0, 10)}.xlsx`);
    if (!path) return;
    setErrors({});
    const r = await run(() => api.customerExcelNewFile(customer.id, path, start, makeCurrent, label.trim() || undefined), undefined,
      { quiet: (e) => e.code === 'validation' || e.code === 'file_locked' });
    await qc.invalidateQueries();
    if (r.ok) {
      onCreated?.(r.value.file);
      if (!onCreated) onClose();
      toast.action(makeCurrent ? 'بدأ ملف جديد، وصار الملف الحالي' : 'أُنشئ الملف', [openFileAction(r.value.file.path)],
        r.value.added ? `${linesLabel(r.value.added)} في بدايته` : fileName(r.value.file.path));
    } else if (r.error.code === 'validation') setErrors({ [r.error.field === 'start' ? 'start' : 'path']: r.error.messageAr });
    else if (r.error.code === 'file_locked') setErrors({ path: 'الملف مفتوح في Excel. اختر اسماً آخر أو أغلقه.' });
  };

  const opt = (id: ExcelStart['kind'], title: string, hint: string, extra?: ReactNode) => (
    <label className={cx('flex cursor-default gap-3 rounded-card border px-3 py-2.5', kind === id ? 'border-accent bg-accent-soft/40' : 'border-line')}>
      <input type="radio" name="start" className="mt-1 accent-(--accent)" checked={kind === id} onChange={() => { setKind(id); setErrors({}); }} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fg">{title}</span>
        <span className="block text-[12.5px] text-fg-3">{hint}</span>
        {kind === id && extra}
      </span>
    </label>
  );
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={`بدء ملف جديد لـ ${customer.name}`}
      description="الملف القديم يبقى كما هو في قائمة ملفات العميل، ويمكنك الإضافة إليه يدوياً"
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isPending={pending} onPress={() => void create()}>اختيار مكان الحفظ وإنشاء</Button>
      </>}>
      <div className="flex flex-col gap-3" role="radiogroup" aria-label="ما يبدأ به الملف">
        {opt('carry_balance', 'رصيد مرحّل فقط', 'يبدأ لكل عملة بصف «رصيد مرحّل من الملف السابق» بالرصيد الحالي، ثم الحركات الجديدة فقط')}
        {opt('all', 'كل الحركات من البداية', 'نسخة كاملة جديدة من الكشف')}
        {opt('from_date', 'من تاريخ', 'رصيد مرحّل بما قبل التاريخ، ثم الحركات من بعده',
          <div className="mt-2 max-w-[220px]"><DatePicker label="من تاريخ" value={date} onChange={(v) => { setDate(v); setErrors({}); }} /></div>)}
        {opt('from_seq', 'من رقم حوالة #', 'رصيد مرحّل بما قبل الحوالة، ثم الحركات من بعدها',
          <div className="mt-2 max-w-[160px]"><TextField label="رقم الحوالة #" ltr value={seq} onChange={(v) => { setSeq(v.replace(/\D/g, '')); setErrors({}); }} /></div>)}
        {errors.start && <p role="alert" className="text-[13px] text-neg">{errors.start}</p>}
        <TextField label="اسم للملف (اختياري)" value={label} onChange={setLabel} placeholder="مثلاً: 2027" />
        <Checkbox isSelected={makeCurrent} onChange={setMakeCurrent}>اجعله الملف الحالي (المزامنة التلقائية تكتب فيه)</Checkbox>
        {errors.path && <p role="alert" className="rounded-card bg-warn-soft px-3 py-2 text-sm text-fg">{errors.path}</p>}
      </div>
    </Dialog>
  );
}

/** "ملفات العميل": every statement file of this customer, the current one first. */
export function FilesDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const qc = useQueryClient();
  const { run } = useAction();
  const [starting, setStarting] = useState(false);
  const files = useQuery({ queryKey: ['customer_excel_files', customer.id], queryFn: () => api.customerExcelFiles(customer.id) });
  const refresh = () => qc.invalidateQueries();
  return (
    <>
    <Dialog isOpen={!starting} onOpenChange={(o) => !o && onClose()} width="lg" title={`ملفات ${customer.name}`}
      description="الملف الحالي تكتب فيه المزامنة التلقائية؛ الملفات السابقة تبقى ويمكن الإضافة إليها يدوياً"
      footer={<>
        <Button variant="secondary" onPress={() => setStarting(true)}>بدء ملف جديد…</Button>
        <Button variant="primary" onPress={onClose}>تم</Button>
      </>}>
      <ul aria-label="ملفات العميل" className="flex flex-col divide-y divide-line rounded-card border border-line">
        {(files.data ?? []).map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-3 py-2.5" data-file={f.id}>
            <FileSpreadsheet className="size-5 shrink-0 text-fg-3" strokeWidth={1.6} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm text-fg">
                <span className="truncate">{fileTitle(f)}</span>
                <Badge tone={!f.exists ? 'warn' : f.isCurrent ? 'pos' : 'outline'}>{!f.exists ? 'مفقود' : f.isCurrent ? 'الحالي' : 'سابق'}</Badge>
              </div>
              <PathText path={f.path} className="text-[12px] text-fg-3" />
              <div className="num text-[12px] text-fg-3">
                {START_TEXT[f.startMode]}{f.startValue ? ` ${f.startMode === 'from_seq' ? '#' : ''}${f.startValue}` : ''} · صُدّرت إليه {f.exportedCount}
                {f.updatedAt && <> · آخر تحديث <DateTime iso={f.updatedAt} /></>}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="quiet" isDisabled={!f.exists} onPress={() => openFileAction(f.path).onPress()}>فتح</Button>
              {!f.isCurrent && <Button size="sm" variant="secondary" onPress={async () => { const r = await run(() => api.customerExcelSetCurrent(customer.id, f.id), `صار «${fileTitle(f)}» الملف الحالي`); if (r.ok) await refresh(); }}>اجعله الحالي</Button>}
              {!f.isCurrent && <Button size="sm" variant="quiet" className="text-fg-3" aria-label={`إزالة ${fileTitle(f)} من القائمة`}
                onPress={async () => { const r = await run(() => api.customerExcelRemoveFile(customer.id, f.id), 'أُزيل من القائمة؛ الملف نفسه باقٍ في مكانه'); if (r.ok) await refresh(); }}>إزالة من القائمة</Button>}
            </div>
          </li>
        ))}
        {files.data?.length === 0 && <li className="px-3 py-6 text-center text-sm text-fg-3">لا ملفات بعد</li>}
      </ul>
    </Dialog>
    {starting && <NewFileDialog customer={customer} onClose={() => setStarting(false)} onCreated={() => setStarting(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- range (SPEC 6.8.3)
/**
 * "إضافة نطاق…": transfers #from to #to, with the payouts / returns that sit between them in the
 * statement (unless "الحوالات فقط"), then the usual preview. The core writes them in statement order.
 */
export function AddRangeDialog({ customer, currency, onClose }: { customer: Customer; currency: string; onClose: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [txnsOnly, setTxnsOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<CustomerExcelItemRef[] | null>(null);
  const all = useQuery({ queryKey: ['customer_statement', customer.id, currency, { show: 'all' }], queryFn: () => api.customerStatement(customer.id, currency, { show: 'all' }) });

  const next = () => {
    const a = Number(from), b = Number(to || from);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) { setError('اكتب رقمين صحيحين، الأول أصغر من الثاني أو يساويه'); return; }
    const rows = all.data?.rows ?? [];
    const seqAt = rows.map((r) => (r.kind === 'txn' ? r.txn.customerSeq : null));
    const first = seqAt.findIndex((n) => n !== null && n >= a);
    let last = -1;
    seqAt.forEach((n, i) => { if (n !== null && n <= b) last = i; });
    if (first < 0 || last < first) { setError(`لا حوالات بين #${a} و#${b} في كشف ${currency}`); return; }
    const picked: CustomerExcelItemRef[] = rows.slice(first, last + 1).flatMap((r): CustomerExcelItemRef[] => {
      if (r.kind === 'txn') return r.txn.customerSeq !== null && r.txn.customerSeq >= a && r.txn.customerSeq <= b ? [{ kind: 'txn', id: r.txn.id }] : [];
      if (txnsOnly) return [];
      if (r.kind === 'payout') return r.payout.status === 'sent' ? [{ kind: 'payout', id: r.payout.id }] : [];
      return [{ kind: 'ledger', id: r.entry.id }];
    });
    setItems(picked);
  };

  if (items) return <AddToStatementDialog customer={customer} items={items} onClose={onClose} />;
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="sm" title="إضافة نطاق إلى ملف العميل"
      description={`حوالات كشف ${currency} بأرقامها، وما بينها من دفعات ومرتجعات`}
      footer={<><Button variant="secondary" onPress={onClose}>تراجع</Button><Button variant="primary" isDisabled={!all.data} onPress={next}>معاينة</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <TextField label="من #" ltr value={from} onChange={(v) => { setFrom(v.replace(/\D/g, '')); setError(null); }} autoFocus isRequired />
          <TextField label="إلى #" ltr value={to} onChange={(v) => { setTo(v.replace(/\D/g, '')); setError(null); }} placeholder={from} />
        </div>
        <Checkbox isSelected={txnsOnly} onChange={setTxnsOnly}>الحوالات فقط (بدون الدفعات والمرتجعات بينها)</Checkbox>
        {error && <p role="alert" className="rounded-card bg-warn-soft px-3 py-2 text-sm text-fg">{error}</p>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- background sync (SPEC 6.8.3)
/**
 * One listener for the whole app: after each automatic write the core says what happened. Success is a
 * quiet note; a failure (usually the file open in Excel) says why and offers "إرسال الآن".
 */
export function ExcelSyncListener() {
  const qc = useQueryClient();
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void events.onCustomerExcelSynced(async (e) => {
      await qc.invalidateQueries();
      const c = await qc.fetchQuery({ queryKey: ['customer', e.customerId], queryFn: () => api.customerGet(e.customerId) }).catch(() => null);
      const name = c?.name ?? 'العميل';
      if (e.error) {
        toast.warn(`لم يُضف لملف ${name}: ${excelWhy(e.error)}`, `${movesLabel(e.pending)} بانتظار التصدير. أغلق الملف ثم أرسل؛ لا شيء ضاع.`,
          [{ label: 'إرسال الآن', onPress: () => void sendUnexported(e.customerId, qc, name) }]);
      } else if (e.added) toast.ok(`أُضيف لملف ${name}`, movesLabel(e.added));
    }).then((u) => { if (gone) u(); else off = u; });
    return () => { gone = true; off?.(); };
  }, [qc]);
  return null;
}
