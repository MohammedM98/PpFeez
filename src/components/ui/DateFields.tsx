import { Calendar, DateField, DatePicker as HeroDatePicker, DateRangePicker as HeroDateRangePicker, Label, RangeCalendar } from '@heroui/react';
import { I18nProvider } from 'react-aria-components';
import { parseDate, parseDateTime, type CalendarDate, type CalendarDateTime } from '@internationalized/date';
import type { Period } from '@/lib/contract';
import { cx } from './cx';

// Fields type and show dates as YYYY-MM-DD HH:mm (SPEC §2); sv-SE is the locale with exactly that order.
// The calendar popover switches back to Arabic month names.
const FIELD_LOCALE = 'sv-SE';
const APP_LOCALE = 'ar-u-nu-latn-ca-gregory';

/** Value is "YYYY-MM-DD" or, with `withTime`, "YYYY-MM-DD HH:mm" (local time). */
export function DatePicker({ label, value, onChange, withTime, className, isRequired }: {
  label: string; value: string | null; onChange: (v: string | null) => void; withTime?: boolean; className?: string; isRequired?: boolean;
}) {
  let parsed: CalendarDate | CalendarDateTime | null = null;
  try { parsed = value ? (withTime ? parseDateTime(value.replace(' ', 'T')) : parseDate(value)) : null; } catch { parsed = null; }
  return (
    <I18nProvider locale={FIELD_LOCALE}>
      <HeroDatePicker
        value={parsed}
        onChange={(v) => onChange(v ? (withTime ? v.toString().slice(0, 16).replace('T', ' ') : v.toString().slice(0, 10)) : null)}
        granularity={withTime ? 'minute' : 'day'}
        hourCycle={24}
        shouldForceLeadingZeros
        isRequired={isRequired}
        className={cx('flex flex-col gap-1.5', className)}
      >
        <Label>{label}</Label>
        <DateField.Group fullWidth className="h-9">
          <DateField.Input dir="ltr" className="num justify-end">{(s) => <DateField.Segment segment={s} />}</DateField.Input>
          <DateField.Suffix>
            <HeroDatePicker.Trigger aria-label="فتح التقويم"><HeroDatePicker.TriggerIndicator /></HeroDatePicker.Trigger>
          </DateField.Suffix>
        </DateField.Group>
        <HeroDatePicker.Popover>
          <I18nProvider locale={APP_LOCALE}>
            <Calendar aria-label={label}>
              <Calendar.Header>
                <Calendar.Heading />
                <Calendar.NavButton slot="previous" />
                <Calendar.NavButton slot="next" />
              </Calendar.Header>
              <Calendar.Grid>
                <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
                <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
              </Calendar.Grid>
            </Calendar>
          </I18nProvider>
        </HeroDatePicker.Popover>
      </HeroDatePicker>
    </I18nProvider>
  );
}

export function DateRangePicker({ label, value, onChange, className }: { label: string; value: Period; onChange: (p: Period) => void; className?: string }) {
  let v: { start: CalendarDate; end: CalendarDate } | null = null;
  try { v = value.from && value.to ? { start: parseDate(value.from), end: parseDate(value.to) } : null; } catch { v = null; }
  return (
    <I18nProvider locale={FIELD_LOCALE}>
      <HeroDateRangePicker shouldForceLeadingZeros aria-label={label} value={v} onChange={(r) => onChange(r ? { from: r.start.toString(), to: r.end.toString() } : {})} className={cx('flex flex-col', className)}>
        <DateField.Group fullWidth className="h-9">
          <DateField.InputContainer dir="ltr" className="num justify-end">
            <DateField.Input slot="start">{(s) => <DateField.Segment segment={s} />}</DateField.Input>
            <HeroDateRangePicker.RangeSeparator />
            <DateField.Input slot="end">{(s) => <DateField.Segment segment={s} />}</DateField.Input>
          </DateField.InputContainer>
          <DateField.Suffix>
            <HeroDateRangePicker.Trigger aria-label="فتح التقويم"><HeroDateRangePicker.TriggerIndicator /></HeroDateRangePicker.Trigger>
          </DateField.Suffix>
        </DateField.Group>
        <HeroDateRangePicker.Popover>
          <I18nProvider locale={APP_LOCALE}>
            <RangeCalendar aria-label={label}>
              <RangeCalendar.Header>
                <RangeCalendar.Heading />
                <RangeCalendar.NavButton slot="previous" />
                <RangeCalendar.NavButton slot="next" />
              </RangeCalendar.Header>
              <RangeCalendar.Grid>
                <RangeCalendar.GridHeader>{(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}</RangeCalendar.GridHeader>
                <RangeCalendar.GridBody>{(date) => <RangeCalendar.Cell date={date} />}</RangeCalendar.GridBody>
              </RangeCalendar.Grid>
            </RangeCalendar>
          </I18nProvider>
        </HeroDateRangePicker.Popover>
      </HeroDateRangePicker>
    </I18nProvider>
  );
}
