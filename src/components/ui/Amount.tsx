import { formatMinor } from '@/lib/money';
import type { Currency, Minor } from '@/lib/contract';
import { cx } from './cx';

type Props = {
  minor: Minor | null | undefined;
  currency: Currency;
  /** colour by sign: positive = owed to customer, negative = owes */
  tone?: 'plain' | 'signed';
  showCurrency?: boolean;
  estimated?: boolean;
  className?: string;
};

/** Money always renders left-to-right inside the RTL page: `1,250.00 USD`. */
export function Amount({ minor, currency, tone = 'plain', showCurrency = true, estimated, className }: Props) {
  if (minor === null || minor === undefined) return <span className="text-fg-3">—</span>;
  const color = tone === 'signed' ? (minor < 0 ? 'text-neg' : minor > 0 ? 'text-pos' : 'text-fg-2') : '';
  return (
    <bdi dir="ltr" className={cx('num whitespace-nowrap', color, estimated && 'text-fg-3', className)}>
      {formatMinor(minor, currency)}
      {showCurrency && <span className="ms-1 text-[0.8em] text-fg-3">{currency}</span>}
    </bdi>
  );
}
