// Display dates in the device's time zone, Gregorian calendar, Latin digits.
import type { IsoDate } from './contract';

const p2 = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(iso: IsoDate | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function formatDate(iso: IsoDate | string | null | undefined): string {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function todayLocal(): string {
  return formatDate(new Date().toISOString());
}

/** "YYYY-MM-DD HH:mm" in local time, the format ManualTxnInput.occurredAt expects. */
export function nowLocalMinute(): string {
  return formatDateTime(new Date().toISOString());
}
