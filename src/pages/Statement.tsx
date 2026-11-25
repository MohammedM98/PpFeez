import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { ledgerType, payoutMethod } from '@/lib/strings';
import { formatDateTime } from '@/lib/dates';
import { formatMinor } from '@/lib/money';
import { Button } from '@/components/ui/Button';

/**
 * Printable statement (SPEC 6.5). Always rendered as a light paper document,
 * whatever the app theme; the buttons disappear when printing.
 */
export function StatementPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const currency = params.get('currency') ?? 'USD';
  const period = { from: params.get('from') ?? undefined, to: params.get('to') ?? undefined };
  const { data } = useQuery({
    queryKey: ['ledger_statement', id, currency, period],
    queryFn: () => api.ledgerStatement(Number(id), currency, period.from || period.to ? period : undefined),
  });
  const m = (minor: number) => <bdi dir="ltr" className="num">{formatMinor(minor, currency)}</bdi>;

  return (
    <div className="statement min-h-screen bg-[#e9e9ec] py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[820px] justify-between print:hidden">
        <Button variant="secondary" onPress={() => navigate(-1)}><ArrowRight />رجوع للدفتر</Button>
        <Button variant="primary" onPress={() => window.print()}><Printer />طباعة أو حفظ PDF</Button>
      </div>
      {data && (
        <article className="mx-auto max-w-[820px] bg-white px-12 py-10 text-[13px] leading-relaxed text-[#18181b] shadow-[0_2px_16px_rgb(0_0_0/0.12)] print:max-w-none print:px-0 print:py-0 print:shadow-none">
          <header className="mb-6 flex items-start justify-between border-b border-[#d4d4d8] pb-5">
            <div>
              <h1 className="text-[22px] font-semibold">كشف حساب</h1>
              <div className="mt-1 text-[15px]">{data.customer.name}</div>
              {data.customer.phone && <div className="text-[#52525b]"><bdi dir="ltr">{data.customer.phone}</bdi></div>}
            </div>
            <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-[#52525b]">
              <dt>العملة</dt><dd className="text-[#18181b]">{currency}</dd>
              <dt>الفترة</dt><dd className="text-[#18181b]">{period.from || period.to ? <bdi dir="ltr" className="num">{period.from ?? '…'} – {period.to ?? '…'}</bdi> : 'كل القيود'}</dd>
              <dt>تاريخ الإصدار</dt><dd className="text-[#18181b]"><bdi dir="ltr" className="num">{formatDateTime(data.generatedAt)}</bdi></dd>
            </dl>
          </header>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-[#18181b] text-[12px] [&>th]:py-2 [&>th]:font-semibold">
                <th className="text-start">التاريخ</th><th className="text-start">النوع</th><th className="text-start">البيان</th><th className="text-end">له</th><th className="text-end">عليه</th><th className="text-end">الرصيد</th>
              </tr>
            </thead>
            <tbody className="[&>tr]:border-b [&>tr]:border-[#e4e4e7] [&>tr>td]:py-2 [&>tr>td]:align-top">
              {period.from && (
                <tr className="text-[#52525b]"><td colSpan={5}>رصيد سابق</td><td className="text-end">{m(data.view.openingBalanceMinor)}</td></tr>
              )}
              {data.view.entries.map((e) => (
                <tr key={e.id} className={e.reversedByEntryId !== null ? 'text-[#a1a1aa] line-through' : ''}>
                  <td className="num whitespace-nowrap"><bdi dir="ltr">{e.entryDate}</bdi></td>
                  <td className="whitespace-nowrap">{ledgerType[e.type]}</td>
                  <td>{e.description}{e.payoutMethod && ` (${payoutMethod[e.payoutMethod]})`}</td>
                  <td className="text-end">{e.amountMinor > 0 ? m(e.amountMinor) : ''}</td>
                  <td className="text-end">{e.amountMinor < 0 ? m(-e.amountMinor) : ''}</td>
                  <td className="text-end">{m(e.runningBalanceMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-5 flex items-baseline justify-between border-t-2 border-[#18181b] pt-3 text-[15px] font-semibold">
            <span>الرصيد الختامي {data.view.closingBalanceMinor < 0 && <span className="text-[#b42318]">(عليه)</span>}</span>
            <bdi dir="ltr" className="num">{formatMinor(data.view.closingBalanceMinor, currency)} {currency}</bdi>
          </div>
          <footer className="mt-10 text-[11px] text-[#71717a]">صادر من PpFeez</footer>
        </article>
      )}
    </div>
  );
}
