import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs, TabList, Tab, TabPanel } from 'react-aria-components';
import { ArrowRight, HandCoins, Pencil, Scale, Send, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { Customer, PayoutMethod, PayoutSelection } from '@/lib/contract';
import { USDT_NETWORKS, payoutMethod } from '@/lib/strings';
import { formatBps } from '@/lib/money';
import { todayLocal } from '@/lib/dates';
import { useAction } from '@/lib/useAction';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Field';
import { DatePicker } from '@/components/ui/DateFields';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/TextField';
import { Segmented } from '@/components/ui/Segmented';
import { ConfirmMoney } from '@/components/ui/ConfirmMoney';
import { cx } from '@/components/ui/cx';
import { TransactionsView } from '@/components/transactions/TransactionsView';
import { CURRENCIES } from '@/components/transactions/TxnActions';
import { CustomerDialog, DeleteCustomerDialog } from './Customers';
import { CustomerExcelCard, StatementCheckbox, addToStatementAfter, useStatementChoice } from '@/components/customers/CustomerExcel';
import { StatementTab } from '@/components/customers/StatementTab';
import { PreparePayoutDialog } from '@/components/customers/PreparePayoutDialog';
import { PayoutsRegister } from '@/components/customers/PayoutsRegister';

const tabCls = ({ isSelected }: { isSelected: boolean }) => cx(
  'relative -mb-px flex h-10 cursor-default items-center gap-2 px-3 text-sm outline-none transition-colors duration-150',
  'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
  isSelected ? 'text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent' : 'text-fg-3 hover:text-fg-2');

// ----------------------------------------------------------------- payout / adjustment
function MoneyEntryDialog({ kind, customer, currencies, defaultCurrency, onClose }: {
  kind: 'payout' | 'adjustment'; customer: Customer; currencies: string[]; defaultCurrency: string; onClose: () => void;
}) {
  const [currency, setCurrency] = useState(defaultCurrency);
  const [amountText, setAmountText] = useState('');
  const [entryDate, setEntryDate] = useState(todayLocal());
  const [method, setMethod] = useState<PayoutMethod>('cash');
  const [reference, setReference] = useState('');
  const [platform, setPlatform] = useState('');
  const [network, setNetwork] = useState('TRC20');
  const [destination, setDestination] = useState('');
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
      ? await run(() => api.ledgerAddPayout(customer.id, { currency, amountText: amountText.trim(), entryDate, method, platform: platform.trim() || undefined, network: method === 'usdt' ? network : undefined, destination: destination.trim() || undefined, reference: reference.trim() || undefined, description: description.trim() || undefined, confirmOverdraw }), 'سُجّلت الدفعة', { quiet: (e) => e.field === 'overdraw' })
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
      description={isPayout ? 'دفعة على الحساب غير مرتبطة بحوالات؛ لدفع حوالات محددة استخدم «تجهيز دفعة»' : 'رصيد افتتاحي، خصم، أو تصحيح'}
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
        {isPayout && <TextField label={method === 'bank' ? 'البنك' : 'المنصة'} value={platform} onChange={setPlatform} placeholder={method === 'usdt' ? 'Binance، OKX…' : ''} />}
        {isPayout && method === 'usdt' && (
          <div className="flex flex-col gap-1.5"><span className="text-[13px] text-fg-2">الشبكة</span>
            <Select label="الشبكة" value={network} onChange={(k) => setNetwork(String(k))} options={USDT_NETWORKS.map((n) => ({ id: n, label: n }))} /></div>
        )}
        {isPayout && <TextField label={method === 'usdt' ? 'عنوان المحفظة' : 'الحساب / IBAN'} ltr value={destination} onChange={setDestination} className="col-span-2" />}
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
  const currencies = cards.data?.map((c) => c.currency) ?? [];
  // ?tab=USD | pending | payouts (links from search, the "فتح" toast, the dashboard); older ?tab=txns&sub=… still lands right
  const pTab = params.get('tab'), pSub = params.get('sub');
  const wanted = pTab === 'txns' ? (pSub === 'approved' ? null : 'pending') : pTab;
  const [tab, setTab] = useState<string | null>(wanted);
  useEffect(() => { if (wanted) setTab(wanted); }, [wanted, params]);
  useEffect(() => { if (tab === null && cards.data) setTab(cards.data[0]?.currency ?? 'pending'); }, [cards.data, tab]);
  const [dialog, setDialog] = useState<'payout' | 'adjustment' | 'edit' | 'delete' | null>(null);
  const [prepare, setPrepare] = useState<{ currency: string; initial?: PayoutSelection } | null>(null);
  const navigate = useNavigate();

  const c = customer.data;
  if (customer.isError) return <div className="p-8 text-fg-2">العميل غير موجود. <Link to="/customers" className="text-accent-ink">العودة للعملاء</Link></div>;
  if (!c) return null;
  const allCurrencies = [...new Set([...currencies, ...CURRENCIES])];
  const activeCurrency = tab && currencies.includes(tab) ? tab : currencies[0] ?? 'USD';

  return (
    <div className="mx-auto flex min-h-full max-w-[1800px] flex-col px-6 pb-8 pt-6">
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
          <Button variant="secondary" onPress={() => setDialog('payout')}><HandCoins />تسجيل دفعة</Button>
          <Button variant="primary" isDisabled={!currencies.length} onPress={() => setPrepare({ currency: activeCurrency })}><Send />تجهيز دفعة</Button>
        </>}
      />
      <CustomerExcelCard customer={c} />

      {tab !== null && (
        <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
          <TabList aria-label="كشف الحساب" className="mb-4 flex gap-1 border-b border-line">
            {currencies.map((cur) => <Tab key={cur} id={cur} className={tabCls}>كشف {cur}</Tab>)}
            <Tab id="pending" className={tabCls}>
              <span className="flex items-center gap-2">بانتظار الموافقة{c.pendingCount > 0 && <Badge tone="accent"><span className="num">{c.pendingCount}</span></Badge>}</span>
            </Tab>
            <Tab id="payouts" className={tabCls}>الدفعات</Tab>
          </TabList>
          {currencies.map((cur) => (
            <TabPanel key={cur} id={cur} className="outline-none">
              <StatementTab customer={c} currency={cur} onPrepare={(initial) => setPrepare({ currency: cur, initial })} />
            </TabPanel>
          ))}
          <TabPanel id="pending" className="outline-none"><TransactionsView scope={{ kind: 'customer', customerId: c.id }} /></TabPanel>
          <TabPanel id="payouts" className="outline-none"><PayoutsRegister customerId={c.id} currencies={currencies} /></TabPanel>
        </Tabs>
      )}

      {(dialog === 'payout' || dialog === 'adjustment') && (
        <MoneyEntryDialog kind={dialog} customer={c} currencies={allCurrencies} defaultCurrency={activeCurrency} onClose={() => setDialog(null)} />
      )}
      {prepare && <PreparePayoutDialog customer={c} currency={prepare.currency} initial={prepare.initial} onClose={() => setPrepare(null)} />}
      {dialog === 'edit' && <CustomerDialog customer={c} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteCustomerDialog customer={c} onClose={() => setDialog(null)} onDeleted={() => navigate('/customers')} />}
    </div>
  );
}
