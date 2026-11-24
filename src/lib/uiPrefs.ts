import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { Settings } from './contract';

/*
 * The UI's own preferences (SPEC 6.10), kept by the core as an opaque JSON string in
 * `settings.uiPrefs` (contract §3, 256 KB limit): table columns, the sidebar, saved views.
 * Changes show at once (query cache) and are written back after a short pause.
 */

export type ColumnPrefs = {
  hidden?: string[];               // column ids the owner hid
  order?: string[];                // column ids in the owner's order (unknown ids keep their place at the end)
  widths?: Record<string, number>; // px, set by dragging the header edge
  pinned?: string[];               // pinned to the start edge, after the built-in sticky columns
};

/** what a list screen shows: remembered per screen, and the content of a saved view */
export type ScreenState = {
  tab?: string; currency?: string; mailboxId?: string; preset?: string; custom?: { from?: string; to?: string };
  needsFeeOnly?: boolean; needsReviewOnly?: boolean; sort?: { column: string; direction: 'ascending' | 'descending' };
};
export type SavedView = { name: string; state: ScreenState; columns?: ColumnPrefs };

export type UiPrefs = {
  sidebarCollapsed?: boolean;
  screens?: Record<string, ScreenState>;       // last tab / currency / filters, per screen and customer
  views?: Record<string, SavedView[]>;         // saved views, per list
  recentCustomers?: number[];     // last customers assigned to, newest first (quick assign, SPEC 6.10)
  tables?: Record<string, ColumnPrefs>;
};

const KEY = ['settings'];

export function parsePrefs(raw: string | undefined | null): UiPrefs {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as UiPrefs) : {};
  } catch {
    return {};
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let flush: (() => void) | undefined;
/**
 * The latest preferences not yet confirmed by the core. A settings refetch that lands before the
 * write would otherwise bring back the older value; until the write is confirmed this one wins.
 */
let pending: string | null = null;

function save(qc: QueryClient) {
  clearTimeout(timer);
  flush = () => {
    flush = undefined;
    const sent = pending;
    if (sent === null) return;
    void api.updateSettings({ uiPrefs: sent })
      .then(() => { if (pending === sent) pending = null; })
      .catch(() => undefined);
  };
  timer = setTimeout(() => flush?.(), 400);
  void qc; // the cache already shows the change
}
// closing the window right after a change still keeps it
window.addEventListener('pagehide', () => { clearTimeout(timer); flush?.(); });

const current = (s: Settings | undefined) => pending ?? s?.uiPrefs;

/** Change the preferences; the screen follows at once, the core is told shortly after. */
export function updatePrefs(qc: QueryClient, fn: (p: UiPrefs) => UiPrefs) {
  const s = qc.getQueryData<Settings>(KEY);
  if (!s) return;
  pending = JSON.stringify(fn(parsePrefs(current(s))));
  qc.setQueryData<Settings>(KEY, { ...s, uiPrefs: pending });
  save(qc);
}

export function useUiPrefs() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: KEY, queryFn: api.getSettings });
  const prefs = parsePrefs(current(settings.data));
  const update = useCallback((fn: (p: UiPrefs) => UiPrefs) => updatePrefs(qc, fn), [qc]);
  return { prefs, update, ready: !!settings.data };
}

/** One table's column preferences and setters (SPEC 6.10 "الأعمدة… تُحفظ لكل جدول"). */
export function useColumnPrefs(table: string) {
  const { prefs, update } = useUiPrefs();
  const cols = prefs.tables?.[table] ?? {};
  const set = useCallback((fn: (c: ColumnPrefs) => ColumnPrefs) =>
    update((p) => ({ ...p, tables: { ...p.tables, [table]: fn(p.tables?.[table] ?? {}) } })), [update, table]);
  const reset = useCallback(() =>
    update((p) => { const t = { ...p.tables }; delete t[table]; return { ...p, tables: t }; }), [update, table]);
  return { cols, set, reset };
}

/** Quick assign (SPEC 6.10): the last 5 customers used come first in the customer picker. */
export function useRecentCustomers() {
  const { prefs, update } = useUiPrefs();
  const recent = prefs.recentCustomers ?? [];
  const remember = useCallback((id: number) =>
    update((p) => ({ ...p, recentCustomers: [id, ...(p.recentCustomers ?? []).filter((x) => x !== id)].slice(0, 5) })), [update]);
  return { recent, remember };
}

/** The last state of a list screen (SPEC 6.10 "تذكّر آخر تبويب/عملة/فلتر لكل شاشة وعميل"). */
export function useScreenMemory(key: string) {
  const { prefs, update } = useUiPrefs();
  const saved = prefs.screens?.[key];
  const remember = useCallback((state: ScreenState) => update((p) => {
    if (JSON.stringify(p.screens?.[key]) === JSON.stringify(state)) return p;
    return { ...p, screens: { ...p.screens, [key]: state } };
  }), [update, key]);
  return { saved, remember };
}

/** Saved views of one list (SPEC 6.10 "طرق عرض محفوظة"). */
export function useSavedViews(list: string) {
  const { prefs, update } = useUiPrefs();
  const views = prefs.views?.[list] ?? [];
  const save = useCallback((v: SavedView) => update((p) => ({
    ...p, views: { ...p.views, [list]: [...(p.views?.[list] ?? []).filter((x) => x.name !== v.name), v] },
  })), [update, list]);
  const remove = useCallback((name: string) => update((p) => ({
    ...p, views: { ...p.views, [list]: (p.views?.[list] ?? []).filter((x) => x.name !== name) },
  })), [update, list]);
  return { views, save, remove };
}
