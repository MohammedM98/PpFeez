import { ToggleButtonGroup, ToggleButton } from '@heroui/react';
import type { Key } from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';

/** One choice of a few, side by side: HeroUI ToggleButtonGroup that always keeps one selected. */
export function Segmented<T extends Key>({ label, value, onChange, options, className }: {
  label: string; value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode }[]; className?: string;
}) {
  return (
    <ToggleButtonGroup aria-label={label} selectionMode="single" disallowEmptySelection selectedKeys={[value]} size="sm"
      onSelectionChange={(keys) => { const k = [...keys][0]; if (k !== undefined) onChange(k as T); }}
      className={cx('segmented', className)}>
      {options.map((o) => (
        <ToggleButton key={String(o.id)} id={o.id} className="flex-1">{o.label}</ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
