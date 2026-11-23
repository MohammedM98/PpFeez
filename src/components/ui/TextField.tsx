import { TextField as RacTextField, Input, TextArea, Label, Text, FieldError, type TextFieldProps } from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { fieldShell } from './Field';

type Props = Omit<TextFieldProps, 'children'> & {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: string;
  placeholder?: string;
  multiline?: boolean;
  /** amounts, emails, ids: typed left-to-right but aligned with the other fields */
  ltr?: boolean;
  suffix?: ReactNode;
};

export function TextField({ label, description, errorMessage, placeholder, multiline, ltr, suffix, className, ...props }: Props) {
  return (
    <RacTextField {...props} isInvalid={!!errorMessage || props.isInvalid} className={cx('flex flex-col gap-1.5', className as string)}>
      {label && <Label className="text-[13px] text-fg-2">{label}</Label>}
      <div className={cx('relative flex items-center', fieldShell, multiline && 'h-auto', errorMessage && 'border-neg')}>
        {multiline ? (
          <TextArea placeholder={placeholder} rows={3} className="w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-fg-3" />
        ) : (
          <Input placeholder={placeholder} dir={ltr ? 'ltr' : undefined} className={cx('num h-full w-full min-w-0 bg-transparent px-3 text-sm outline-none placeholder:text-fg-3', ltr && 'text-right')} />
        )}
        {suffix && <span className="pe-3 text-[13px] text-fg-3">{suffix}</span>}
      </div>
      {description && !errorMessage && <Text slot="description" className="text-[12.5px] text-fg-3">{description}</Text>}
      {errorMessage ? <span className="text-[12.5px] text-neg">{errorMessage}</span> : <FieldError className="text-[12.5px] text-neg" />}
    </RacTextField>
  );
}
