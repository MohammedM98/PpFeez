import {
  DatePicker as RacDatePicker, DateRangePicker as RacDateRangePicker, DateInput, DateSegment, Group, Label, Popover, Dialog,
  Calendar, RangeCalendar, CalendarGrid, CalendarCell, Heading, Button as RacButton, I18nProvider,
} from 'react-aria-components';
import { parseDate, parseDateTime, type CalendarDate, type CalendarDateTime } from '@internationalized/date';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Period } from '@/lib/contract';
import { cx } from './cx';
import { fieldShell } from './Field';

const segment = 'rounded-[4px] px-0.5 tabular-nums outline-none data-[placeholder]:text-fg-3 data-[focused]:bg-accent data-[focused]:text-accent-fg';
const cell = 'grid size-9 cursor-default place-items-center rounded-[8px] text-sm tabular-nums outline-none data-[outside-month]:hidden data-[hovered]:bg-raised data-[selected]:bg-accent data-[selected]:text-accent-fg data-[disabled]:text-fg-3 data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus';

function CalHeader() {
  return (
    <header className="mb-2 flex items-center justify-between">
      {/* In RTL "previous" sits on the right, so the chevrons are mirrored */}
      <RacButton slot="previous" className="grid size-8 place-items-center rounded-[8px] text-fg-2 outline-none hover:bg-raised"><ChevronRight className="size-4" /></RacButton>
      <Heading className="text-sm font-medium" />
      <RacButton slot="next" className="grid size-8 place-items-center rounded-[8px] text-fg-2 outline-none hover:bg-raised"><ChevronLeft className="size-4" /></RacButton>
    </header>
  );
}

// Fields type and show dates as YYYY-MM-DD HH:mm (SPEC §2); sv-SE is the locale with exactly that order.
// The calendar popover switches back to Arabic month names.
const FIELD_LOCALE = 'sv-SE';
const APP_LOCALE = 'ar-u-nu-latn-ca-gregory';

const popover = 'rounded-card border border-line bg-surface p-3 shadow-(--shadow-float) outline-none';

/** Value is "YYYY-MM-DD" or, with `withTime`, "YYYY-MM-DD HH:mm" (local time). */
export function DatePicker({ label, value, onChange, withTime, className, isRequired }: {
  label: string; value: string | null; onChange: (v: string | null) => void; withTime?: boolean; className?: string; isRequired?: boolean;
}) {
  let parsed: CalendarDate | CalendarDateTime | null = null;
  try { parsed = value ? (withTime ? parseDateTime(value.replace(' ', 'T')) : parseDate(value)) : null; } catch { parsed = null; }
  return (
    <I18nProvider locale={FIELD_LOCALE}>
    <RacDatePicker
      value={parsed}
      onChange={(v) => onChange(v ? (withTime ? v.toString().slice(0, 16).replace('T', ' ') : v.toString().slice(0, 10)) : null)}
      granularity={withTime ? 'minute' : 'day'}
      hourCycle={24}
      shouldForceLeadingZeros
      isRequired={isRequired}
      className={cx('flex flex-col gap-1.5', className)}
    >
      <Label className="text-[13px] text-fg-2">{label}</Label>
      <Group className={cx('flex items-center gap-1 pe-1 ps-3', fieldShell)}>
        <DateInput dir="ltr" className="flex flex-1 justify-end text-sm">{(s) => <DateSegment segment={s} className={segment} />}</DateInput>
        <RacButton className="grid size-7 place-items-center rounded-[6px] text-fg-3 outline-none hover:bg-raised"><CalendarDays className="size-4" /></RacButton>
      </Group>
      <Popover className={popover}>
        <Dialog className="outline-none">
          <I18nProvider locale={APP_LOCALE}>
            <Calendar><CalHeader /><CalendarGrid>{(d) => <CalendarCell date={d} className={cell} />}</CalendarGrid></Calendar>
          </I18nProvider>
        </Dialog>
      </Popover>
    </RacDatePicker>
    </I18nProvider>
  );
}

export function DateRangePicker({ label, value, onChange, className }: { label: string; value: Period; onChange: (p: Period) => void; className?: string }) {
  let v: { start: CalendarDate; end: CalendarDate } | null = null;
  try { v = value.from && value.to ? { start: parseDate(value.from), end: parseDate(value.to) } : null; } catch { v = null; }
  return (
    <I18nProvider locale={FIELD_LOCALE}>
    <RacDateRangePicker shouldForceLeadingZeros aria-label={label} value={v} onChange={(r) => onChange(r ? { from: r.start.toString(), to: r.end.toString() } : {})} className={cx('flex flex-col', className)}>
      <Group className={cx('flex items-center gap-1 pe-1 ps-3', fieldShell)}>
        <div dir="ltr" className="flex flex-1 items-center justify-end gap-1 text-sm">
          <DateInput slot="start" className="flex">{(s) => <DateSegment segment={s} className={segment} />}</DateInput>
          <span className="text-fg-3">–</span>
          <DateInput slot="end" className="flex">{(s) => <DateSegment segment={s} className={segment} />}</DateInput>
        </div>
        <RacButton className="grid size-7 place-items-center rounded-[6px] text-fg-3 outline-none hover:bg-raised"><CalendarDays className="size-4" /></RacButton>
      </Group>
      <Popover className={popover}>
        <Dialog className="outline-none">
          <I18nProvider locale={APP_LOCALE}>
            <RangeCalendar><CalHeader /><CalendarGrid>{(d) => <CalendarCell date={d} className={cell} />}</CalendarGrid></RangeCalendar>
          </I18nProvider>
        </Dialog>
      </Popover>
    </RacDateRangePicker>
    </I18nProvider>
  );
}
