// Calendar presets for period filters. Dates only, local time.
import type { Period } from './contract';

export type PeriodPreset = 'all' | 'this_month' | 'last_month' | 'this_year' | 'custom';
export const periodLabels: Record<PeriodPreset, string> = {
  all: 'كل الفترات', this_month: 'هذا الشهر', last_month: 'الشهر الماضي', this_year: 'هذه السنة', custom: 'فترة مخصّصة',
};
const p2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

export function presetPeriod(preset: PeriodPreset, now = new Date()): Period {
  const y = now.getFullYear(), m = now.getMonth();
  switch (preset) {
    case 'this_month': return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) };
    case 'last_month': return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
    case 'this_year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    default: return {};
  }
}
