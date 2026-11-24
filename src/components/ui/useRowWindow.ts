import { useEffect, useState, type RefObject } from 'react';

/*
 * SPEC 6.10 "قوائم طويلة بلا ترقيم صفحات": only the rows in view (plus a margin) are drawn; space
 * above and below keeps the scroll bar true to the whole list. The table stays a real <table>, so
 * column widths, sticky columns and the alignment rules are unchanged. Short lists draw every row.
 */

const OVERSCAN = 12;
export const WINDOW_FROM = 150; // rows; below this everything is drawn

export function useRowWindow(scrollRef: RefObject<HTMLElement | null>, count: number) {
  const [view, setView] = useState({ top: 0, height: 800, rowH: 44, head: 40 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const row = el.querySelector<HTMLElement>('table tbody tr[data-key]'); // a real row, not the empty / loading line
      const head = el.querySelector<HTMLElement>('table thead');
      setView((v) => {
        const next = { top: el.scrollTop, height: el.clientHeight, rowH: row?.offsetHeight || v.rowH, head: head?.offsetHeight || v.head };
        return next.top === v.top && next.height === v.height && next.rowH === v.rowH && next.head === v.head ? v : next;
      });
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
  }, [scrollRef, count]);

  if (count < WINDOW_FROM) return { start: 0, end: count, padTop: 0, padBottom: 0, rowH: view.rowH, top: view.top, head: view.head, windowed: false };
  const first = Math.floor(Math.max(0, view.top - view.head) / view.rowH);
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(count, first + Math.ceil(view.height / view.rowH) + OVERSCAN);
  return { start, end, padTop: start * view.rowH, padBottom: (count - end) * view.rowH, rowH: view.rowH, top: view.top, head: view.head, windowed: true };
}
