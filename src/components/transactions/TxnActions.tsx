import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BulkResult, CommissionInput, CommissionMode, FeeInput, Transaction, TxnAction } from '@/lib/contract';
import { bpsToPercentText, formatBps, formatMinor, percentTextToBps } from '@/lib/money';
import { nowLocalMinute } from '@/lib/dates';
import { useAction } from '@/lib/useAction';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { ComboBox } from '@/components/ui/ComboBox';
import { Segmented } from '@/components/ui/Segmented';
import { Checkbox, Select } from '@/components/ui/Field';
import { DatePicker } from '@/components/ui/DateFields';
import { Amount } from '@/components/ui/Amount';
import { ConfirmMoney } from '@/components/ui/ConfirmMoney';
import { toast } from '@/components/ui/Toast';
import { Breakdown, fromTxn } from './bits';
import { usePreview } from './usePreview';

export const CURRENCIES = ['USD', 'EUR', 'TRY', 'GBP', 'SAR', 'AED', 'CAD', 'AUD', 'JPY'];

export const actionLabel: Record<TxnAction, string> = {
  assign: 'تخصيص لعميل', unassign: 'إلغاء التخصيص', set_fee: 'تعديل الرسوم', set_commission: 'تعديل العمولة',
  approve: 'اعتماد', unapprove: 'إلغاء الاعتماد', exclude: 'استبعاد', include: 'إرجاع', edit_note: 'تعديل الملاحظة',
};

type Open =
  | { kind: 'assign' | 'fee' | 'commission' | 'approve' | 'unapprove' | 'note'; txn: Transaction }
  | { kind: 'manual'; rawEmailId?: number; prefill?: { payerName?: string; occurredAt?: string } }
  | { kind: 'bulk_assign'; ids: number[] }
  | { kind: 'bulk_approve'; rows: Transaction[] }
  | { kind: 'bulk_result'; title: string; result: BulkResult; rows: Transaction[] };

type Ctx = { open: (o: Open) => void; act: (a: TxnAction, t: Transaction) => void; bulk: (a: 'unassign' | 'exclude', rows: Transaction[]) => void };
const TxnActionsCtx = createContext<Ctx | null>(null);
export const useTxnActions = () => useContext(TxnActionsCtx)!;

export function TxnActionsHost({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Open | null>(null);
  const { run } = useAction();
  const close = () => setState(null);

  const ctx = useMemo<Ctx>(() => ({
    open: setState,
    act: (a, t) => {
      switch (a) {
        case 'assign': return setState({ kind: 'assign', txn: t });
        case 'set_fee': return setState({ kind: 'fee', txn: t });
        case 'set_commission': return setState({ kind: 'commission', txn: t });
        case 'approve': return setState({ kind: 'approve', txn: t });
        case 'unapprove': return setState({ kind: 'unapprove', txn: t });
        case 'edit_note': return setState({ kind: 'note', txn: t });
        case 'unassign': return void run(() => api.txnUnassign(t.id), 'أُلغي التخصيص');
        case 'exclude': return void run(() => api.txnSetExcluded(t.id, true), 'استُبعدت المعاملة');
        case 'include': return void run(() => api.txnSetExcluded(t.id, false), 'أُرجعت المعاملة إلى غير المخصّصة');
      }
    },
    bulk: async (a, rows) => {
      const r = await run(() => api.txnBulk({ action: a, ids: rows.map((x) => x.id) }));
      if (r.ok) reportBulk(a === 'unassign' ? 'إلغاء التخصيص' : 'الاستبعاد', r.value, rows, setState);
    },
  }), [run]);

  return (
    <TxnActionsCtx.Provider value={ctx}>
      {children}
      {state?.kind === 'assign' && <AssignDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'bulk_assign' && <AssignDialog ids={state.ids} onClose={close} onBulk={(res, title) => setState({ kind: 'bulk_result', result: res, title, rows: [] })} />}
      {state?.kind === 'fee' && <FeeDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'commission' && <CommissionDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'approve' && <ApproveDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'unapprove' && <UnapproveDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'note' && <NoteDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'manual' && <ManualDialog rawEmailId={state.rawEmailId} prefill={state.prefill} onClose={close} />}
      {state?.kind === 'bulk_approve' && <BulkApproveDialog rows={state.rows} onClose={close} onDone={(res) => reportBulk('الاعتماد', res, state.rows, setState)} />}
      {state?.kind === 'bulk_result' && <BulkResultDialog title={state.title} result={state.result} rows={state.rows} onClose={close} />}
    </TxnActionsCtx.Provider>
  );
}

function reportBulk(title: string, res: BulkResult, rows: Transaction[], setState: (o: Open | null) => void) {
  if (res.failed.length === 0) {
    toast.ok(`${title}: نجح ${res.ok.length}`);
    setState(null);
  } else {
    setState({ kind: 'bulk_result', title, result: res, rows });
  }
}

// ---------------------------------------------------------------- commission input
function useCommissionInput(initialMode: CommissionMode, initialBps: number | null, initialFixed: string) {
  const [mode, setMode] = useState<CommissionMode>(initialMode);
  const [pct, setPct] = useState(initialBps !== null ? bpsToPercentText(initialBps) : '');
  const [fixed, setFixed] = useState(initialFixed);
  const bps = percentTextToBps(pct);
  const input: CommissionInput | undefined =
    mode === 'percent' ? (bps === null ? undefined : { mode: 'percent', bps }) : fixed.trim() ? { mode: 'fixed', amountText: fixed.trim() } : undefined;
  const pctError = mode === 'percent' && pct.trim() !== '' && bps === null ? 'نسبة بين 0 و100 بخانتين عشريتين على الأكثر' : undefined;
  return { mode, setMode, pct, setPct, fixed, setFixed, input, pctError, hint: mode === 'percent' && bps !== null ? formatBps(bps) : mode === 'fixed' ? 'ثابتة' : undefined };
}

function CommissionFields({ c, currency }: { c: ReturnType<typeof useCommissionInput>; currency: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-fg-2">العمولة</span>
      <div className="flex items-start gap-2">
        <Segmented label="نوع العمولة" value={c.mode} onChange={c.setMode} options={[{ id: 'percent', label: 'نسبة' }, { id: 'fixed', label: 'مبلغ ثابت' }]} className="w-[200px] shrink-0" />
        {c.mode === 'percent'
          ? <TextField aria-label="النسبة" value={c.pct} onChange={c.setPct} ltr suffix="%" errorMessage={c.pctError} className="flex-1" />
          : <TextField aria-label="مبلغ العمولة" value={c.fixed} onChange={c.setFixed} ltr suffix={currency} placeholder="0.00" className="flex-1" />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- assign
function AssignDialog({ txn, ids, onClose, onBulk }: { txn?: Transaction; ids?: number[]; onClose: () => void; onBulk?: (r: BulkResult, title: string) => void }) {
  const customers = useQuery({ queryKey: ['customers', { active: true }], queryFn: () => api.customersList({ active: true }) });
  const [customerId, setCustomerId] = useState<number | null>(null);
  const customer = customers.data?.find((c) => c.id === customerId) ?? null;
  const c = useCommissionInput('percent', null, '');
  const [approve, setApprove] = useState(false);
  const { run, pending } = useAction();

  useEffect(() => {
    if (customer) c.setPct(bpsToPercentText(customer.defaultCommissionBps));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const preview = usePreview(txn && customerId ? { id: txn.id, customerId, commission: c.input } : null);
  const p = preview.data;
  const canApprove = !!txn && txn.feeMinor !== null;
  const items = (customers.data ?? []).map((x) => ({ id: x.id, label: x.name, hint: <bdi dir="ltr" className="num">{formatBps(x.defaultCommissionBps)}</bdi> }));

  const submit = async () => {
    if (!customerId) return;
    if (txn) {
      const r = await run(() => api.txnAssign(txn.id, customerId, c.input, approve && canApprove), approve ? 'خُصّصت واعتُمدت' : `خُصّصت لـ ${customer?.name}`);
      if (r.ok) onClose();
    } else if (ids) {
      const r = await run(() => api.txnBulk({ action: 'assign', ids, customerId, commission: c.input }));
      if (r.ok) {
        if (r.value.failed.length === 0) { toast.ok(`خُصّصت ${r.value.ok.length} معاملة لـ ${customer?.name}`); onClose(); }
        else onBulk?.(r.value, 'التخصيص');
      }
    }
  };

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md"
      title={txn ? 'تخصيص لعميل' : `تخصيص ${ids?.length} معاملة لعميل`}
      description={txn && <>دفعة من <bdi>{txn.payerName}</bdi> بقيمة <Amount minor={txn.grossMinor} currency={txn.currency} /></>}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isDisabled={!customerId || pending || !!c.pctError || (!!p?.error && !!txn)} onPress={submit}>
          {approve && canApprove ? <>تخصيص واعتماد {p?.customerAmountMinor != null && <Amount minor={p.customerAmountMinor} currency={txn!.currency} className="[&_span]:text-accent-fg/75" />}</> : 'تخصيص'}
        </Button>
      </>}>
      <div className="flex flex-col gap-4">
        <ComboBox label="العميل" items={items} value={customerId} onChange={(k) => setCustomerId(k === null ? null : Number(k))} placeholder="ابحث باسم العميل" autoFocus />
        <CommissionFields c={c} currency={txn?.currency ?? ''} />
        {txn && (
          <Breakdown title="معاينة" v={{
            currency: txn.currency, gross: txn.grossMinor, fee: txn.feeMinor, net: p?.netMinor ?? txn.netMinor,
            commission: customerId ? p?.commissionMinor ?? null : null, toCustomer: customerId ? p?.customerAmountMinor ?? null : null, commissionHint: customerId ? c.hint : undefined,
          }} />
        )}
        {p?.error && <p className="text-[13px] text-neg">{p.error.messageAr}</p>}
        {txn && (
          canApprove
            ? <Checkbox isSelected={approve} onChange={setApprove}>اعتماد مباشرة (العميل وافق)</Checkbox>
            : <p className="text-[13px] text-fg-3">الاعتماد يحتاج إدخال رسوم PayPal أولاً</p>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- fee
function FeeDialog({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const [active, setActive] = useState<'fee' | 'net'>('fee');
  const [feeText, setFeeText] = useState(txn.feeMinor !== null && !txn.feeIsEstimated ? formatMinor(txn.feeMinor, txn.currency).replace(/,/g, '') : '');
  const [netText, setNetText] = useState('');
  const { run, pending } = useAction();
  const text = active === 'fee' ? feeText : netText;
  const input: FeeInput | undefined = text.trim() ? (active === 'fee' ? { kind: 'fee', feeText: text.trim() } : { kind: 'net', netText: text.trim() }) : undefined;
  const preview = usePreview({ id: txn.id, fee: input });
  const p = preview.data;
  const estimate = p?.feeEstimateMinor ?? (txn.feeIsEstimated ? txn.feeMinor : null);
  const shown = (m: number | null | undefined) => (m === null || m === undefined ? '' : formatMinor(m, txn.currency));

  const save = async (fee: FeeInput, msg: string) => {
    const r = await run(() => api.txnSetFee(txn.id, fee), msg);
    if (r.ok) onClose();
  };

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title="رسوم PayPal"
      description={<>أدخل الرسوم أو الصافي كما يظهر في رصيد PayPal، والآخر يُحسب تلقائياً</>}
      footer={<>
        <Button variant="quiet" className="me-auto" onPress={() => save({ kind: 'zero' }, 'سُجّلت بلا رسوم')} isDisabled={pending}>بلا رسوم</Button>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isDisabled={!input || !!p?.error || pending} onPress={() => input && save(input, 'حُفظت الرسوم')}>حفظ</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <TextField label="الرسوم" ltr suffix={txn.currency} placeholder="0.00" autoFocus
            value={active === 'fee' ? feeText : shown(p?.feeMinor)}
            onChange={(v) => { setActive('fee'); setFeeText(active === 'fee' ? v : v.replace(/,/g, '')); }}
            errorMessage={active === 'fee' && (p?.error?.field === 'fee' || p?.error?.code === 'invalid_amount') ? p?.error?.messageAr : undefined} />
          <TextField label="الصافي" ltr suffix={txn.currency} placeholder="0.00"
            value={active === 'net' ? netText : shown(p?.netMinor)}
            onChange={(v) => { setActive('net'); setNetText(active === 'net' ? v : v.replace(/,/g, '')); }}
            errorMessage={active === 'net' && p?.error ? p.error.messageAr : undefined} />
        </div>
        {estimate !== null && !input && (
          <div className="flex items-center justify-between gap-3 rounded-card border border-dashed border-line-strong px-4 py-3">
            <div className="text-sm text-fg-2">تقدير الرسوم <Amount minor={estimate} currency={txn.currency} estimated className="italic" /> <span className="text-[12.5px] text-fg-3">تقديري، لا يُحفظ إلا بالتأكيد</span></div>
            <Button size="sm" variant="secondary" onPress={() => save({ kind: 'accept_estimate' }, 'اعتُمد التقدير')} isDisabled={pending}>تأكيد التقدير</Button>
          </div>
        )}
        <Breakdown title="معاينة" v={{
          ...fromTxn(txn, txn.commissionMode === 'percent' && txn.commissionBps !== null ? formatBps(txn.commissionBps) : undefined),
          fee: input ? p?.feeMinor ?? null : txn.feeMinor, net: input ? p?.netMinor ?? null : txn.netMinor,
          commission: input ? p?.commissionMinor ?? null : txn.commissionMinor, toCustomer: input ? p?.customerAmountMinor ?? null : txn.customerAmountMinor, feeHint: undefined,
        }} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- commission
function CommissionDialog({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const c = useCommissionInput(txn.commissionMode ?? 'percent', txn.commissionBps, txn.commissionMode === 'fixed' && txn.commissionMinor !== null ? formatMinor(txn.commissionMinor, txn.currency).replace(/,/g, '') : '');
  const preview = usePreview(c.input ? { id: txn.id, commission: c.input } : null);
  const p = preview.data;
  const { run, pending } = useAction();
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title="تعديل العمولة"
      description={<>لـ {txn.customer?.name} على دفعة <bdi>{txn.payerName}</bdi></>}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isDisabled={!c.input || !!p?.error || pending} onPress={async () => { const r = await run(() => api.txnSetCommission(txn.id, c.input!), 'عُدّلت العمولة'); if (r.ok) onClose(); }}>حفظ</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <CommissionFields c={c} currency={txn.currency} />
        <Breakdown title="معاينة" v={{ ...fromTxn(txn), commission: p?.commissionMinor ?? null, toCustomer: p?.customerAmountMinor ?? null, net: p?.netMinor ?? txn.netMinor, commissionHint: c.hint }} />
        {p?.error && <p className="text-[13px] text-neg">{p.error.messageAr}</p>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- approve / unapprove
function ApproveDialog({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const { run, pending } = useAction();
  return (
    <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title="اعتماد المعاملة" amount={txn.customerAmountMinor} currency={txn.currency}
      confirmLabel="اعتماد" pending={pending}
      onConfirm={async () => { const r = await run(() => api.txnApprove(txn.id), `اعتُمدت وأُضيفت لرصيد ${txn.customer?.name}`); if (r.ok) onClose(); }}>
      <p className="text-sm text-fg-2">يُضاف هذا المبلغ إلى رصيد <b className="font-medium text-fg">{txn.customer?.name}</b> كقيد جديد في دفتره، وتُقفل المعاملة عن التعديل.</p>
    </ConfirmMoney>
  );
}

function UnapproveDialog({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { run, pending } = useAction();
  return (
    <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title="إلغاء الاعتماد" tone="danger"
      amount={txn.customerAmountMinor === null ? null : -txn.customerAmountMinor} currency={txn.currency}
      confirmLabel="إلغاء الاعتماد" pending={pending} extraValid={reason.trim().length > 0}
      onConfirm={async () => { const r = await run(() => api.txnUnapprove(txn.id, reason.trim()), 'أُلغي الاعتماد وأُضيف قيد عكسي'); if (r.ok) onClose(); }}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">يُضاف قيد عكسي بهذا المبلغ في دفتر <b className="font-medium text-fg">{txn.customer?.name}</b>، وترجع المعاملة غير مخصّصة.</p>
        <TextField label="السبب" value={reason} onChange={setReason} isRequired autoFocus placeholder="مثلاً: خُصّصت للعميل الخطأ" />
      </div>
    </ConfirmMoney>
  );
}

// ---------------------------------------------------------------- note
function NoteDialog({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const [note, setNote] = useState(txn.note ?? '');
  const { run, pending } = useAction();
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="sm" title="ملاحظتي على المعاملة"
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isDisabled={pending} onPress={async () => { const r = await run(() => api.txnSetNote(txn.id, note.trim() || null), 'حُفظت الملاحظة'); if (r.ok) onClose(); }}>حفظ</Button>
      </>}>
      <TextField label="الملاحظة" multiline value={note} onChange={setNote} autoFocus />
    </Dialog>
  );
}

// ---------------------------------------------------------------- manual
function ManualDialog({ rawEmailId, prefill, onClose }: { rawEmailId?: number; prefill?: { payerName?: string; occurredAt?: string }; onClose: () => void }) {
  const [f, setF] = useState({
    occurredAt: prefill?.occurredAt ?? nowLocalMinute(), payerName: prefill?.payerName ?? '', payerEmail: '', payerNote: '',
    currency: 'USD', grossText: '', feeText: '', paypalTxnId: '', note: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { run, pending } = useAction();
  const set = (k: keyof typeof f) => (v: string) => { setF((x) => ({ ...x, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };
  const submit = async () => {
    if (!f.grossText.trim()) return setErrors({ grossText: 'المبلغ الأصلي إلزامي' });
    const r = await run(() => api.txnCreateManual({
      occurredAt: f.occurredAt, currency: f.currency, grossText: f.grossText.trim(),
      payerName: f.payerName.trim() || undefined, payerEmail: f.payerEmail.trim() || undefined, payerNote: f.payerNote.trim() || undefined,
      feeText: f.feeText.trim() || undefined, paypalTxnId: f.paypalTxnId.trim() || undefined, note: f.note.trim() || undefined, rawEmailId,
    }), 'أُضيفت المعاملة');
    if (r.ok) onClose();
    else if (r.error.field) setErrors({ [r.error.field === 'gross' ? 'grossText' : r.error.field === 'fee' ? 'feeText' : r.error.field]: r.error.messageAr });
  };
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="lg" title={rawEmailId ? 'إنشاء معاملة من الرسالة' : 'إضافة معاملة يدوياً'}
      description={rawEmailId ? 'تُربط المعاملة بالرسالة الأصلية' : undefined}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" onPress={submit} isDisabled={pending}>إضافة</Button>
      </>}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <DatePicker label="التاريخ والوقت" withTime value={f.occurredAt} onChange={(v) => set('occurredAt')(v ?? '')} isRequired />
        <TextField label="رقم معاملة PayPal" ltr value={f.paypalTxnId} onChange={set('paypalTxnId')} description="اتركه فارغاً لرقم تلقائي" errorMessage={errors.paypalTxnId} />
        <TextField label="المرسل" value={f.payerName} onChange={set('payerName')} />
        <TextField label="الإيميل" ltr value={f.payerEmail} onChange={set('payerEmail')} />
        <div className="col-span-2 grid grid-cols-[140px_1fr_1fr] gap-4">
          <div className="flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">العملة</span>
            <Select label="العملة" value={f.currency} onChange={(k) => set('currency')(String(k))} options={CURRENCIES.map((c) => ({ id: c, label: c }))} /></div>
          <TextField label="المبلغ الأصلي" ltr suffix={f.currency} placeholder="0.00" value={f.grossText} onChange={set('grossText')} isRequired errorMessage={errors.grossText} />
          <TextField label="رسوم PayPal" ltr suffix={f.currency} placeholder="فارغ = تحتاج رسوم" value={f.feeText} onChange={set('feeText')} errorMessage={errors.feeText} />
        </div>
        <TextField label="ملاحظة المرسل" value={f.payerNote} onChange={set('payerNote')} />
        <TextField label="ملاحظتي" value={f.note} onChange={set('note')} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- bulk
function BulkApproveDialog({ rows, onClose, onDone }: { rows: Transaction[]; onClose: () => void; onDone: (r: BulkResult) => void }) {
  const { run, pending } = useAction();
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={`اعتماد ${rows.length} معاملة`}
      description="يُضاف لكل عميل قيد بالمبلغ المقابل له"
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isDisabled={pending} onPress={async () => { const r = await run(() => api.txnBulk({ action: 'approve', ids: rows.map((x) => x.id) })); if (r.ok) onDone(r.value); }}>اعتماد الكل</Button>
      </>}>
      <ul className="divide-y divide-line rounded-card border border-line">
        {rows.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 truncate"><span className="text-fg">{t.customer?.name ?? '—'}</span> <span className="text-fg-3">من <bdi>{t.payerName}</bdi></span></span>
            {t.customerAmountMinor !== null ? <Amount minor={t.customerAmountMinor} currency={t.currency} className="font-medium" /> : <span className="text-[13px] text-warn">لا يمكن اعتمادها</span>}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function BulkResultDialog({ title, result, rows, onClose }: { title: string; result: BulkResult; rows: Transaction[]; onClose: () => void }) {
  const name = (id: number) => rows.find((r) => r.id === id)?.payerName ?? `#${id}`;
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={`${title}: نجح ${result.ok.length}، فشل ${result.failed.length}`}
      footer={<Button variant="primary" onPress={onClose}>تم</Button>}>
      <ul className="divide-y divide-line rounded-card border border-line">
        {result.failed.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <bdi className="text-fg">{name(f.id)}</bdi>
            <span className="text-neg">{f.messageAr}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
