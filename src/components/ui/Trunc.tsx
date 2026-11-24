import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * One line, cut with an ellipsis at the end of the text's own direction, so a Latin
 * note keeps its beginning inside the RTL table ("Logo design…", not "…final payment").
 */
export function Trunc({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <div dir="auto" title={title ?? (typeof children === 'string' ? children : undefined)} className={cx('truncate text-right', className)}>{children}</div>;
}
