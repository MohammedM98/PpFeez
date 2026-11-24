import type { ReactNode } from 'react';
import { cx } from '@/components/ui/cx';

/**
 * Page title row. `compact` (table screens, SPEC 6.5): one line, smaller title, the subtitle beside it,
 * so the table starts high on the screen.
 */
export function PageHeader({ title, subtitle, actions, back, compact }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode; compact?: boolean }) {
  if (compact) {
    return (
      <header className="mb-3 flex min-h-10 items-center justify-between gap-4">
        <div className="flex min-w-0 items-baseline gap-3">
          {back}
          <h1 className="min-w-0 max-w-[min(420px,50%)] shrink-0 truncate font-display text-[20px] font-medium leading-tight text-fg">{title}</h1>
          {subtitle && <div className="min-w-0 shrink-[4] truncate text-[13px] text-fg-3">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
    );
  }
  return (
    <header className={cx('mb-5 flex items-end justify-between gap-6')}>
      <div className="min-w-0">
        {back}
        <h1 className="font-display text-[26px] font-medium leading-[1.35] text-fg">{title}</h1>
        {subtitle && <p className="text-[13.5px] text-fg-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
