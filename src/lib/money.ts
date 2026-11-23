// Formatting only. The UI never does money arithmetic (contract §2):
// amounts arrive as integer minor units and are turned into text with string ops.
import type { Currency, Minor } from './contract';

const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD']);

export function decimalsOf(currency: Currency): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 125000, "USD" -> "1,250.00" (no currency). Negative values get a leading "-". */
export function formatMinor(minor: Minor, currency: Currency): string {
  if (!Number.isSafeInteger(minor)) return '—';
  const d = decimalsOf(currency);
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(d + 1, '0');
  const intPart = d === 0 ? digits : digits.slice(0, -d);
  const frac = d === 0 ? '' : '.' + digits.slice(-d);
  return (negative ? '-' : '') + groupThousands(intPart) + frac;
}

/** 125000, "USD" -> "1,250.00 USD" */
export function formatAmount(minor: Minor, currency: Currency): string {
  return `${formatMinor(minor, currency)} ${currency}`;
}

/** Signed form for ledgers: "+71.25" / "-50.00". */
export function formatSigned(minor: Minor, currency: Currency): string {
  return (minor > 0 ? '+' : '') + formatMinor(minor, currency);
}

/** basis points -> "25.00%" (integer string ops, no floats). */
export function formatBps(bps: number): string {
  if (!Number.isSafeInteger(bps)) return '—';
  const neg = bps < 0;
  const s = String(Math.abs(bps)).padStart(3, '0');
  return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}%`;
}

/** basis points -> "25" or "12.5" for an editable percent field. */
export function bpsToPercentText(bps: number): string {
  const s = String(Math.abs(bps)).padStart(3, '0');
  const frac = s.slice(-2).replace(/0+$/, '');
  return (bps < 0 ? '-' : '') + s.slice(0, -2) + (frac ? '.' + frac : '');
}

/** "25" / "12.5" / "12.75" -> 1275 basis points, or null when not a valid percent. */
export function percentTextToBps(text: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(text);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 10000 ? bps : null;
}

/**
 * "0.30" -> 30 for a 2-decimal setting (fee estimate fixed part). Pure string handling,
 * no arithmetic on amounts; returns null when the text is not a plain amount.
 */
export function amountTextToMinor2(text: string): number | null {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text);
  return m ? Number(m[1] + (m[2] ?? '').padEnd(2, '0')) : null;
}
