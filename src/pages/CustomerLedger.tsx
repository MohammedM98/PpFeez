import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabList, Tab, TabPanel, MenuTrigger, Menu, MenuItem, Popover } from 'react-aria-components';
import { ArrowRight, Download, HandCoins, MoreHorizontal, Pencil, Printer, Scale } from 'lucide-react';
import { api, native } from '@/lib/api';
import type { BalanceCard, Customer, LedgerEntry, PayoutMethod, Period } from '@/lib/contract';
import { ledgerType, payoutMethod } from '@/lib/strings';
import { formatBps } from '@/lib/money';
import { todayLocal } from '@/lib/dates';
import { periodLabels, presetPeriod, type PeriodPreset } from '@/lib/period';
import { useAction } from '@/lib/useAction';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Field';
import { DatePicker, DateRangePicker } from '@/components/ui/DateFields';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/TextField';
import { Segmented } from '@/components/ui/Segmented';
import { ConfirmMoney } from '@/components/ui/ConfirmMoney';
import { cx } from '@/components/ui/cx';
import { TransactionsView } from '@/components/transactions/TransactionsView';
import { CURRENCIES } from '@/components/transactions/TxnActions';
import { CustomerDialog } from './Customers';

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
  const [flash, setFlash] = useState<number | null>(null);
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
  const print = () => {
    const p = new URLSearchParams({ currency, ...(period.from ? { from: period.from } : {}), ...(period.to ? { to: period.to } : {}) });
    navigate(`/statement/${customer.id}?${p}`);
  };

  const v = view.data;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Select label="الفترة" value={preset} onChange={(k) => setPreset(k as PeriodPreset)} className="w-[140px]"
          options={(Object.keys(periodLabels) as PeriodPreset[]).map((k) => ({ id: k, label: periodLabels[k] }))} />
        {preset === 'custom' && <DateRangePicker label="الفترة المخصّصة" value={custom} onChange={setCustom} className="w-[250px]" />}
        <div className="ms-auto flex gap-2">
          <Button variant="secondary" size="sm" onPress={exportCsv}><Download />تصدير CSV</Button>
          <Button variant="secondary" size="sm" onPress={print}><Printer />طباعة كشف</Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-[12.5px] text-fg-3 [&>th]:h-10 [&>th]:border-b [&>th]:border-line [&>th]:px-3 [&>th]:font-medium">
              <th className="text-start">التاريخ</th><th className="text-start">النوع</th><th className="text-start">الوصف</th>
              <th className="text-end">له (+)</th><th className="text-end">عليه (−)</th><th className="text-end">الرصيد الجاري</th>
              <th className="text-start">المرجع</th><th className="w-12"><span className="sr-only">إجراءات</span></th>
            </tr>
          </thead>
          <tbody className="[&>tr>td]:h-12 [&>tr>td]:border-b [&>tr>td]:border-line [&>tr>td]:px-3 [&>tr:last-child>td]:border-b-0">
            {v && period.from && (
              <tr className="bg-raised/40 text-fg-2">
                <td colSpan={5}>رصيد سابق حتى <bdi dir="ltr" className="num">{period.from}</bdi></td>
                <td className="text-end"><Amount minor={v.openingBalanceMinor} currency={currency} showCurrency={false} tone="signed" /></td>
                <td colSpan={2} />
              </tr>
            )}
            {v?.entries.map((e) => {
              const reversed = e.reversedByEntryId !== null;
              return (
                <tr key={e.id} id={`entry-${e.id}`} className={cx('transition-colors duration-500', flash === e.id && 'bg-accent-soft')}>
                  <td className="num whitespace-nowrap text-fg-2"><bdi dir="ltr">{e.entryDate}</bdi></td>
                  <td><Badge tone={e.type === 'credit' ? 'pos' : e.type === 'payout' ? 'neutral' : e.type === 'reversal' ? 'neg' : 'outline'}>{ledgerType[e.type]}</Badge></td>
                  <td className="max-w-[380px]">
                    <div className={cx('leading-snug', reversed && 'text-fg-3 line-through decoration-fg-3/60')}>{e.description}</div>
                    <div className="flex gap-2 text-[12px] text-fg-3">
                      {e.payoutMethod && payoutMethod[e.payoutMethod]}
                      {reversed && <button className="text-accent-ink hover:underline" onClick={() => jump(e.reversedByEntryId!)}>عُكس بقيد لاحق</button>}
                      {e.reversesEntryId !== null && <button className="text-accent-ink hover:underline" onClick={() => jump(e.reversesEntryId!)}>يعكس قيداً سابقاً</button>}
                    </div>
                  </td>
                  <td className="text-end">{e.amountMinor > 0 ? <Amount minor={e.amountMinor} currency={currency} showCurrency={false} className={reversed ? 'text-fg-3 line-through' : 'text-pos'} /> : ''}</td>
                  <td className="text-end">{e.amountMinor < 0 ? <Amount minor={-e.amountMinor} currency={currency} showCurrency={false} className={reversed ? 'text-fg-3 line-through' : ''} /> : ''}</td>
                  <td className="text-end font-medium"><Amount minor={e.runningBalanceMinor} currency={currency} showCurrency={false} className={e.runningBalanceMinor < 0 ? 'text-neg' : ''} /></td>
                  <td className="max-w-[160px] truncate text-[13px] text-fg-3">{e.reference ? <bdi dir="ltr">{e.reference}</bdi> : ''}</td>
                  <td className="pe-2">
                    {(e.transactionId !== null || (!reversed && e.reversesEntryId === null)) && (
                      <MenuTrigger>
                        <Button variant="quiet" size="icon" aria-label="إجراءات القيد"><MoreHorizontal /></Button>
                        <Popover placement="bottom end" className="min-w-44 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                          <Menu className="outline-none" onAction={(k) => (k === 'txn' ? navigate(`/transactions?detail=${e.transactionId}`) : setReversing(e))}>
                            {e.transactionId !== null && <MenuItem id="txn" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised">فتح المعاملة</MenuItem>}
                            {!reversed && e.reversesEntryId === null && <MenuItem id="reverse" className="flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm text-neg outline-none data-[focused]:bg-raised">عكس القيد</MenuItem>}
                          </Menu>
                        </Popover>
                      </MenuTrigger>
                    )}
                  </td>
                </tr>
              );
            })}
            {v && v.entries.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-fg-3">لا قيود في هذه الفترة</td></tr>}
          </tbody>
          {v && (
            <tfoot>
              <tr className="bg-raised/40 [&>td]:h-11 [&>td]:border-t [&>td]:border-line [&>td]:px-3">
                <td colSpan={5} className="text-fg-2">الرصيد الختامي</td>
                <td className="text-end text-[15px] font-medium"><Amount minor={v.closingBalanceMinor} currency={currency} className={v.closingBalanceMinor < 0 ? 'text-neg' : 'text-accent-ink'} /></td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {reversing && <ReverseDialog entry={reversing} onClose={() => setReversing(null)} />}
    </div>
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
    if (r.ok) onClose();
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
  const customerId = Number(id);
  const customer = useQuery({ queryKey: ['customer', customerId], queryFn: () => api.customerGet(customerId) });
  const cards = useQuery({ queryKey: ['ledger_balances', customerId], queryFn: () => api.ledgerBalances(customerId) });
  const [tab, setTab] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'payout' | 'adjustment' | 'edit' | null>(null);
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
          <Button variant="quiet" onPress={() => setDialog('edit')}><Pencil />تعديل</Button>
          <Button variant="secondary" onPress={() => setDialog('adjustment')}><Scale />قيد تسوية</Button>
          <Button variant="primary" onPress={() => setDialog('payout')}><HandCoins />تسجيل دفعة</Button>
        </>}
      />
      <BalanceCards cards={cards.data ?? []} />

      {tab !== null && (
        <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
          <TabList aria-label="العملة" className="mb-4 flex gap-1 border-b border-line">
            {currencies.map((cur) => <Tab key={cur} id={cur} className={tabCls}>دفتر {cur}</Tab>)}
            <Tab id="txns" className={tabCls}>معاملاته</Tab>
          </TabList>
          {currencies.map((cur) => <TabPanel key={cur} id={cur} className="outline-none"><LedgerTable customer={c} currency={cur} /></TabPanel>)}
          <TabPanel id="txns" className="outline-none"><TransactionsView customerId={c.id} /></TabPanel>
        </Tabs>
      )}

      {(dialog === 'payout' || dialog === 'adjustment') && (
        <MoneyEntryDialog kind={dialog} customer={c} currencies={allCurrencies} defaultCurrency={activeCurrency} onClose={() => setDialog(null)} />
      )}
      {dialog === 'edit' && <CustomerDialog customer={c} onClose={() => setDialog(null)} />}
    </div>
  );
}

