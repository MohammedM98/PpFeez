import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Button as RacButton, DialogTrigger, Dialog as RacDialog, GridList, GridListItem, Popover, useDragAndDrop } from 'react-aria-components';
import { Columns3, GripVertical, Pin, PinOff, RotateCcw } from 'lucide-react';
import { useColumnPrefs, type ColumnPrefs } from '@/lib/uiPrefs';
import { Button } from './Button';
import { Checkbox } from './Field';
import { cx } from './cx';

/*
 * SPEC 6.10 "الأعمدة": show/hide, width by dragging the header edge, order by dragging, pin a column —
 * kept per table in uiPrefs, with "إعادة ضبط الأعمدة". The built-in sticky columns (selection, #, date,
 * the ⋯ menu) stay where they are; these are the columns between them.
 */

export type ColDef = {
  id: string;
  label: string;
  /** default width; undefined = the flexible column that takes what is left (it can't be pinned or resized) */
  width?: string;
  /** narrowest it may be dragged to (amount columns: their measured width, so no amount is ever cut) */
  min?: string;
  /** false = always shown (e.g. له / عليه / الرصيد) */
  hideable?: boolean;
};

export type ColView = ColDef & { w: string | undefined; pinned: boolean; offset?: string; last?: boolean };

/** Puts ids the saved order doesn't know (new columns) right after their default neighbour. */
function mergeOrder(saved: string[] | undefined, defaults: string[]): string[] {
  const out = (saved ?? []).filter((id) => defaults.includes(id));
  defaults.forEach((id, i) => {
    if (out.includes(id)) return;
    const prev = defaults.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, id);
  });
  return out;
}

/**
 * The columns to draw, in the owner's order, with their widths; pinned columns first, sticky at the
 * start edge after `stickyStart` (the width of the built-in sticky columns before them).
 */
export function useColumns(table: string, defs: ColDef[], stickyStart: string) {
  const { cols, set, reset } = useColumnPrefs(table);
  const byId = useMemo(() => new Map(defs.map((d) => [d.id, d])), [defs]);
  const order = mergeOrder(cols.order, defs.map((d) => d.id));
  const hidden = new Set((cols.hidden ?? []).filter((id) => byId.get(id)?.hideable !== false));
  const pinnedIds = (cols.pinned ?? []).filter((id) => byId.get(id)?.width && !hidden.has(id));

  const widthOf = (d: ColDef) => {
    const px = cols.widths?.[d.id];
    return d.width && px ? `max(${px}px, ${d.min ?? '48px'})` : d.width;
  };
  const visible = order.filter((id) => !hidden.has(id)).map((id) => byId.get(id)!);
  const sorted = [...visible.filter((d) => pinnedIds.includes(d.id)), ...visible.filter((d) => !pinnedIds.includes(d.id))];
  const offsets: string[] = [stickyStart];
  const columns: ColView[] = sorted.map((d) => {
    const w = widthOf(d);
    const pinned = pinnedIds.includes(d.id);
    const view: ColView = { ...d, w, pinned, offset: pinned ? `calc(${offsets.join(' + ')})` : undefined };
    if (pinned && w) offsets.push(w);
    return view;
  });
  const lastPinned = columns.filter((c) => c.pinned).pop();
  if (lastPinned) lastPinned.last = true;

  return {
    columns,
    all: order.map((id) => ({ ...byId.get(id)!, hidden: hidden.has(id), pinned: pinnedIds.includes(id) })),
    customized: Object.keys(cols).length > 0,
    current: cols,
    replace: (next: ColumnPrefs) => set(() => next),
    reset,
    setWidth: (id: string, px: number) => set((c) => ({ ...c, widths: { ...c.widths, [id]: Math.round(px) } })),
    toggle: (id: string, show: boolean) => set((c) => ({ ...c, hidden: show ? (c.hidden ?? []).filter((x) => x !== id) : [...new Set([...(c.hidden ?? []), id])] })),
    pin: (id: string, on: boolean) => set((c) => ({ ...c, pinned: on ? [...new Set([...(c.pinned ?? []), id])] : (c.pinned ?? []).filter((x) => x !== id) })),
    reorder: (next: string[]) => set((c) => ({ ...c, order: next })),
  };
}

export type Columns = ReturnType<typeof useColumns>;

/** Sticky geometry for a movable column's header and cells. */
export function colStyle(c: ColView) {
  return c.pinned ? { position: 'sticky' as const, insetInlineStart: c.offset } : undefined;
}
export function colAttrs(c: ColView) {
  return c.pinned ? { 'data-sticky': c.last ? 'start' : 'start-inner', 'data-col': c.id } : { 'data-col': c.id };
}

/**
 * The header edge that changes a column's width: drag it, or focus it and use ←/→ (8px a step).
 * In RTL the edge sits on the left of the header; dragging left widens.
 */
export function ColumnResizer({ col, onResize }: { col: ColView; onResize: (px: number) => void }) {
  const start = useRef<{ x: number; w: number; rtl: boolean } | null>(null);
  // the width the column has now, for screen readers (a separator that can be focused carries its value)
  const self = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(0);
  useLayoutEffect(() => {
    const th = self.current?.closest('th');
    if (!th) return;
    const ro = new ResizeObserver(() => setPx(Math.round(th.getBoundingClientRect().width)));
    ro.observe(th);
    return () => ro.disconnect();
  }, []);
  const pendingKey = useRef<number | null>(null);
  const clearKey = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (!col.width) return null;
  const th = (el: Element) => el.closest('th') as HTMLElement;
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const h = th(e.currentTarget);
    start.current = { x: e.clientX, w: h.getBoundingClientRect().width, rtl: getComputedStyle(h).direction === 'rtl' };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const d = e.clientX - s.x;
    onResize(Math.max(48, s.w + (s.rtl ? -d : d)));
  };
  const up = () => { start.current = null; };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation(); // not the table's own arrow-key navigation
    // quick repeated presses build on the last width set, not on a header that hasn't redrawn yet
    const w = pendingKey.current ?? th(e.currentTarget).getBoundingClientRect().width;
    const rtl = getComputedStyle(th(e.currentTarget)).direction === 'rtl';
    const wider = rtl ? e.key === 'ArrowLeft' : e.key === 'ArrowRight';
    const next = Math.max(48, w + (wider ? 8 : -8));
    pendingKey.current = next;
    clearTimeout(clearKey.current);
    clearKey.current = setTimeout(() => { pendingKey.current = null; }, 300);
    onResize(next);
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label={`عرض عمود ${col.label}`} tabIndex={0}
      ref={self} aria-valuenow={px} aria-valuemin={48} aria-valuemax={1200} aria-valuetext={`${px} بكسل`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} onClick={(e) => e.stopPropagation()}
      className="absolute inset-y-1.5 end-0 z-[3] w-2 cursor-col-resize touch-none rounded-full outline-none after:absolute after:inset-y-1 after:end-0.5 after:w-px after:bg-line hover:after:w-0.5 hover:after:bg-accent focus-visible:after:w-0.5 focus-visible:after:bg-focus" />
  );
}

/** "الأعمدة": show/hide, drag to reorder (or the grip with the keyboard), pin, and reset. */
export function ColumnsMenu({ cols, label = 'الأعمدة' }: { cols: Columns; label?: string }) {
  const items = cols.all;
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) => [...keys].map((k) => ({ 'text/plain': String(k) })),
    onReorder: (e) => {
      const ids = items.map((c) => c.id);
      const moving = ids.filter((id) => e.keys.has(id));
      const rest = ids.filter((id) => !e.keys.has(id));
      const at = rest.indexOf(String(e.target.key)) + (e.target.dropPosition === 'after' ? 1 : 0);
      rest.splice(at, 0, ...moving);
      cols.reorder(rest);
    },
    renderDropIndicator: (target) => (
      <div role="presentation" className="h-0.5 bg-accent" data-target={target.type === 'item' ? String(target.key) : ''} />
    ),
  });
  return (
    <DialogTrigger>
      <Button variant="secondary" size="icon" aria-label={label} className="size-8"><Columns3 /><span className="sr-only">{label}</span></Button>
      <Popover placement="bottom end" className="w-72 rounded-card border border-line bg-surface shadow-(--shadow-float) outline-none">
        <RacDialog aria-label={label} className="flex max-h-[70vh] flex-col outline-none">
          <div className="border-b border-line px-3 py-2 text-[12.5px] text-fg-3">اسحب لتغيير الترتيب، ودبّوس لتثبيت العمود عند الحافة</div>
          <GridList aria-label="ترتيب الأعمدة" items={items} dragAndDropHooks={dragAndDropHooks} className="min-h-0 overflow-auto p-1 outline-none">
            {(c) => (
              <GridListItem id={c.id} textValue={c.label}
                className="flex h-9 cursor-default items-center gap-1.5 rounded-[6px] px-1.5 text-sm outline-none data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus data-[dragging]:opacity-50 data-[hovered]:bg-raised">
                <RacButton slot="drag" aria-label={`نقل ${c.label}`} className="grid size-6 cursor-grab place-items-center rounded text-fg-3 outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus">
                  <GripVertical className="size-4" />
                </RacButton>
                <Checkbox isSelected={!c.hidden} isDisabled={c.hideable === false} onChange={(v) => cols.toggle(c.id, v)} aria-label={`إظهار ${c.label}`}>
                  <span className={cx('truncate', c.hidden && 'text-fg-3')}>{c.label}</span>
                </Checkbox>
                {c.width && !c.hidden && (
                  <RacButton aria-label={c.pinned ? `إلغاء تثبيت ${c.label}` : `تثبيت ${c.label}`} aria-pressed={c.pinned} onPress={() => cols.pin(c.id, !c.pinned)}
                    className={cx('ms-auto grid size-7 place-items-center rounded outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus data-[hovered]:bg-surface', c.pinned ? 'text-accent-ink' : 'text-fg-3')}>
                    {c.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </RacButton>
                )}
              </GridListItem>
            )}
          </GridList>
          <div className="border-t border-line p-1">
            <RacButton onPress={cols.reset} isDisabled={!cols.customized}
              className="flex h-8 w-full items-center gap-2 rounded-[6px] px-2.5 text-sm text-fg-2 outline-none data-[disabled]:text-fg-3 data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus data-[hovered]:bg-raised">
              <RotateCcw className="size-3.5" />إعادة ضبط الأعمدة
            </RacButton>
          </div>
        </RacDialog>
      </Popover>
    </DialogTrigger>
  );
}
