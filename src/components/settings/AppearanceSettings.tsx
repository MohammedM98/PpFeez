import { Radio, RadioGroup } from 'react-aria-components';
import { Slider } from '@heroui/react';
import { Check, Contrast, Monitor, Moon, Sun } from 'lucide-react';
import type { Accent, Density, Theme } from '@/lib/contract';
import { useTheme } from '@/lib/theme';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cx } from '@/components/ui/cx';

/*
 * SPEC 6.10 appearance: theme × accent, density and UI scale. Every change applies at once to the
 * whole app (that is the live preview) and is saved in the settings.
 */

const THEMES: { id: Theme; label: string; icon: React.ReactNode }[] = [
  { id: 'light', label: 'فاتح', icon: <Sun /> },
  { id: 'dark', label: 'داكن', icon: <Moon /> },
  { id: 'system', label: 'حسب النظام', icon: <Monitor /> },
  { id: 'high_contrast', label: 'تباين عالٍ', icon: <Contrast /> },
];
// the swatch shows the accent's fill colour; names are spoken by screen readers
const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: 'blue', label: 'أزرق', swatch: '#2f5fe8' },
  { id: 'emerald', label: 'زمردي', swatch: '#047857' },
  { id: 'violet', label: 'بنفسجي', swatch: '#6d28d9' },
  { id: 'amber', label: 'كهرماني', swatch: '#b45309' },
  { id: 'rose', label: 'وردي', swatch: '#be123c' },
  { id: 'slate', label: 'رمادي', swatch: '#475569' },
];
const DENSITIES: { id: Density; label: string; hint: string }[] = [
  { id: 'comfortable', label: 'مريح', hint: 'صفوف أعلى' },
  { id: 'regular', label: 'عادي', hint: 'الافتراضي' },
  { id: 'compact', label: 'مضغوط', hint: 'صفوف أكثر في الشاشة' },
];

const card = ({ isSelected }: { isSelected: boolean }) => cx(
  'flex min-h-11 cursor-default items-center gap-2 rounded-ctl border px-3 py-2 text-sm outline-none transition-colors duration-150',
  'data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus',
  isSelected ? 'border-accent bg-accent-soft text-fg' : 'border-line text-fg-2 hover:border-line-strong');

function Preview() {
  return (
    <div aria-hidden className="rounded-card border border-line bg-bg p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-fg">معاينة</span>
        <Button size="sm" variant="primary" excludeFromTabOrder>اعتماد</Button>
      </div>
      <div className="overflow-hidden rounded-ctl border border-line bg-surface text-[13px]">
        {[['Liam Turner', 30000, 'pos'], ['Ava Collins', -2000, 'neg']].map(([n, m, tone]) => (
          <div key={n as string} className="flex h-(--row-h) items-center justify-between border-b border-line px-3 last:border-b-0">
            <span className="text-fg">{n}</span>
            <span className="flex items-center gap-2">
              <Badge tone={tone === 'pos' ? 'pos' : 'neg'}>{tone === 'pos' ? 'معتمدة' : 'مرتجع'}</Badge>
              <Amount minor={m as number} currency="USD" tone="signed" />
            </span>
          </div>
        ))}
        <div className="flex h-(--row-h) items-center justify-between px-3 text-accent-ink">رابط بلون التمييز<span className="rounded-[6px] bg-accent-soft px-2 py-0.5">محدّد</span></div>
      </div>
    </div>
  );
}

export function AppearanceSettings() {
  const a = useTheme();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-6">
      <div className="flex flex-col gap-5">
        <RadioGroup aria-label="المظهر" value={a.theme} onChange={(v) => a.set({ theme: v as Theme })} className="flex flex-col gap-2">
          <span className="text-sm text-fg">المظهر</span>
          <div className="grid grid-cols-4 gap-2">
            {THEMES.map((t) => (
              <Radio key={t.id} value={t.id} className={card}>
                <span className="[&_svg]:size-4 [&_svg]:stroke-[1.7]">{t.icon}</span>{t.label}
              </Radio>
            ))}
          </div>
        </RadioGroup>

        <RadioGroup aria-label="لون التمييز" value={a.accent} onChange={(v) => a.set({ accent: v as Accent })} className="flex flex-col gap-2">
          <span className="text-sm text-fg">لون التمييز</span>
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((c) => (
              <Radio key={c.id} value={c.id} aria-label={c.label} className={({ isSelected, isFocusVisible }) => cx(
                'grid size-11 cursor-default place-items-center rounded-full border-2 outline-none',
                isSelected ? 'border-fg' : 'border-transparent', isFocusVisible && 'outline-2 outline-offset-2 outline-focus')}>
                {({ isSelected }) => (
                  <span className="grid size-8 place-items-center rounded-full text-white" style={{ background: c.swatch }} title={c.label}>
                    {isSelected && <Check className="size-4" strokeWidth={2.5} />}
                  </span>
                )}
              </Radio>
            ))}
          </div>
        </RadioGroup>

        <RadioGroup aria-label="كثافة الجداول" value={a.density} onChange={(v) => a.set({ density: v as Density })} className="flex flex-col gap-2">
          <span className="text-sm text-fg">كثافة الجداول</span>
          <div className="grid grid-cols-3 gap-2">
            {DENSITIES.map((d) => (
              <Radio key={d.id} value={d.id} className={card}>
                <span className="flex flex-col leading-tight">{d.label}<span className="text-[12px] text-fg-3">{d.hint}</span></span>
              </Radio>
            ))}
          </div>
        </RadioGroup>

        <div className="flex flex-col gap-2">
          <Slider aria-label="حجم الواجهة" minValue={90} maxValue={150} step={10} value={a.uiScale} onChange={(v) => a.set({ uiScale: Array.isArray(v) ? v[0] : v })}
            className="max-w-[360px]">
            <div className="flex items-center justify-between text-sm">
              <span className="text-fg">حجم الواجهة</span>
              <Slider.Output className="num text-fg-2">{({ state }) => `${state.values[0]}%`}</Slider.Output>
            </div>
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb aria-label="حجم الواجهة" />
            </Slider.Track>
          </Slider>
          <p className="text-[12.5px] text-fg-3">يكبّر كل شيء معاً، والجداول تبقى بنفس المحاذاة</p>
        </div>
      </div>
      <Preview />
    </div>
  );
}
