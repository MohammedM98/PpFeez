import { decimalsOf, formatMinor } from '@/lib/money';
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
  /**
   * Table column mode (SPEC 6, table alignment): the number is right-aligned in a slot `fit`
   * digits wide and the currency code sits in a fixed slot after it, so decimal points
   * line up down the column. Get `fit` from `amountFit()` over everything the column shows.
   */
  fit?: number;
};

// A zero-decimal amount (JPY) gets blank space as wide as ".00", so its last digit lines up with
// the other rows' decimal points: U+2008 is as wide as a period, U+2007 as a tabular digit.
const NO_FRACTION = '   ';

/** Money always renders left-to-right inside the RTL page: `1,250.00 USD`. */
export function Amount({ minor, currency, tone = 'plain', showCurrency = true, estimated, className, fit }: Props) {
  if ((minor === null || minor === undefined) && fit === undefined) return <span className="text-fg-3">—</span>;
  const color = minor == null ? 'text-fg-3' : tone === 'signed' ? (minor < 0 ? 'text-neg' : minor > 0 ? 'text-pos' : 'text-fg-2') : '';
  if (fit !== undefined) {
    return (
      <bdi dir="ltr" data-amount="" className={cx('num inline-flex items-baseline whitespace-nowrap', color, estimated && 'text-fg-3', className)}>
        <span data-amount-num="" className="text-right" style={{ minWidth: `calc(${fit} * var(--digit))` }}>
          {minor == null ? '—' : formatMinor(minor, currency)}{minor != null && decimalsOf(currency) === 0 && NO_FRACTION}
        </span>
        {showCurrency && <span className="ms-[0.3em] inline-block w-[3.1em] text-left text-[0.8em] text-fg-3">{minor == null ? '' : currency}</span>}
      </bdi>
    );
  }
  return (
    <bdi dir="ltr" className={cx('num whitespace-nowrap', color, estimated && 'text-fg-3', className)}>
      {formatMinor(minor!, currency)}
      {showCurrency && <>{' '}<span className="text-[0.8em] text-fg-3">{currency}</span></>}
    </bdi>
  );
}

/** Characters needed by the widest amount a column shows (at least "0.00"). */
export function amountFit(values: { minor: Minor | null | undefined; currency: Currency }[]): number {
  let n = 4;
  for (const v of values) {
    if (v.minor === null || v.minor === undefined) continue;
    const len = formatMinor(v.minor, v.currency).length + (decimalsOf(v.currency) === 0 ? 3 : 0);
    if (len > n) n = len;
  }
  return n;
}

/**
 * CSS width of an amount column: the number slot (+1ch of slack for proportional
 * punctuation), the currency slot when shown, and the cell padding; never narrower
 * than `minPx` (the header or a badge such as "تحتاج رسوم").
 */
export function amountWidth(fit: number, withCurrency: boolean, minPx = 0): string {
  return `max(${minPx}px, calc(${fit + 1} * var(--digit) + ${withCurrency ? 2.8 : 0}em + 22px))`;
}

/**
 * Sets `--digit` on the root: the width of one tabular digit, in em, at the widest weight used
 * for amounts. `ch` is not enough: it measures the proportional "0", narrower than tabular digits.
 * Runs again once the web font has loaded.
 */
export function measureDigits() {
  const run = () => {
    let em = 0;
    for (const weight of [400, 500, 600]) {
      const s = document.createElement('span');
      s.className = 'num';
      s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-size:100px;font-weight:${weight}`;
      s.textContent = '0123456789';
      document.body.appendChild(s);
      em = Math.max(em, s.getBoundingClientRect().width / 1000);
      s.remove();
    }
    if (em > 0) document.documentElement.style.setProperty('--digit', `${(Math.ceil(em * 1000) / 1000).toFixed(3)}em`);
  };
  run();
  void document.fonts?.ready.then(run);
}
