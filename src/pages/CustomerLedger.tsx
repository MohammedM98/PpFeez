import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs, TabList, Tab, TabPanel, MenuTrigger, Menu, MenuItem, Popover } from 'react-aria-components';
import { ArrowRight, Check, Download, FileCheck2, FileSpreadsheet, HandCoins, MoreHorizontal, Pencil, Printer, Scale, Trash2, X } from 'lucide-react';
import { toast } from '@/components/ui/Toast';
import { api, native } from '@/lib/api';
import type { BalanceCard, Customer, LedgerEntry, PayoutMethod, Period } from '@/lib/contract';
import { ledgerType, payoutMethod } from '@/lib/strings';
import { formatBps } from '@/lib/money';
import { todayLocal } from '@/lib/dates';
import { periodLabels, presetPeriod, type PeriodPreset } from '@/lib/period';
import { useAction } from '@/lib/useAction';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Amount, amountFit, amountWidth } from '@/components/ui/Amount';
import { HeadLabel, SELECT_W, TableFrame, TotalsCell, TotalsTable, sumWidths } from '@/components/ui/Table';
import { Trunc } from '@/components/ui/Trunc';
import { Badge } from '@/components/ui/Badge';
import { Checkbox, Select } from '@/components/ui/Field';
import { DatePicker, DateRangePicker } from '@/components/ui/DateFields';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/TextField';
import { Segmented } from '@/components/ui/Segmented';
import { ConfirmMoney } from '@/components/ui/ConfirmMoney';
import { cx } from '@/components/ui/cx';
import { TransactionsView } from '@/components/transactions/TransactionsView';
import { CURRENCIES } from '@/components/transactions/TxnActions';
import { CustomerDialog, DeleteCustomerDialog } from './Customers';
import { DangerConfirm, deletedToast } from '@/components/ui/DangerConfirm';
import { AddToStatementDialog, CustomerExcelCard, StatementCheckbox, addToStatementAfter, useStatementChoice } from '@/components/customers/CustomerExcel';

const tabCls = ({ isSelected }: { isSelected: boolean }) => cx(
  'relative -mb-px flex h-10 cursor-default items-center gap-2 px-3 text-sm outline-none transition-colors duration-150',
  'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
  isSelected ? 'text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent' : 'text-fg-3 hover:text-fg-2');

function BalanceCards({ cards }: { cards: BalanceCard[] }) {
  if (!cards.length) return <p className="mb-6 text-sm text-fg-3">لا قيود بعد. تظهر الأرصدة بعد أول اعتماد أو تسوية.</p>;
  return (
    <div className="mb-6 flex flex-wrap gap-3">
      {cards.map((c) => (
        <div key={c.currency} className="min-w-[260px] flex-1 rounded-card border border-line bg-surface p-4 lg:max-w-[360px]">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-fg-3">المتبقي له</span>
            <span className="text-[12.5px] text-fg-3">{c.currency}</span>
          </div>
          <div className={cx('mt-1 text-[28px] font-medium leading-tight', c.balanceMinor < 0 ? 'text-neg' : 'text-fg')}>
            <Amount minor={c.balanceMinor} currency={c.currency} showCurrency={false} />
            {c.balanceMinor < 0 && <span className="ms-2 text-[14px]">عليه</span>}
          </div>
          <dl className="mt-3 flex gap-6 border-t border-line pt-3 text-[13px]">
            <div><dt className="text-fg-3">مجموع ما له</dt><dd><Amount minor={c.creditsMinor} currency={c.currency} showCurrency={false} className="text-fg-2" /></dd></div>
            <div><dt className="text-fg-3">ما دُفع وخُصم</dt><dd><Amount minor={c.debitsMinor} currency={c.currency} showCurrency={false} className="text-fg-2" /></dd></div>
          </dl>
        </div>
      ))}
    </div>
  );
}

function LedgerTable({ customer, currency }: { customer: Customer; currency: string }) {
  const navigate = useNavigate();
  const [preset, setPreset] = useState<PeriodPreset>('all');
  const [custom, setCustom] = useState<Period>({});
  const [reversing, setReversing] = useState<LedgerEntry | null>(null);
  const [deleting, setDeleting] = useState<LedgerEntry | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  // SPEC 6.8.2: pick entries to add to the customer's Excel statement
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const period = preset === 'custom' ? custom : presetPeriod(preset);
  const view = useQuery({ queryKey: ['ledger_entries', customer.id, currency, period], queryFn: () => api.ledgerEntries(customer.id, currency, period.from || period.to ? period : undefined) });
  const { run } = useAction();

  const jump = (id: number) => {
    setFlash(id);
    document.getElementById(`entry-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => setFlash(null), 1600);
  };
  const exportCsv = async () => {
    const path = await native.saveCsv(`${customer.name}-${currency}.csv`);
    if (path) await run(() => api.ledgerExportCsv(customer.id, currency, path, period.from || period.to ? period : undefined), 'صُدّر الكشف');
  };
  const exportExcel = async () => {
    const path = await native.saveXlsx(`${customer.name}-${currency}.xlsx`);
    if (!path) return;
    const r = await run(() => api.excelExportLedger(customer.id, path, currency, period.from || period.to ? period : undefined));
    if (r.ok) toast.ok('صُدّر كشف الحساب إلى Excel', r.value.path);
  };
  const print = () => {
    const p = new URLSearchParams({ currency, ...(period.from ? { from: period.from } : {}), ...(period.to ? { to: period.to } : {}) });
    navigate(`/statement/${customer.id}?${p}`);
  };

  const v = view.data;
  const fit = useMemo(() => {
    const es = v?.entries ?? [];
    const of = (xs: (number | null)[]) => amountFit(xs.map((minor) => ({ minor, currency })));
    return {
      credit: of(es.map((e) => (e.amountMinor > 0 ? e.amountMinor : null))),
      debit: of(es.map((e) => (e.amountMinor < 0 ? -e.amountMinor : null))),
      running: of([...es.map((e) => e.runningBalanceMinor), v?.openingBalanceMinor ?? null, v?.closingBalanceMinor ?? null]),
    };
  }, [v, currency]);
  const LW = useMemo(() => {
    const w = {
      select: SELECT_W, date: '96px', type: '76px', ref: '96px', excel: '40px', menu: '48px',
      credit: amountWidth(fit.credit, false, 76), debit: amountWidth(fit.debit, false, 76), running: amountWidth(fit.running, false, 96),
    };
    return { ...w, min: sumWidths([...Object.values(w), '150px']) };
  }, [fit]);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Select label="الفترة" value={preset} onChange={(k) => setPreset(k as PeriodPreset)} className="w-[140px]"
          options={(Object.keys(periodLabels) as PeriodPreset[]).map((k) => ({ id: k, label: periodLabels[k] }))} />
        {preset === 'custom' && <DateRangePicker label="الفترة المخصّصة" value={custom} onChange={setCustom} className="w-[250px]" />}
        <div className="ms-auto flex gap-2">
          <Button variant="secondary" size="sm" onPress={exportExcel}><FileSpreadsheet />تصدير Excel</Button>
          <Button variant="secondary" size="sm" onPress={exportCsv}><Download />تصدير CSV</Button>
          <Button variant="secondary" size="sm" onPress={print}><Printer />طباعة كشف</Button>
        </div>
      </div>
      {picked.size > 0 && (
        <div className="mb-3 flex h-11 items-center gap-1 rounded-card bg-accent-soft pe-2 ps-4 text-sm" role="toolbar" aria-label="إجراءات على القيود المحددة">
          <span className="me-3 text-fg">محدّد <span className="num">{picked.size}</span></span>
          <Button size="sm" variant="quiet" onPress={() => setAdding(true)}><FileSpreadsheet />إضافة إلى ملف العميل</Button>
          <Button size="icon" variant="quiet" aria-label="إلغاء التحديد" className="ms-auto" onPress={() => setPicked(new Set())}><X /></Button>
        </div>
      )}
      <TableFrame>
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm" style={{ minWidth: LW.min }} aria-label={`دفتر ${currency}`}>
          <colgroup>
            <col style={{ width: LW.select }} /><col style={{ width: LW.date }} /><col style={{ width: LW.type }} /><col />
            <col style={{ width: LW.credit }} /><col style={{ width: LW.debit }} /><col style={{ width: LW.running }} />
            <col style={{ width: LW.ref }} /><col style={{ width: LW.excel }} /><col style={{ width: LW.menu }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="[&>th]:bg-surface [&>th]:h-10 [&>th]:overflow-hidden [&>th]:border-b [&>th]:border-line [&>th]:px-2.5 [&>th]:font-normal [&>th]:whitespace-nowrap">
              <th className="sticky z-[2] !ps-4 text-start" data-sticky="start-inner" style={{ insetInlineStart: 0 }}>
                <Checkbox aria-label="تحديد كل القيود" isSelected={!!v?.entries.length && picked.size === v.entries.length}
                  isIndeterminate={picked.size > 0 && picked.size < (v?.entries.length ?? 0)}
                  onChange={(on) => setPicked(on ? new Set(v?.entries.map((e) => e.id)) : new Set())} />
              </th>
              <th className="sticky z-[2] text-start" data-sticky="start" style={{ insetInlineStart: SELECT_W }}><HeadLabel>التاريخ</HeadLabel></th>
              <th className="text-start"><HeadLabel>النوع</HeadLabel></th>
              <th className="text-start"><HeadLabel>الوصف</HeadLabel></th>
              <th className="text-end"><HeadLabel>له (+)</HeadLabel></th>
              <th className="text-end"><HeadLabel>عليه (−)</HeadLabel></th>
              <th className="text-end"><HeadLabel>الرصيد الجاري</HeadLabel></th>
              <th className="text-start"><HeadLabel>المرجع</HeadLabel></th>
              <th className="text-start"><span title="في ملف العميل" className="inline-flex text-fg-3"><FileCheck2 className="size-4" strokeWidth={1.7} aria-hidden /><span className="sr-only">في ملف العميل</span></span></th>
              <th className="sticky z-[2]" data-sticky="end" style={{ insetInlineEnd: 0 }}><span className="sr-only">إجراءات</span></th>
            </tr>
          </thead>
          <tbody className="[&>tr>td]:h-12 [&>tr>td]:border-b [&>tr>td]:border-line [&>tr>td]:px-2.5 [&>tr>td]:leading-tight [&>tr>td]:whitespace-nowrap [&>tr:last-child>td]:border-b-0">
            {v && period.from && (
              <tr className="t-row [--row-tint:color-mix(in_oklab,var(--raised)_40%,transparent)] text-fg-2">
                <td colSpan={6}>رصيد سابق حتى <bdi dir="ltr" className="num">{period.from}</bdi></td>
                <td className="text-end"><Amount fit={fit.running} minor={v.openingBalanceMinor} currency={currency} showCurrency={false} tone="signed" /></td>
                <td colSpan={3} />
              </tr>
            )}
            {v?.entries.map((e) => {
              const reversed = e.reversedByEntryId !== null;
              return (
                <tr key={e.id} id={`entry-${e.id}`} className={cx('t-row hover:[--row-tint:color-mix(in_oklab,var(--raised)_55%,transparent)]', flash === e.id && '[--row-tint:var(--accent-soft)]')}>
                  <td className="sticky z-[1] !ps-4" data-sticky="start-inner" style={{ insetInlineStart: 0 }}>
                    <Checkbox aria-label="تحديد القيد" isSelected={picked.has(e.id)}
                      onChange={(on) => setPicked((prev) => { const n = new Set(prev); if (on) n.add(e.id); else n.delete(e.id); return n; })} />
                  </td>
                  <td className="num sticky z-[1] text-fg-2" data-sticky="start" style={{ insetInlineStart: SELECT_W }}><bdi dir="ltr">{e.entryDate}</bdi></td>
                  <td><Badge tone={e.type === 'credit' ? 'pos' : e.type === 'payout' ? 'neutral' : e.type === 'reversal' ? 'neg' : 'outline'}>{ledgerType[e.type]}</Badge></td>
                  <td>
                    <Trunc className={cx(reversed && 'text-fg-3 line-through decoration-fg-3/60')}>{e.description}</Trunc>
                    <div className="flex gap-2 overflow-hidden text-[12px] text-fg-3">
                      {e.payoutMethod && payoutMethod[e.payoutMethod]}
                      {reversed && <button className="text-accent-ink hover:underline" onClick={() => jump(e.reversedByEntryId!)}>عُكس بقيد لاحق</button>}
                      {e.reversesEntryId !== null && <button className="text-accent-ink hover:underline" onClick={() => jump(e.reversesEntryId!)}>يعكس قيداً سابقاً</button>}
                    </div>
                  </td>
                  <td className="text-end">{e.amountMinor > 0 ? <Amount fit={fit.credit} minor={e.amountMinor} currency={currency} showCurrency={false} className={reversed ? 'text-fg-3 line-through' : 'text-pos'} /> : ''}</td>
                  <td className="text-end">{e.amountMinor < 0 ? <Amount fit={fit.debit} minor={-e.amountMinor} currency={currency} showCurrency={false} className={reversed ? 'text-fg-3 line-through' : ''} /> : ''}</td>
                  <td className="text-end font-medium"><Amount fit={fit.running} minor={e.runningBalanceMinor} currency={currency} showCurrency={false} className={e.runningBalanceMinor < 0 ? 'text-neg' : ''} /></td>
                  <td className="text-[13px] text-fg-3">{e.reference ? <div dir="ltr" className="truncate text-right" title={e.reference}>{e.reference}</div> : ''}</td>
                  <td>{e.inCustomerExcel && <span title="في ملف العميل" aria-label="في ملف العميل" className="inline-flex text-pos"><Check className="size-4" strokeWidth={2} /></span>}</td>
                  <td className="sticky z-[1] pe-2" data-sticky="end" style={{ insetInlineEnd: 0 }}>
                    <MenuTrigger>
                      <Button variant="quiet" size="icon" aria-label="إجراءات القيد"><MoreHorizontal /></Button>
                      <Popover placement="bottom end" className="w-60 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                        <Menu className="outline-none" disabledKeys={['no-delete']}
                          onAction={(k) => (k === 'txn' ? navigate(`/customers/${customer.id}?tab=txns&sub=approved&detail=${e.transactionId}`) : k === 'delete' ? setDeleting(e) : setReversing(e))}>
                          {e.transactionId !== null && <MenuItem id="txn" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">فتح المعاملة</MenuItem>}
                          {!reversed && e.reversesEntryId === null && <MenuItem id="reverse" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">عكس القيد</MenuItem>}
                          {e.deletable
                            ? <MenuItem id="delete" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm text-neg outline-none data-[focused]:bg-raised">حذف القيد</MenuItem>
                            : <MenuItem id="no-delete" textValue="لا يمكن حذفه" className="flex cursor-default flex-col rounded-[6px] px-2.5 py-1.5 text-[12.5px] leading-snug text-fg-3 outline-none">
                                <span className="text-fg-2">لا يمكن حذفه</span>{e.notDeletableReasonAr}
                              </MenuItem>}
                        </Menu>
                      </Popover>
                    </MenuTrigger>
                  </td>
                </tr>
              );
            })}
            {v && v.entries.length === 0 && <tr><td colSpan={10} className="py-10 text-center text-fg-3">لا قيود في هذه الفترة</td></tr>}
          </tbody>
        </table>
        {v && (
          <TotalsTable label="الرصيد الختامي" minWidth={LW.min} widths={[LW.select, LW.date, LW.type, undefined, LW.credit, LW.debit, LW.running, LW.ref, LW.excel, LW.menu]}>
            <tr>
              <TotalsCell sticky="start" colSpan={3} className="!ps-4 text-fg-2">الرصيد الختامي <span className="text-fg-3">{currency}</span></TotalsCell>
              <TotalsCell colSpan={3} />
              <TotalsCell align="end" className="text-sm font-medium"><Amount fit={fit.running} minor={v.closingBalanceMinor} currency={currency} showCurrency={false} className={v.closingBalanceMinor < 0 ? 'text-neg' : 'text-accent-ink'} /></TotalsCell>
              <TotalsCell colSpan={2} />
              <TotalsCell sticky="end" />
            </tr>
          </TotalsTable>
        )}
      </TableFrame>
      {reversing && <ReverseDialog entry={reversing} onClose={() => setReversing(null)} />}
      {deleting && <DeleteEntryDialog entry={deleting} onClose={() => setDeleting(null)} />}
      {adding && <AddToStatementDialog customer={customer} items={[...picked].map((id) => ({ kind: 'ledger' as const, id }))} onClose={() => setAdding(false)} onDone={() => setPicked(new Set())} />}
    </div>
  );
}

/** SPEC 4.7: a payout or adjustment (with its reversal pair); shows the balance before and after. */
function DeleteEntryDialog({ entry, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const preview = useQuery({ queryKey: ['ledger_delete_preview', entry.id], queryFn: () => api.ledgerDeletePreview(entry.id), staleTime: 0 });
  const { run, pending } = useAction();
  const p = preview.data;
  return (
    <DangerConfirm title={p && p.entries.length > 1 ? 'حذف القيد وعكسه' : 'حذف القيد'} confirmLabel="حذف نهائياً" pending={pending} isLoading={!p} backup="auto" onClose={onClose}
      onConfirm={async (reason) => {
        const r = await run(() => api.ledgerDeleteEntry(entry.id, reason || undefined));
        if (r.ok) { deletedToast(p && p.entries.length > 1 ? 'حُذف القيد وعكسه' : 'حُذف القيد', r.value.backup); onClose(); }
      }}>
      {p && (
        <div className="flex flex-col gap-3 text-sm">
          <ul className="divide-y divide-line rounded-card border border-line">
            {p.entries.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                <bdi dir="ltr" className="num text-[13px] text-fg-3">{e.entryDate}</bdi>
                <Badge tone={e.type === 'reversal' ? 'neg' : e.type === 'payout' ? 'neutral' : 'outline'}>{ledgerType[e.type]}</Badge>
                <span className="min-w-0 flex-1 truncate text-fg-2">{e.description}</span>
                <Amount minor={e.amountMinor} currency={e.currency} tone="signed" />
              </li>
            ))}
          </ul>
          {p.entries.length > 1 && <p className="text-[13px] text-fg-3">القيد معكوس، فيُحذف معه قيد عكسه.</p>}
          <div className="flex items-center justify-around rounded-card bg-raised/60 px-4 py-3 text-center">
            <div><div className="text-[12.5px] text-fg-3">الرصيد الآن</div><Amount minor={p.balanceBeforeMinor} currency={entry.currency} className="text-[17px] font-medium" /></div>
            <span className="text-fg-3" aria-hidden>←</span>
            <div><div className="text-[12.5px] text-fg-3">بعد الحذف</div><Amount minor={p.balanceAfterMinor} currency={entry.currency} className={cx('text-[17px] font-medium', p.balanceAfterMinor < 0 && 'text-neg')} /></div>
          </div>
        </div>
      )}
    </DangerConfirm>
  );
}

function ReverseDialog({ entry, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { run, pending } = useAction();
  return (
    <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title="عكس القيد" tone="danger" amount={-entry.amountMinor} currency={entry.currency}
      confirmLabel="عكس القيد" pending={pending} extraValid={reason.trim().length > 0}
      onConfirm={async () => { const r = await run(() => api.ledgerReverseEntry(entry.id, reason.trim()), 'عُكس القيد'); if (r.ok) onClose(); }}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">يُضاف قيد معاكس بوصف «عكس: {entry.description}»، ويبقى القيد الأصلي ظاهراً مشطوباً.</p>
        <TextField label="السبب" value={reason} onChange={setReason} isRequired autoFocus />
      </div>
    </ConfirmMoney>
  );
}

// ----------------------------------------------------------------- payout / adjustment
function MoneyEntryDialog({ kind, customer, currencies, defaultCurrency, onClose }: {
  kind: 'payout' | 'adjustment'; customer: Customer; currencies: string[]; defaultCurrency: string; onClose: () => void;
}) {
  const [currency, setCurrency] = useState(defaultCurrency);
  const [amountText, setAmountText] = useState('');
  const [entryDate, setEntryDate] = useState(todayLocal());
  const [method, setMethod] = useState<PayoutMethod>('cash');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [overdraw, setOverdraw] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { run, pending } = useAction();
  const isPayout = kind === 'payout';
  const statement = useStatementChoice(customer.id);
  const qc = useQueryClient();

  const next = () => {
    const e: Record<string, string> = {};
    if (!/^\s*[\d,]+(\.\d+)?\s*$/.test(amountText)) e.amount = 'أدخل مبلغاً مثل 150.00';
    if (!isPayout && !description.trim()) e.description = 'الوصف إلزامي للتسوية';
    setErrors(e);
    if (!Object.keys(e).length) setStep('confirm');
  };
  const submit = async (confirmOverdraw = false) => {
    const r = isPayout
      ? await run(() => api.ledgerAddPayout(customer.id, { currency, amountText: amountText.trim(), entryDate, method, reference: reference.trim() || undefined, description: description.trim() || undefined, confirmOverdraw }), 'سُجّلت الدفعة', { quiet: (e) => e.field === 'overdraw' })
      : await run(() => api.ledgerAddAdjustment(customer.id, { currency, amountText: amountText.trim(), direction, entryDate, description: description.trim() }), 'سُجّل قيد التسوية');
    if (r.ok) {
      onClose();
      if (statement.on) void addToStatementAfter(customer.id, { kind: 'ledger', id: r.value.id }, qc);
    }
    else if (r.error.field === 'overdraw') setOverdraw(r.error.messageAr);
    else if (r.error.field || r.error.code === 'invalid_amount') { setErrors({ [r.error.field ?? 'amount']: r.error.messageAr }); setStep('form'); }
  };

  if (step === 'confirm') {
    const signed = isPayout || direction === 'debit' ? `-${amountText.trim()}` : `+${amountText.trim()}`;
    return (
      <ConfirmMoney isOpen onOpenChange={(o) => !o && onClose()} title={isPayout ? `دفعة لـ ${customer.name}` : `تسوية في دفتر ${customer.name}`}
        amountText={signed} currency={currency} tone={overdraw ? 'danger' : 'primary'} pending={pending}
        confirmLabel={overdraw ? 'تأكيد رغم التجاوز' : isPayout ? 'تسجيل الدفعة' : 'تسجيل التسوية'}
        onConfirm={() => submit(!!overdraw)}>
        <div className="flex flex-col gap-2 text-sm text-fg-2">
          <p>{isPayout ? `${payoutMethod[method]}، بتاريخ ` : `${direction === 'credit' ? 'تُضاف إلى رصيده' : 'تُخصم من رصيده'}، بتاريخ `}<bdi dir="ltr" className="num">{entryDate}</bdi></p>
          {description && <p>{description}</p>}
          {overdraw && <p className="rounded-card bg-neg-soft px-3 py-2 text-neg">{overdraw}. بعد التسجيل يصبح الرصيد سالباً ويظهر «عليه».</p>}
          <StatementCheckbox customerId={customer.id} value={statement.value} onChange={statement.setValue} />
          <button className="self-start text-[13px] text-accent-ink hover:underline" onClick={() => { setStep('form'); setOverdraw(null); }}>تعديل البيانات</button>
        </div>
      </ConfirmMoney>
    );
  }

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md"
      title={isPayout ? `تسجيل دفعة لـ ${customer.name}` : `قيد تسوية لـ ${customer.name}`}
      description={isPayout ? 'مبلغ دفعته للعميل، يُخصم من رصيده' : 'رصيد افتتاحي، خصم، أو تصحيح'}
      footer={<><Button variant="secondary" onPress={onClose}>تراجع</Button><Button variant="primary" onPress={next}>متابعة</Button></>}>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 grid grid-cols-[120px_1fr] gap-3">
          <div className="flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">العملة</span>
            <Select label="العملة" value={currency} onChange={(k) => setCurrency(String(k))} options={currencies.map((c) => ({ id: c, label: c }))} /></div>
          <TextField label="المبلغ" ltr suffix={currency} placeholder="0.00" value={amountText} onChange={(v) => { setAmountText(v); setErrors({}); }} autoFocus isRequired errorMessage={errors.amount} />
        </div>
        {!isPayout && (
          <div className="col-span-2 flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">الاتجاه</span>
            <Segmented label="الاتجاه" value={direction} onChange={setDirection} options={[{ id: 'credit', label: 'له (يزيد رصيده)' }, { id: 'debit', label: 'عليه (ينقص رصيده)' }]} /></div>
        )}
        <DatePicker label="التاريخ" value={entryDate} onChange={(v) => setEntryDate(v ?? todayLocal())} />
        {isPayout && (
          <div className="flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">الطريقة</span>
            <Select label="الطريقة" value={method} onChange={(k) => setMethod(k as PayoutMethod)} options={(Object.keys(payoutMethod) as PayoutMethod[]).map((m) => ({ id: m, label: payoutMethod[m] }))} /></div>
        )}
        {isPayout && <TextField label="المرجع" ltr value={reference} onChange={setReference} description="رقم الحوالة أو TXID" className="col-span-2" />}
        <TextField label="الوصف" value={description} onChange={(v) => { setDescription(v); setErrors({}); }} isRequired={!isPayout} errorMessage={errors.description} className="col-span-2" />
      </div>
    </Dialog>
  );
}

export function CustomerLedgerPage() {
  const { id } = useParams();
  // a different customer is a fresh page (tabs, filters, selection)
  return <CustomerPage key={id} customerId={Number(id)} />;
}

function CustomerPage({ customerId }: { customerId: number }) {
  const [params] = useSearchParams();
  const customer = useQuery({ queryKey: ['customer', customerId], queryFn: () => api.customerGet(customerId) });
  const cards = useQuery({ queryKey: ['ledger_balances', customerId], queryFn: () => api.ledgerBalances(customerId) });
  const pTab = params.get('tab');
  const [tab, setTab] = useState<string | null>(pTab === 'txns' ? 'txns' : null);
  // links into this page ("فتح" after assigning, search results, the ledger's "فتح المعاملة")
  useEffect(() => { if (pTab === 'txns') setTab('txns'); }, [pTab, params]);
  const [dialog, setDialog] = useState<'payout' | 'adjustment' | 'edit' | 'delete' | null>(null);
  const navigate = useNavigate();
  const currencies = cards.data?.map((c) => c.currency) ?? [];
  useEffect(() => { if (tab === null && cards.data) setTab(cards.data[0]?.currency ?? 'txns'); }, [cards.data, tab]);

  const c = customer.data;
  if (customer.isError) return <div className="p-8 text-fg-2">العميل غير موجود. <Link to="/customers" className="text-accent-ink">العودة للعملاء</Link></div>;
  if (!c) return null;
  const allCurrencies = [...new Set([...currencies, ...CURRENCIES])];
  const activeCurrency = tab && tab !== 'txns' ? tab : currencies[0] ?? 'USD';

  return (
    <div className="mx-auto flex min-h-full max-w-[1560px] flex-col px-6 pb-8 pt-6">
      <PageHeader
        back={<Link to="/customers" className="mb-1 inline-flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg-2"><ArrowRight className="size-3.5" />العملاء</Link>}
        title={<span className="flex items-center gap-3">{c.name}{!c.isActive && <Badge tone="outline">معطّل</Badge>}</span>}
        subtitle={<>
          {c.phone && <><bdi dir="ltr" className="num">{c.phone}</bdi>، </>}
          العمولة الافتراضية <bdi dir="ltr" className="num">{formatBps(c.defaultCommissionBps)}</bdi>
          {c.pendingCount > 0 && <>، <span className="text-accent-ink">{c.pendingCount} بانتظار الموافقة</span></>}
        </>}
        actions={<>
          <Button variant="quiet" className="text-neg data-[hovered]:text-neg" onPress={() => setDialog('delete')}><Trash2 />حذف العميل</Button>
          <Button variant="quiet" onPress={() => setDialog('edit')}><Pencil />تعديل</Button>
          <Button variant="secondary" onPress={() => setDialog('adjustment')}><Scale />قيد تسوية</Button>
          <Button variant="primary" onPress={() => setDialog('payout')}><HandCoins />تسجيل دفعة</Button>
        </>}
      />
      <BalanceCards cards={cards.data ?? []} />
      <CustomerExcelCard customer={c} />

      {tab !== null && (
        <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
          <TabList aria-label="العملة" className="mb-4 flex gap-1 border-b border-line">
            {currencies.map((cur) => <Tab key={cur} id={cur} className={tabCls}>دفتر {cur}</Tab>)}
            <Tab id="txns" className={tabCls}>
              <span className="flex items-center gap-2">معاملاته{c.pendingCount > 0 && <Badge tone="accent"><span className="num">{c.pendingCount}</span></Badge>}</span>
            </Tab>
          </TabList>
          {currencies.map((cur) => <TabPanel key={cur} id={cur} className="outline-none"><LedgerTable customer={c} currency={cur} /></TabPanel>)}
          <TabPanel id="txns" className="outline-none"><TransactionsView scope={{ kind: 'customer', customerId: c.id }} /></TabPanel>
        </Tabs>
      )}

      {(dialog === 'payout' || dialog === 'adjustment') && (
        <MoneyEntryDialog kind={dialog} customer={c} currencies={allCurrencies} defaultCurrency={activeCurrency} onClose={() => setDialog(null)} />
      )}
      {dialog === 'edit' && <CustomerDialog customer={c} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteCustomerDialog customer={c} onClose={() => setDialog(null)} onDeleted={() => navigate('/customers')} />}
    </div>
  );
}

