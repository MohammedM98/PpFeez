import { Checkbox as HeroCheckbox, type CheckboxProps, ListBox, SearchField as HeroSearchField, Select as HeroSelect, Label } from '@heroui/react';
import type { Key } from 'react-aria-components';
import { useRef, type ReactNode } from 'react';
import { cx } from './cx';

/* Filters and form controls: HeroUI SearchField, Select and Checkbox. */

export function SearchField({ label, value, onChange, className }: { label: string; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <HeroSearchField aria-label={label} value={value} onChange={onChange} className={className}>
      <HeroSearchField.Group className="h-9 w-full">
        <HeroSearchField.SearchIcon />
        <HeroSearchField.Input placeholder={label} className="min-w-0" />
        <HeroSearchField.ClearButton aria-label="مسح البحث" />
      </HeroSearchField.Group>
    </HeroSearchField>
  );
}

export type Option = { id: Key; label: ReactNode };
export function Select({ label, options, value, onChange, className, placeholder }: {
  label: string; options: Option[]; value: Key | null; onChange: (k: Key) => void; className?: string; placeholder?: string;
}) {
  // React Aria keeps a hidden native <select> for forms. In the Windows webview, autofill or
  // form-state restore can write to it, which silently switched the currency filter to "USD".
  // Only accept a change while the person is using this control (list open or trigger focused).
  const open = useRef(false);
  const focused = useRef(false);
  return (
    <HeroSelect aria-label={label} value={value} placeholder={placeholder ?? label} className={className}
      autoComplete="off"
      onOpenChange={(o) => { open.current = o; }}
      onFocusChange={(f) => { focused.current = f; }}
      onChange={(k) => { if (k !== null && (open.current || focused.current)) onChange(k as Key); }}>
      <HeroSelect.Trigger className="h-9 min-h-9">
        <HeroSelect.Value className="truncate" />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover className="min-w-(--trigger-width)">
        <ListBox className="max-h-72 overflow-auto">
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={typeof o.label === 'string' ? o.label : String(o.id)}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );
}

export function Checkbox({ children, className, ...props }: Omit<CheckboxProps, 'children'> & { children?: ReactNode }) {
  return (
    <HeroCheckbox {...props} className={cx('text-sm text-fg-2', className as string)}>
      <HeroCheckbox.Content>
        <HeroCheckbox.Control><HeroCheckbox.Indicator /></HeroCheckbox.Control>
        {children}
      </HeroCheckbox.Content>
    </HeroCheckbox>
  );
}

export { Label };
