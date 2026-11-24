import { useEffect, useState, type ReactNode } from 'react';
import { RadioGroup, Radio } from 'react-aria-components';
import type { Mailbox, Period, PullRange } from '@/lib/contract';
import { usePull } from '@/lib/pull';
import { daysLabel } from '@/lib/strings';
import { formatDateTime, todayLocal } from '@/lib/dates';
import { toAppError } from '@/lib/api';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { DateRangePicker } from '@/components/ui/DateFields';
import { cx } from '@/components/ui/cx';

type Choice = 'new' | 'd7' | 'd30' | 'd90' | 'between' | 'all';
const DAYS: Record<'d7' | 'd30' | 'd90', number> = { d7: 7, d30: 30, d90: 90 };

function Option({ value, label, hint, isDisabled }: { value: Choice; label: string; hint?: ReactNode; isDisabled?: boolean }) {
  return (
    <Radio value={value} isDisabled={isDisabled} className={({ isSelected, isDisabled: d }) => cx(
      'group flex cursor-default items-center gap-3 rounded-ctl border px-3.5 py-2.5 outline-none transition-colors duration-150',
      'data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-1 data-[focus-visible]:outline-focus',
      isSelected ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong',
      d && 'opacity-50')}>
        <span className="grid size-4 shrink-0 place-items-center rounded-full border border-line-strong bg-surface group-data-[selected]:border-accent">
          <span className="size-2 rounded-full bg-accent opacity-0 group-data-[selected]:opacity-100" />
        </span>
        <span className="flex-1 text-sm text-fg">{label}</span>
        {hint && <span className="text-[12.5px] text-fg-3">{hint}</span>}
    </Radio>
  );
}

/** Pull range picker (SPEC 5.5): new since last pull, last N days, between two dates, or everything. */
export function PullDialog({ mailboxes, onClose }: { mailboxes: Mailbox[]; onClose: () => void }) {
  const { start } = usePull();
  const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id);
  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  const neverPulled = !mailbox?.lastPulledAt;
  const [choice, setChoice] = useState<Choice>(neverPulled ? 'd30' : 'new');
  const [period, setPeriod] = useState<Period>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // switching to a mailbox that was never pulled moves the default off "new"
  useEffect(() => { if (neverPulled && choice === 'new') setChoice('d30'); }, [neverPulled, choice]);

  const today = todayLocal();
  const localError =
    choice !== 'between' ? null
      : !period.from || !period.to ? 'اختر تاريخ البداية والنهاية'
      : period.from > period.to ? 'تاريخ البداية بعد تاريخ النهاية'
      : period.to > today ? 'لا يمكن اختيار تاريخ في المستقبل'
      : null;

  const range = (): PullRange =>
    choice === 'new' ? { kind: 'new' }
      : choice === 'all' ? { kind: 'all' }
      : choice === 'between' ? { kind: 'between', from: period.from!, to: period.to! }
      : { kind: 'last_days', days: DAYS[choice] };

  const submit = async () => {
    if (!mailboxId || localError) return;
    setPending(true); setError(null);
    try {
      if (await start(mailboxId, range())) onClose();
    } catch (e) {
      setError(toAppError(e).messageAr);
    } finally { setPending(false); }
  };

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title="سحب المعاملات"
      description={mailbox?.lastPulledAt ? <>آخر سحب من {mailbox.label} <bdi dir="ltr" className="num">{formatDateTime(mailbox.lastPulledAt)}</bdi></> : 'لم يُسحب هذا البريد من قبل'}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="primary" onPress={submit} isPending={pending} isDisabled={!mailboxId || (choice === 'between' && !!localError)}>بدء السحب</Button>
      </>}>
      <div className="flex flex-col gap-4">
        {mailboxes.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-fg-2">البريد</span>
            <Select label="البريد" value={mailboxId ?? null} onChange={(k) => setMailboxId(Number(k))}
              options={mailboxes.map((m) => ({ id: m.id, label: m.label }))} />
          </div>
        )}
        <RadioGroup aria-label="نطاق السحب" value={choice} onChange={(v) => { setChoice(v as Choice); setError(null); }} className="flex flex-col gap-2">
          <Option value="new" label="الجديد منذ آخر سحب" isDisabled={neverPulled} hint={neverPulled ? 'لم يُسحب بعد' : undefined} />
          <div className="grid grid-cols-3 gap-2">
            {(['d7', 'd30', 'd90'] as const).map((d) => <Option key={d} value={d} label={daysLabel(DAYS[d])} />)}
          </div>
          <Option value="all" label="كل الرسائل" hint={choice === 'all' ? 'قد يستغرق وقتاً طويلاً' : undefined} />
          <Option value="between" label="من تاريخ إلى تاريخ" />
        </RadioGroup>
        {/* outside the radio group so its arrow keys don't fight the date segments */}
        {choice === 'between' && (
          <div className="-mt-3 flex flex-col gap-1 rounded-b-ctl border border-t-0 border-accent px-3.5 pb-3 pt-3 ps-10">
            <DateRangePicker label="الفترة" value={period} onChange={(p) => { setPeriod(p); setError(null); }} className="w-[260px]" />
            {(localError && (period.from || period.to)) || error
              ? <span className="text-[12.5px] text-neg">{error ?? localError}</span>
              : <span className="text-[12.5px] text-fg-3">تاريخان شاملان بتوقيت الجهاز</span>}
          </div>
        )}
        {error && choice !== 'between' && <p className="text-[13px] text-neg">{error}</p>}
        <p className="text-[12.5px] text-fg-3">سحب نفس الفترة مرتين آمن: الرسائل المحفوظة تُعدّ مكررة ولا تُضاف ثانية</p>
      </div>
    </Dialog>
  );
}
