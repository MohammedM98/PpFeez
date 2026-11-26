import { ComboBox as HeroComboBox, Input, Label, ListBox } from '@heroui/react';
import type { Key } from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';

export type ComboItem = { id: Key; label: string; hint?: ReactNode };

export function ComboBox({ label, items, value, onChange, placeholder, className, autoFocus, errorMessage, isDisabled }: {
  label: string; items: ComboItem[]; value: Key | null; onChange: (k: Key | null) => void; placeholder?: string; className?: string; autoFocus?: boolean; errorMessage?: string;
  /** e.g. while the items are still loading, so nothing typed is lost against an empty list */
  isDisabled?: boolean;
}) {
  return (
    <HeroComboBox selectedKey={value} onSelectionChange={onChange} defaultItems={items} menuTrigger="focus" autoFocus={autoFocus} isDisabled={isDisabled}
      isInvalid={!!errorMessage} className={cx('flex flex-col gap-1.5', className)}>
      <Label>{label}</Label>
      <HeroComboBox.InputGroup>
        <Input placeholder={placeholder} />
        <HeroComboBox.Trigger />
      </HeroComboBox.InputGroup>
      {errorMessage && <span data-slot="field-error" className="text-xs text-neg">{errorMessage}</span>}
      <HeroComboBox.Popover>
        <ListBox<ComboItem> className="max-h-64 overflow-auto" renderEmptyState={() => <div className="px-3 py-2 text-sm text-fg-3">لا نتائج</div>}>
          {(it) => (
            <ListBox.Item id={it.id} textValue={it.label}>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="text-[12.5px] text-fg-3">{it.hint}</span>}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          )}
        </ListBox>
      </HeroComboBox.Popover>
    </HeroComboBox>
  );
}
