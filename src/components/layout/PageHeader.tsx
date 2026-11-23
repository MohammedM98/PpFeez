import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="mb-5 flex items-end justify-between gap-6">
      <div className="min-w-0">
        {back}
        <h1 className="font-display text-[26px] font-medium leading-[1.35] text-fg">{title}</h1>
        {subtitle && <p className="text-[13.5px] text-fg-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
