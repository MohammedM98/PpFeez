import { Tabs as HeroTabs, type TabsProps, type TabProps, type TabListProps, type TabPanelProps } from '@heroui/react';
import type { ReactNode } from 'react';
import { cx } from './cx';

/*
 * HeroUI Tabs in the underline ("secondary") variant, for the lists that share one line with their
 * filters (SPEC 6.5). The line under the row is drawn by the row itself; the indicator sits on it.
 */
export function Tabs({ className, ...props }: TabsProps) {
  return <HeroTabs variant="secondary" {...props} className={cx('gap-0', className as string)} />;
}

export function TabList({ className, ...props }: TabListProps) {
  return (
    <HeroTabs.ListContainer className="-mb-px border-b-0!">
      <HeroTabs.List {...props} className={cx('gap-1', className as string)} />
    </HeroTabs.ListContainer>
  );
}

export function Tab({ children, className, ...props }: Omit<TabProps, 'children'> & { children: ReactNode }) {
  return (
    <HeroTabs.Tab {...props} className={cx('h-10 w-auto gap-2 px-3 font-normal data-[selected=true]:font-medium', className as string)}>
      {children}
      <HeroTabs.Indicator />
    </HeroTabs.Tab>
  );
}

export function TabPanel({ className, ...props }: TabPanelProps) {
  return <HeroTabs.Panel {...props} className={cx('m-0! p-0', className as string)} />;
}
