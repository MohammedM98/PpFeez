import { formatDate, formatDateTime } from '@/lib/dates';
import { cx } from './cx';

/** Dates render left-to-right so "2026-11-23 09:07" never flips inside Arabic text. */
export function DateTime({ iso, dateOnly, className }: { iso: string | null | undefined; dateOnly?: boolean; className?: string }) {
  return <bdi dir="ltr" className={cx('num whitespace-nowrap', className)}>{dateOnly ? formatDate(iso) : formatDateTime(iso)}</bdi>;
}
