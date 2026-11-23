import { tv, type VariantProps } from 'tailwind-variants';
import type { ReactNode } from 'react';

const badge = tv({
  base: 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2 h-6 text-[12.5px] font-medium leading-none',
  variants: {
    tone: {
      neutral: 'bg-raised text-fg-2',
      accent: 'bg-accent-soft text-accent-ink',
      pos: 'bg-pos-soft text-pos',
      neg: 'bg-neg-soft text-neg',
      warn: 'bg-warn-soft text-warn',
      outline: 'border border-line text-fg-2',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ tone, children, dot, className }: VariantProps<typeof badge> & { children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={badge({ tone, className })}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}
