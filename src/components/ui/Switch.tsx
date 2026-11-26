import { Switch as HeroSwitch, type SwitchProps } from '@heroui/react';
import type { ReactNode } from 'react';
import { cx } from './cx';

export function Switch({ children, className, ...props }: Omit<SwitchProps, 'children'> & { children?: ReactNode }) {
  return (
    <HeroSwitch {...props} className={cx('text-sm text-fg', className as string)}>
      <HeroSwitch.Content>
        <HeroSwitch.Control><HeroSwitch.Thumb /></HeroSwitch.Control>
        {children}
      </HeroSwitch.Content>
    </HeroSwitch>
  );
}
