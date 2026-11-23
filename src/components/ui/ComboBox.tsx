import { ComboBox as RacComboBox, Input, Label, ListBox, ListBoxItem, Popover, Button as RacButton, type Key } from 'react-aria-components';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { fieldShell } from './Field';

export type ComboItem = { id: Key; label: string; hint?: ReactNode };

export function ComboBox({ label, items, value, onChange, placeholder, className, autoFocus, errorMessage }: {
  label: string; items: ComboItem[]; value: Key | null; onChange: (k: Key | null) => void; placeholder?: string; className?: string; autoFocus?: boolean; errorMessage?: string;
}) {
  return (
    <RacComboBox selectedKey={value} onSelectionChange={onChange} defaultItems={items} menuTrigger="focus" autoFocus={autoFocus} className={cx('flex flex-col gap-1.5', className)}>
      <Label className="text-[13px] text-fg-2">{label}</Label>
      <div className={cx('relative flex items-center', fieldShell, errorMessage && 'border-neg')}>
        <Input placeholder={placeholder} className="h-full w-full bg-transparent px-3 text-sm outline-none placeholder:text-fg-3" />
        <RacButton className="me-1 grid size-7 place-items-center rounded-[6px] text-fg-3 outline-none hover:bg-raised"><ChevronDown className="size-4" /></RacButton>
      </div>
      {errorMessage && <span className="text-[12.5px] text-neg">{errorMessage}</span>}
      <Popover className="w-(--trigger-width) rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
        <ListBox<ComboItem> className="max-h-64 overflow-auto outline-none" renderEmptyState={() => <div className="px-3 py-2 text-sm text-fg-3">لا نتائج</div>}>
          {(it) => (
            <ListBoxItem id={it.id} textValue={it.label} className="flex h-9 cursor-default items-center gap-2 rounded-[6px] px-2.5 text-sm text-fg outline-none data-[focused]:bg-raised">
              {({ isSelected }) => (<>
                <span className="flex-1 truncate">{it.label}</span>
                {it.hint && <span className="text-[12.5px] text-fg-3">{it.hint}</span>}
                {isSelected && <Check className="size-4 text-accent-ink" />}
              </>)}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </RacComboBox>
  );
}
