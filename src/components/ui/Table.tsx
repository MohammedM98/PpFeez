import {
  Table as RacTable, TableHeader as RacHeader, Column as RacColumn, TableBody as RacBody, Row as RacRow, Cell as RacCell,
  Collection, useTableOptions, type TableProps, type ColumnProps, type RowProps, type CellProps, type TableHeaderProps,
  type TableBodyProps, composeRenderProps,
} from 'react-aria-components';
import { ArrowUp } from 'lucide-react';
import { Checkbox } from './Field';
import { cx } from './cx';

export function Table({ className, ...props }: TableProps) {
  return <RacTable {...props} className={cx('w-full border-separate border-spacing-0 text-sm', className as string)} />;
}

export function TableHeader<T extends object>({ columns, children, className }: TableHeaderProps<T>) {
  const { selectionBehavior, selectionMode, allowsDragging } = useTableOptions();
  return (
    <RacHeader className={cx('sticky top-0 z-10 bg-surface', className as string)}>
      {allowsDragging && <RacColumn />}
      {selectionBehavior === 'toggle' && (
        <RacColumn width={44} minWidth={44} className="h-10 border-b border-line ps-4 text-start">
          {selectionMode === 'multiple' && <Checkbox slot="selection" aria-label="تحديد الكل" />}
        </RacColumn>
      )}
      <Collection items={columns}>{children}</Collection>
    </RacHeader>
  );
}

export function Column({ className, children, align = 'start', ...props }: ColumnProps & { align?: 'start' | 'end' }) {
  return (
    <RacColumn
      {...props}
      className={composeRenderProps(className, (c) =>
        cx('h-10 border-b border-line px-2.5 text-[12.5px] font-medium text-fg-3 outline-none whitespace-nowrap',
          'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
          align === 'end' ? 'text-end' : 'text-start', c))}
    >
      {composeRenderProps(children, (ch, { allowsSorting, sortDirection }) => (
        <span className={cx('inline-flex items-center gap-1', allowsSorting && 'cursor-default hover:text-fg-2', sortDirection && 'text-fg-2')}>
          {ch}
          {allowsSorting && (
            <ArrowUp className={cx('size-3.5 transition-transform duration-150', !sortDirection && 'opacity-0', sortDirection === 'descending' && 'rotate-180')} aria-hidden />
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
        cx('group/row text-fg outline-none transition-colors duration-100',
          'data-[hovered]:bg-raised/50 data-[selected]:bg-accent-soft',
          'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus', c))}
    >
      {selectionBehavior === 'toggle' && (
        <Cell className="ps-4"><Checkbox slot="selection" aria-label="تحديد" /></Cell>
      )}
      <Collection items={columns}>{children}</Collection>
    </RacRow>
  );
}

export function Cell({ className, align = 'start', ...props }: CellProps & { align?: 'start' | 'end' }) {
  return (
    <RacCell
      {...props}
      className={composeRenderProps(className, (c) =>
        cx('h-12 border-b border-(--row-rule) px-2.5 align-middle outline-none group-last/row:border-b-0',
          'data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
          align === 'end' ? 'text-end' : 'text-start', c))}
    />
  );
}
