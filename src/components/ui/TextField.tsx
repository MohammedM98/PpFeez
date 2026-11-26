import { TextField as HeroTextField, InputGroup, Label, Description, FieldError, type TextFieldProps } from '@heroui/react';
import type { ReactNode } from 'react';
import { cx } from './cx';

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

/** HeroUI TextField: label, an InputGroup (so a unit can sit inside the field), help text and the error. */
export function TextField({ label, description, errorMessage, placeholder, multiline, ltr, suffix, className, ...props }: Props) {
  return (
    <HeroTextField {...props} isInvalid={!!errorMessage || props.isInvalid} className={cx('flex min-w-0 flex-col gap-1.5', className as string)}>
      {label && <Label>{label}</Label>}
      <InputGroup className="w-full min-w-0">
        {multiline
          ? <InputGroup.TextArea placeholder={placeholder} rows={3} className="resize-none" />
          : <InputGroup.Input placeholder={placeholder} dir={ltr ? 'ltr' : undefined} className={cx('num w-full min-w-0', ltr && 'text-right')} />}
        {suffix && <InputGroup.Suffix className="text-[13px] text-fg-3">{suffix}</InputGroup.Suffix>}
      </InputGroup>
      {description && !errorMessage && <Description>{description}</Description>}
      {errorMessage ? <span data-slot="field-error" className="text-xs text-neg">{errorMessage}</span> : <FieldError />}
    </HeroTextField>
  );
}
