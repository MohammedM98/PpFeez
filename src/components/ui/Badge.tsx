import { Chip } from '@heroui/react';
import type { ReactNode } from 'react';
import { cx } from './cx';

/* Status labels are HeroUI soft Chips; `outline` is the quiet one for facts that are not a state. */
const tones = {
  neutral: { color: 'default', variant: 'soft' },
  accent: { color: 'accent', variant: 'soft' },
  pos: { color: 'success', variant: 'soft' },
  neg: { color: 'danger', variant: 'soft' },
  warn: { color: 'warning', variant: 'soft' },
  outline: { color: 'default', variant: 'tertiary' },
} as const;

export function Badge({ tone = 'neutral', children, dot, className }: { tone?: keyof typeof tones; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <Chip {...tones[tone]} size="md"
      className={cx('h-6 gap-1 whitespace-nowrap text-[12.5px] leading-none', tone === 'neutral' && 'text-fg-2', tone === 'outline' && 'border border-line text-fg-2', className)}>
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />}
      <Chip.Label>{children}</Chip.Label>
    </Chip>
  );
}
