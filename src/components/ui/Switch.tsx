import { Switch as RacSwitch, type SwitchProps } from 'react-aria-components';
import type { ReactNode } from 'react';
import { cx } from './cx';

export function Switch({ children, className, ...props }: SwitchProps & { children?: ReactNode }) {
  return (
    <RacSwitch {...props} className={cx('group inline-flex cursor-default items-center gap-3 text-sm text-fg outline-none', className as string)}>
      {/* the knob starts on the right in RTL and moves left when on */}
      <span className="flex h-5 w-9 shrink-0 items-center rounded-full bg-line-strong px-0.5 transition-colors duration-150 group-data-[selected]:bg-accent group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus">
        <span className="size-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out group-data-[selected]:-translate-x-4" />
      </span>
      {children}
    </RacSwitch>
  );
}
