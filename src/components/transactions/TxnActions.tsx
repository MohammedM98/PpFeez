import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BulkResult, CommissionInput, CommissionMode, FeeInput, Transaction, TxnAction } from '@/lib/contract';
import { bpsToPercentText, formatBps, formatMinor, percentTextToBps } from '@/lib/money';
import { formatDateTime, nowLocalMinute } from '@/lib/dates';
import { useAction } from '@/lib/useAction';
import { txnCountLabel } from '@/lib/strings';
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
import { DangerConfirm, deletedToast } from '@/components/ui/DangerConfirm';
import { Breakdown, fromTxn } from './bits';
import { usePreview } from './usePreview';
import { StatementCheckbox, addToStatementAfter, useStatementChoice } from '@/components/customers/CustomerExcel';

export const CURRENCIES = ['USD', 'EUR', 'TRY', 'GBP', 'SAR', 'AED', 'CAD', 'AUD', 'JPY'];

export const actionLabel: Record<TxnAction, string> = {
  assign: 'تخصيص لعميل', unassign: 'إلغاء التخصيص', set_fee: 'تعديل الرسوم', set_commission: 'تعديل العمولة',
  approve: 'اعتماد', unapprove: 'إلغاء الاعتماد', exclude: 'استبعاد', include: 'إرجاع', edit_note: 'تعديل الملاحظة',
  confirm_review: 'تأكيد البيانات', edit_details: 'تعديل البيانات', delete: 'حذف',
};

type Open =
  | { kind: 'assign' | 'fee' | 'commission' | 'approve' | 'unapprove' | 'note' | 'confirm_review' | 'edit_details'; txn: Transaction }
  | { kind: 'manual'; rawEmailId?: number; prefill?: { payerName?: string; occurredAt?: string } }
  | { kind: 'move'; txn: Transaction }
  | { kind: 'bulk_assign'; ids: number[] }
  | { kind: 'bulk_approve'; rows: Transaction[] }
  | { kind: 'delete'; rows: Transaction[] }
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
        case 'confirm_review': return setState({ kind: 'confirm_review', txn: t });
        case 'edit_details': return setState({ kind: 'edit_details', txn: t });
        case 'delete': return setState({ kind: 'delete', rows: [t] });
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
      {state?.kind === 'move' && <AssignDialog txn={state.txn} move onClose={close} />}
      {state?.kind === 'bulk_assign' && <AssignDialog ids={state.ids} onClose={close} onBulk={(res, title) => setState({ kind: 'bulk_result', result: res, title, rows: [] })} />}
      {state?.kind === 'fee' && <FeeDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'commission' && <CommissionDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'approve' && <ApproveDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'unapprove' && <UnapproveDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'note' && <NoteDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'confirm_review' && <ConfirmReviewDialog txn={state.txn} onClose={close} onEdit={() => setState({ kind: 'edit_details', txn: state.txn })} />}
      {state?.kind === 'edit_details' && <EditDetailsDialog txn={state.txn} onClose={close} />}
      {state?.kind === 'manual' && <ManualDialog rawEmailId={state.rawEmailId} prefill={state.prefill} onClose={close} />}
      {state?.kind === 'bulk_approve' && <BulkApproveDialog rows={state.rows} onClose={close} onDone={(res) => reportBulk('الاعتماد', res, state.rows, setState)} />}
      {state?.kind === 'delete' && <DeleteTxnsDialog rows={state.rows} onClose={close} onFailed={(res) => setState({ kind: 'bulk_result', title: 'الحذف', result: res, rows: state.rows })} />}
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
/** Where a transaction lives after it is assigned (SPEC 6.3); the host sits above the router. */
export function customerTxnsHref(customerId: number, sub: 'pending_approval' | 'approved', txnId?: number) {
  return `#/customers/${customerId}?tab=txns&sub=${sub}${txnId ? `&detail=${txnId}` : ''}`;
}
const go = (href: string) => { window.location.hash = href.slice(1); };

/**
 * Assign (one or many) or, with `move`, move a pending transaction to another customer
 * (= unassign, then assign). The row leaves the inbox; the toast offers "فتح" and "تراجع".
 */
function AssignDialog({ txn, ids, move, onClose, onBulk }: { txn?: Transaction; ids?: number[]; move?: boolean; onClose: () => void; onBulk?: (r: BulkResult, title: string) => void }) {
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

  // the preview of a pending transaction keeps its current commission; a move starts from the new customer's
  const preview = usePreview(txn && customerId && !move ? { id: txn.id, customerId, commission: c.input } : null);
  const p = preview.data;
  const canApprove = !!txn && txn.feeMinor !== null && !move;
  const items = (customers.data ?? []).filter((x) => !move || x.id !== txn?.customer?.id)
    .map((x) => ({ id: x.id, label: x.name, hint: <bdi dir="ltr" className="num">{formatBps(x.defaultCommissionBps)}</bdi> }));

  const submit = async () => {
    if (!customerId || !customer) return;
    const name = customer.name;
    if (txn) {
      const approved = approve && canApprove;
      if (move) {
        // two calls (SPEC 6.5): if the second fails the transaction is simply back in the inbox
        const off = await run(() => api.txnUnassign(txn.id));
        if (!off.ok) return;
        const on = await run(() => api.txnAssign(txn.id, customerId, c.input), undefined, { quiet: () => true });
        if (!on.ok) {
          onClose();
          toast.error(`لم تُنقل إلى ${name}: ${on.error.messageAr}`, 'أُلغي تخصيصها وهي الآن في الوارد، ولم يتغيّر أي مبلغ. خصّصها من هناك.');
          return;
        }
      }
      const r = move ? { ok: true as const } : await run(() => api.txnAssign(txn.id, customerId, c.input, approved));
      if (!r.ok) return;
      onClose();
      toast.action(approved ? `اعتُمدت ونُقلت إلى ${name}` : `نُقلت إلى ${name}`, [
        { label: 'فتح', onPress: () => go(customerTxnsHref(customerId, approved ? 'approved' : 'pending_approval', txn.id)) },
        // undoing an approval needs a reason, so an approved move is undone from the customer page
        ...(approved || move ? [] : [{ label: 'تراجع', onPress: () => void run(() => api.txnUnassign(txn.id), 'أُعيدت إلى الوارد') }]),
      ]);
    } else if (ids) {
      const r = await run(() => api.txnBulk({ action: 'assign', ids, customerId, commission: c.input }));
      if (!r.ok) return;
      const moved = r.value.ok;
      if (r.value.failed.length === 0) onClose();
      else onBulk?.(r.value, 'التخصيص');
      if (moved.length) {
        toast.action(`نُقلت ${txnCountLabel(moved.length)} إلى ${name}`, [
          { label: 'فتح', onPress: () => go(customerTxnsHref(customerId, 'pending_approval')) },
          { label: 'تراجع', onPress: () => void run(() => api.txnBulk({ action: 'unassign', ids: moved }), 'أُعيدت إلى الوارد') },
        ]);
      }
    }
  };

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md"
      title={move ? 'نقل لعميل آخر' : txn ? 'تخصيص لعميل' : `تخصيص ${ids?.length} معاملة لعميل`}
      description={txn && <>دفعة من <bdi>{txn.payerName || txn.payerEmail}</bdi> بقيمة <Amount minor={txn.grossMinor} currency={txn.currency} />{move && txn.customer && <> مخصّصة الآن لـ {txn.customer.name}</>}</>}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isDisabled={!customerId || !!c.pctError || (!!p?.error && !!txn)} isPending={pending} onPress={submit}>
          {approve && canApprove ? <>تخصيص واعتماد {p?.customerAmountMinor != null && <Amount minor={p.customerAmountMinor} currency={txn!.currency} className="[&_span]:text-accent-fg/75" />}</> : move ? 'نقل' : 'تخصيص'}
        </Button>
      </>}>
      <div className="flex flex-col gap-4">
        <ComboBox key={customers.isSuccess ? 'ready' : 'loading'} label="العميل" items={items} value={customerId} onChange={(k) => setCustomerId(k === null ? null : Number(k))}
          placeholder={customers.isSuccess ? 'ابحث باسم العميل' : 'جارٍ تحميل العملاء…'} isDisabled={!customers.isSuccess} autoFocus />
        <CommissionFields c={c} currency={txn?.currency ?? ''} />
        {txn && !move && (
          <Breakdown title="معاينة" v={{
            currency: txn.currency, gross: txn.grossMinor, fee: txn.feeMinor, net: p?.netMinor ?? txn.netMinor,
            commission: customerId ? p?.commissionMinor ?? null : null, toCustomer: customerId ? p?.customerAmountMinor ?? null : null, commissionHint: customerId ? c.hint : undefined,
          }} />
        )}
        {p?.error && <p className="text-[13px] text-neg">{p.error.messageAr}</p>}
        {move && <p className="text-[13px] text-fg-3">تُلغى من {txn?.customer?.name} وتُخصَّص للعميل الجديد بعمولته، وتبقى بانتظار الموافقة</p>}
        {txn && !move && (
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
        <Button variant="quiet" className="me-auto" onPress={() => save({ kind: 'zero' }, 'سُجّلت بلا رسوم')} isPending={pending}>بلا رسوم</Button>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isDisabled={!input || !!p?.error} isPending={pending} onPress={() => input && save(input, 'حُفظت الرسوم')}>حفظ</Button>
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
            <Button size="sm" variant="secondary" onPress={() => save({ kind: 'accept_estimate' }, 'اعتُمد التقدير')} isPending={pending}>تأكيد التقدير</Button>
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
        <Button variant="primary" isDisabled={!c.input || !!p?.error} isPending={pending} onPress={async () => { const r = await run(() => api.txnSetCommission(txn.id, c.input!), 'عُدّلت العمولة'); if (r.ok) onClose(); }}>حفظ</Button>
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
  const customerId = txn.customer?.id;
  const statement = useStatementChoice(customerId);
  const qc = useQueryClient();
  return (
    <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title="اعتماد المعاملة" amount={txn.customerAmountMinor} currency={txn.currency}
      confirmLabel="اعتماد" pending={pending}
      onConfirm={async () => {
        const r = await run(() => api.txnApprove(txn.id), `اعتُمدت وأُضيفت لرصيد ${txn.customer?.name}`);
        if (!r.ok) return;
        onClose();
        if (customerId !== undefined && statement.on) void addToStatementAfter(customerId, { kind: 'txn', id: txn.id }, qc);
      }}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-2">يُضاف هذا المبلغ إلى رصيد <b className="font-medium text-fg">{txn.customer?.name}</b> كقيد جديد في دفتره، وتُقفل المعاملة عن التعديل.</p>
        {customerId !== undefined && <StatementCheckbox customerId={customerId} value={statement.value} onChange={statement.setValue} />}
      </div>
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
// ---------------------------------------------------------------- delete (SPEC 4.7)
function DeleteTxnsDialog({ rows, onClose, onFailed }: { rows: Transaction[]; onClose: () => void; onFailed: (r: BulkResult) => void }) {
  const ids = rows.map((r) => r.id);
  const preview = useQuery({ queryKey: ['txn_delete_preview', ids], queryFn: () => api.txnDeletePreview(ids), staleTime: 0 });
  const { run, pending } = useAction();
  const p = preview.data;
  const one = rows.length === 1 ? rows[0] : null;
  return (
    <DangerConfirm title={one ? 'حذف المعاملة' : `حذف ${rows.length} معاملة`} confirmLabel="حذف نهائياً" pending={pending} isLoading={!p}
      backup={rows.length > 1 ? 'auto' : 'none'} onClose={onClose}
      onConfirm={async (reason) => {
        const r = await run(() => api.txnDelete(ids, reason || undefined));
        if (!r.ok) return;
        if (r.value.failed.length) onFailed(r.value);
        else { deletedToast(one ? 'حُذفت المعاملة' : `حُذفت ${txnCountLabel(r.value.ok.length)}`, r.value.backup); onClose(); }
      }}>
      {one && (
        <div className="rounded-card bg-raised/60 px-4 py-3 text-sm">
          <bdi className="text-fg">{one.payerName ?? '—'}</bdi>{' '}<Amount minor={one.grossMinor} currency={one.currency} />
          <div className="text-[12.5px] text-fg-3"><bdi dir="ltr" className="num">{one.paypalTxnId}</bdi></div>
        </div>
      )}
      {p && p.approvedCount > 0 && (
        <div className="rounded-card bg-neg-soft px-4 py-3 text-sm">
          <p className="font-medium text-neg">
            {one ? 'المعاملة معتمدة' : `${p.approvedCount} منها معتمدة`}: سيُحذف {p.ledgerEntryCount === 1 ? 'قيد واحد' : `${p.ledgerEntryCount} قيود`} من دفاتر العملاء
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-fg-2">
            {p.effects.map((e) => (
              <li key={`${e.customerId}-${e.currency}`} className="flex items-center justify-between gap-3">
                <span>رصيد {e.customerName}</span>
                <Amount minor={e.balanceDeltaMinor} currency={e.currency} className={e.balanceDeltaMinor < 0 ? 'text-neg' : 'text-pos'} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {p && p.approvedCount === 0 && <p className="text-sm text-fg-2">{one ? 'المعاملة غير معتمدة، فلا تتغيّر أي أرصدة.' : 'لا معاملة معتمدة بينها، فلا تتغيّر أي أرصدة.'}</p>}
      <p className="text-[13px] text-fg-3">لا تعود في السحب التالي. رسالتها الأصلية تبقى في «الرسائل ← متجاهلة» ويمكن إعادتها بإعادة التحليل.</p>
    </DangerConfirm>
  );
}

// ---------------------------------------------------------------- review (SPEC 5.3)
function ConfirmReviewDialog({ txn, onClose, onEdit }: { txn: Transaction; onClose: () => void; onEdit: () => void }) {
  const { run, pending } = useAction();
  return (
    <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title="تأكيد بيانات المعاملة" amount={txn.grossMinor} currency={txn.currency}
      confirmLabel="البيانات صحيحة" pending={pending}
      onConfirm={async () => { const r = await run(() => api.txnConfirmReview(txn.id), 'أُكّدت البيانات'); if (r.ok) onClose(); }}>
      <div className="flex flex-col gap-3 text-sm text-fg-2">
        {txn.reviewReasonAr && <p className="rounded-card bg-warn-soft px-3 py-2 text-warn">{txn.reviewReasonAr}</p>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5">
          <dt className="text-fg-3">المرسل</dt><dd><bdi>{txn.payerName ?? '—'}</bdi></dd>
          <dt className="text-fg-3">الإيميل</dt><dd><bdi dir="ltr">{txn.payerEmail ?? '—'}</bdi></dd>
          <dt className="text-fg-3">التاريخ</dt><dd><bdi dir="ltr" className="num">{formatDateTime(txn.occurredAt)}</bdi></dd>
          <dt className="text-fg-3">رقم PayPal</dt><dd><bdi dir="ltr" className="num">{txn.paypalTxnId}</bdi></dd>
        </dl>
        <p>قارن المبلغ والعملة والمرسل بالرسالة الأصلية. بعد التأكيد يمكن اعتماد المعاملة.</p>
        <button className="self-start text-[13px] text-accent-ink hover:underline" onClick={onEdit}>البيانات خاطئة؟ تعديلها</button>
      </div>
    </ConfirmMoney>
  );
}

function EditDetailsDialog({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const [f, setF] = useState({
    payerName: txn.payerName ?? '', payerEmail: txn.payerEmail ?? '', currency: txn.currency,
    grossText: formatMinor(txn.grossMinor, txn.currency).replace(/,/g, ''), occurredAt: formatDateTime(txn.occurredAt),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { run, pending } = useAction();
  const set = (k: keyof typeof f) => (v: string) => { setF((x) => ({ ...x, [k]: v })); setErrors({}); };
  const currencies = [...new Set([txn.currency, ...CURRENCIES, 'ILS', 'EGP'])];
  const submit = async () => {
    const r = await run(() => api.txnEditDetails(txn.id, {
      payerName: f.payerName.trim(), payerEmail: f.payerEmail.trim(), currency: f.currency, grossText: f.grossText.trim(), occurredAt: f.occurredAt,
    }), 'حُفظت البيانات', { quiet: (e) => !!e.field });
    if (r.ok) onClose();
    else if (r.error.field) setErrors({ [r.error.field === 'gross' ? 'grossText' : r.error.field]: r.error.messageAr });
  };
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="lg" title="تعديل بيانات المعاملة"
      description={<>كما تظهر في رسالة PayPal الأصلية. رقم المعاملة <bdi dir="ltr" className="num">{txn.paypalTxnId}</bdi> لا يتغيّر</>}
      footer={<><Button variant="secondary" onPress={onClose}>تراجع</Button><Button variant="primary" onPress={submit} isPending={pending}>حفظ</Button></>}>
      <div className="grid grid-cols-2 gap-4">
        <TextField label="المرسل" value={f.payerName} onChange={set('payerName')} autoFocus errorMessage={errors.payerName} />
        <TextField label="الإيميل" ltr value={f.payerEmail} onChange={set('payerEmail')} errorMessage={errors.payerEmail} />
        <div className="col-span-2 grid grid-cols-[140px_1fr_1fr] gap-4">
          <div className="flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">العملة</span>
            <Select label="العملة" value={f.currency} onChange={(k) => set('currency')(String(k))} options={currencies.map((c) => ({ id: c, label: c }))} />
            {errors.currency && <span className="text-[12.5px] text-neg">{errors.currency}</span>}</div>
          <TextField label="المبلغ الأصلي" ltr suffix={f.currency} value={f.grossText} onChange={set('grossText')} errorMessage={errors.grossText} />
          <DatePicker label="التاريخ والوقت" withTime value={f.occurredAt} onChange={(v) => set('occurredAt')(v ?? '')} />
        </div>
        {txn.feeMinor !== null && <p className="col-span-2 text-[12.5px] text-fg-3">بعد تغيير المبلغ راجع الرسوم أيضاً، فالصافي والعمولة يُحسبان منها</p>}
      </div>
    </Dialog>
  );
}

function NoteDialog({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const [note, setNote] = useState(txn.note ?? '');
  const { run, pending } = useAction();
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="sm" title="ملاحظتي على المعاملة"
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isPending={pending} onPress={async () => { const r = await run(() => api.txnSetNote(txn.id, note.trim() || null), 'حُفظت الملاحظة'); if (r.ok) onClose(); }}>حفظ</Button>
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
        <Button variant="primary" onPress={submit} isPending={pending}>إضافة</Button>
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
/** Bulk approve; the total per currency comes from the core (txn_list with ids), never added up here. */
function BulkApproveDialog({ rows, onClose, onDone }: { rows: Transaction[]; onClose: () => void; onDone: (r: BulkResult) => void }) {
  const { run, pending } = useAction();
  const ids = rows.map((x) => x.id);
  const totals = useQuery({
    queryKey: ['txn_list', 'approve-totals', ids],
    queryFn: () => api.txnList({ ids, status: 'pending_approval' }, { key: 'occurredAt', dir: 'desc' }, 1, ids.length),
  });
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={`اعتماد ${txnCountLabel(rows.length)}`}
      description="يُضاف لكل عميل قيد بالمبلغ المقابل له"
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" isPending={pending} isDisabled={totals.isLoading} onPress={async () => { const r = await run(() => api.txnBulk({ action: 'approve', ids })); if (r.ok) onDone(r.value); }}>اعتماد الكل</Button>
      </>}>
      {!!totals.data?.totals.length && (
        <div className="mb-3 rounded-card bg-raised/60 px-4 py-3">
          <div className="mb-1 text-[13px] text-fg-3">المجموع للعملاء</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {totals.data.totals.map((x) => (
              <span key={x.currency} className="text-[17px] font-medium">
                <Amount minor={x.customerAmountMinor} currency={x.currency} className="text-accent-ink" />
                <span className="num ms-2 text-[13px] font-normal text-fg-3">{txnCountLabel(x.count)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      <ul className="max-h-[300px] divide-y divide-line overflow-auto rounded-card border border-line">
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
