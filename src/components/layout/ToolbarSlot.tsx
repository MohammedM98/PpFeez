import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/components/ui/cx';

/**
 * SPEC 6.5 "الجدول هو الصفحة": a tab's filters sit on the same line as the tabs. The page renders the
 * line and hands its free end down here; the active tab portals its filters into it.
 */
export const ToolbarSlotContext = createContext<HTMLElement | null>(null);

export function InToolbar({ children, className }: { children: ReactNode; className?: string }) {
  const slot = useContext(ToolbarSlotContext);
  if (slot) return createPortal(children, slot);
  return <div className={cx('mb-3 flex flex-wrap items-center gap-2', className)}>{children}</div>;
}
