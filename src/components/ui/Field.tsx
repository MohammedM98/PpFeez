import {
  SearchField as RacSearchField, Input, Button as RacButton, Select as RacSelect, SelectValue, Popover, ListBox, ListBoxItem,
  Label, Checkbox as RacCheckbox, type CheckboxProps, type Key,
} from 'react-aria-components';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx';

export const fieldShell =
  'h-9 rounded-ctl border border-line bg-surface text-sm text-fg transition-[border-color] duration-150 ease-out hover:border-line-strong focus-within:border-focus focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-[color-mix(in_oklab,var(--focus)_35%,transparent)]';

export function SearchField({ label, value, onChange, className }: { label: string; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <RacSearchField aria-label={label} value={value} onChange={onChange} className={cx('group relative flex items-center', fieldShell, className)}>
      <Search className="pointer-events-none absolute start-3 size-4 text-fg-3" aria-hidden />
      <Input placeholder={label} className="h-full w-full bg-transparent ps-9 pe-8 outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden" />
      <RacButton className="absolute end-2 grid size-6 place-items-center rounded-[6px] text-fg-3 hover:bg-raised group-data-[empty]:hidden">
        <X className="size-3.5" />
      </RacButton>
    </RacSearchField>
  );
}

export type Option = { id: Key; label: ReactNode };
export function Select({ label, options, value, onChange, className, placeholder }: {
  label: string; options: Option[]; value: Key | null; onChange: (k: Key) => void; className?: string; placeholder?: string;
}) {
  return (
    <RacSelect aria-label={label} selectedKey={value} onSelectionChange={(k) => k !== null && onChange(k)} placeholder={placeholder ?? label} className={cx('group', className)}>
      <RacButton className={cx('flex w-full items-center justify-between gap-2 px-3 outline-none data-[focus-visible]:border-focus', fieldShell)}>
        <SelectValue className="truncate data-[placeholder]:text-fg-3" />
        <ChevronDown className="size-4 text-fg-3" aria-hidden />
      </RacButton>
      <Popover className="min-w-(--trigger-width) rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
        <ListBox className="max-h-72 overflow-auto outline-none">
          {options.map((o) => (
            <ListBoxItem key={o.id} id={o.id} textValue={typeof o.label === 'string' ? o.label : String(o.id)}
              className="flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2.5 text-sm text-fg outline-none data-[focused]:bg-raised data-[selected]:text-accent-ink">
              {({ isSelected }) => (<><span className="flex-1">{o.label}</span>{isSelected && <Check className="size-4" />}</>)}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </RacSelect>
  );
}

export function Checkbox({ children, className, ...props }: CheckboxProps & { children?: ReactNode }) {
  return (
    <RacCheckbox {...props} className={cx('group inline-flex items-center gap-2 text-sm text-fg-2 outline-none', className as string)}>
      <span className="grid size-4 place-items-center rounded-[4px] border border-line-strong bg-surface transition-colors duration-150 group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[indeterminate]:border-accent group-data-[indeterminate]:bg-accent group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus">
        <Check className="hidden size-3 stroke-3 text-accent-fg group-data-[selected]:block" />
        <span className="hidden h-0.5 w-2 bg-accent-fg group-data-[indeterminate]:block" />
      </span>
      {children}
    </RacCheckbox>
  );
}

export { Label };
