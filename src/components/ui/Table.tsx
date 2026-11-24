import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import {
  Table as RacTable, TableHeader as RacHeader, Column as RacColumn, TableBody as RacBody, Row as RacRow, Cell as RacCell,
  Collection, useTableOptions, type TableProps, type ColumnProps, type RowProps, type CellProps, type TableHeaderProps,
  type TableBodyProps, composeRenderProps,
} from 'react-aria-components';
import { ArrowUp } from 'lucide-react';
import { Checkbox } from './Field';
import { cx } from './cx';

/*
 * Table alignment rules (SPEC 6, "محاذاة الجداول"), shared by every table:
 * - `table-layout: fixed`: each column has one width and one alignment, used by the header and the
 *   cells alike; one column per table is left without a width and takes the remaining space.
 * - the table never shrinks below `minWidth`; a narrower window scrolls inside the table frame,
 *   with the selection/date columns and the ⋯ column kept in place (`sticky`).
 * - amounts use <Amount fit> so decimal points line up; text cells use <Trunc>.
 */

export type Align = 'start' | 'end';
export type Sticky = 'start' | 'end';
type Geometry = { width?: string; sticky?: Sticky; stickyOffset?: string };

/** Width of the selection checkbox column. */
export const SELECT_W = '44px';

/** min-width of a table from its column widths (and the minimum of its flexible column). */
export function sumWidths(widths: (string | undefined)[]): string {
  return `calc(${widths.filter(Boolean).join(' + ')})`;
}

const stickyAttr = (sticky?: Sticky) => (sticky ? { 'data-sticky': sticky } : {});

function geometry({ width, sticky, stickyOffset = '0px' }: Geometry): CSSProperties {
  return {
    width,
    ...(sticky === 'start' && { insetInlineStart: stickyOffset }),
    ...(sticky === 'end' && { insetInlineEnd: stickyOffset }),
  };
}

export function Table({ className, minWidth, style, ...props }: TableProps & { minWidth?: string }) {
  return (
    <RacTable {...props} style={{ ...(style as CSSProperties), minWidth }}
      className={cx('w-full table-fixed border-separate border-spacing-0 text-sm', className as string)} />
  );
}

/**
 * The table's border and the scroll area that keeps overflow inside it. The area is no taller
 * than what is left of the window below it, so the horizontal scrollbar is always in view, and
 * the header stays in place while the rows scroll.
 */
export function TableFrame({ children, footer, className, fill }: { children: ReactNode; footer?: ReactNode; className?: string; fill?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // without `fill`, the frame is no taller than what is left of the window below it
    const fit = () => {
      if (fill) return;
      const page = el.closest('main');
      const top = el.getBoundingClientRect().top + (page?.scrollTop ?? 0);
      el.style.maxHeight = `${Math.max(360, window.innerHeight - top - 24)}px`;
    };
    // mark which sides have more to scroll to, for the shadow on the columns that stay in place
    const edges = () => {
      const max = el.scrollWidth - el.clientWidth;
      const x = Math.abs(el.scrollLeft); // RTL: 0 at the start (right), negative towards the end
      el.toggleAttribute('data-more-end', max > 1 && x < max - 1);
      el.toggleAttribute('data-more-start', max > 1 && x > 1);
    };
    fit();
    edges();
    const ro = new ResizeObserver(edges);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener('scroll', edges, { passive: true });
    window.addEventListener('resize', fit);
    return () => { window.removeEventListener('resize', fit); el.removeEventListener('scroll', edges); ro.disconnect(); };
  });
  return (
    // `fill` (SPEC 6.5 "the table is the page"): the frame takes the rest of the page's height and scrolls inside
    <div className={cx('overflow-hidden rounded-card border border-line bg-surface', fill && 'flex min-h-0 flex-1 flex-col', className)}>
      <div ref={ref} className={cx('overflow-auto overscroll-contain', fill && 'min-h-0 flex-1')} data-table-scroll="">{children}</div>
      {footer}
    </div>
  );
}

/** A screen whose table is the page (SPEC 6.5): the page itself does not scroll; the table fills the rest. */
export const tablePage = 'table-page mx-auto flex h-full w-full flex-col overflow-hidden px-6 pb-4 pt-4';

export function TableHeader<T extends object>({ columns, children, className }: TableHeaderProps<T>) {
  const { selectionBehavior, selectionMode, allowsDragging } = useTableOptions();
  return (
    <RacHeader className={cx('sticky top-0 z-10', className as string)}>
      {allowsDragging && <RacColumn />}
      {selectionBehavior === 'toggle' && (
        <RacColumn style={geometry({ width: SELECT_W, sticky: 'start' })} data-sticky="start-inner" className="t-head sticky z-[2] h-10 border-b border-line ps-4 text-start">
          {selectionMode === 'multiple' && <Checkbox slot="selection" aria-label="تحديد الكل" />}
        </RacColumn>
      )}
      <Collection items={columns}>{children}</Collection>
    </RacHeader>
  );
}

export function Column({ className, children, align = 'start', width, sticky, stickyOffset, ...props }: Omit<ColumnProps, 'width'> & { align?: Align } & Geometry) {
  return (
    <RacColumn
      {...props}
      style={geometry({ width, sticky, stickyOffset })}
      {...stickyAttr(sticky)}
      data-align={align}
      className={composeRenderProps(className, (c) =>
        cx('t-head h-10 overflow-hidden border-b border-line px-2.5 font-normal outline-none whitespace-nowrap',
          'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
          sticky && 'sticky z-[2]', align === 'end' ? 'text-end' : 'text-start', c))}
    >
      {composeRenderProps(children, (ch, { allowsSorting, sortDirection }) => (
        <span data-col-label="" className={cx('inline-flex max-w-full items-center gap-1 text-[12.5px] font-medium text-fg-3',
          allowsSorting && 'cursor-default hover:text-fg-2', sortDirection && 'text-fg-2')}>
          <span className="truncate">{ch}</span>
          {allowsSorting && (
            <ArrowUp className={cx('size-3.5 shrink-0 transition-transform duration-150', !sortDirection && 'hidden', sortDirection === 'descending' && 'rotate-180')} aria-hidden />
          )}
        </span>
      ))}
    </RacColumn>
  );
}

export function TableBody<T extends object>(props: TableBodyProps<T>) {
  return <RacBody {...props} />;
}

export function Row<T extends object>({ id, columns, children, className, ...props }: RowProps<T>) {
  const { selectionBehavior } = useTableOptions();
  return (
    <RacRow
      id={id}
      {...props}
      className={composeRenderProps(className, (c) =>
        cx('t-row group/row text-fg outline-none',
          'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus', c))}
    >
      {selectionBehavior === 'toggle' && (
        <Cell sticky="start" inner className="ps-4"><Checkbox slot="selection" aria-label="تحديد" /></Cell>
      )}
      <Collection items={columns}>{children}</Collection>
    </RacRow>
  );
}

export function Cell({ className, align = 'start', sticky, stickyOffset, inner, ...props }: CellProps & { align?: Align; inner?: boolean } & Omit<Geometry, 'width'>) {
  return (
    <RacCell
      {...props}
      style={geometry({ sticky, stickyOffset })}
      {...(inner ? { 'data-sticky': 'start-inner' } : stickyAttr(sticky))}
      data-align={align}
      className={composeRenderProps(className, (c) =>
        cx('t-cell h-(--row-h) border-b border-(--row-rule) px-2.5 align-middle leading-tight outline-none whitespace-nowrap group-last/row:border-b-0',
          'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
          sticky && 'sticky z-[1]', align === 'end' ? 'text-end' : 'text-start', c))}
    />
  );
}

/**
 * Totals under a table, on exactly the same columns: a second fixed table with the same
 * widths and min-width, inside the same scroll area.
 */
export function TotalsTable({ widths, minWidth, label, children }: { widths: (string | undefined)[]; minWidth: string; label: string; children: ReactNode }) {
  return (
    <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-sm" style={{ minWidth }}>
      <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
      <tbody>{children}</tbody>
    </table>
  );
}

export function TotalsCell({ children, align = 'start', sticky, stickyOffset, className, colSpan }: { children?: ReactNode; align?: Align; className?: string; colSpan?: number } & Omit<Geometry, 'width'>) {
  return (
    <td colSpan={colSpan} style={geometry({ sticky, stickyOffset })} {...stickyAttr(sticky)} data-align={align}
      className={cx('t-foot h-10 border-t border-line px-2.5 align-middle leading-tight whitespace-nowrap', sticky && 'sticky z-[1]', align === 'end' ? 'text-end' : 'text-start', className)}>
      {children}
    </td>
  );
}

/** Header label for plain <table>s, styled like <Column>. */
export function HeadLabel({ children }: { children: ReactNode }) {
  return <span data-col-label="" className="inline-block max-w-full truncate align-middle text-[12.5px] font-medium text-fg-3">{children}</span>;
}
