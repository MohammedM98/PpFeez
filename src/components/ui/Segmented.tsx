import { ToggleButtonGroup, ToggleButton, type Key } from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';

export function Segmented<T extends Key>({ label, value, onChange, options, className }: {
  label: string; value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode }[]; className?: string;
}) {
  return (
    <ToggleButtonGroup aria-label={label} selectionMode="single" disallowEmptySelection selectedKeys={[value]}
      onSelectionChange={(keys) => { const k = [...keys][0]; if (k !== undefined) onChange(k as T); }}
      className={cx('inline-flex gap-0.5 rounded-ctl bg-raised p-0.5', className)}>
      {options.map((o) => (
        <ToggleButton key={String(o.id)} id={o.id} className="h-8 flex-1 rounded-[calc(var(--r-ctl)-2px)] px-3 text-sm text-fg-2 outline-none transition-colors duration-150 data-[hovered]:text-fg data-[selected]:bg-surface data-[selected]:text-fg data-[selected]:shadow-[0_1px_2px_rgb(0_0_0/0.12)] data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus">
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
