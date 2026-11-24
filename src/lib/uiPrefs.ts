import { useCallback, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

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

/*
 * The preferences live in their own small store, read once from the settings. Changing them re-renders
 * only what reads them (not the whole app, which follows the settings query) and is written back to the
 * core after a short pause, and at once when the window closes.
 */
let state: UiPrefs = {};
let loaded = false;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const snapshot = () => state;

let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
function flush() {
  clearTimeout(timer);
  if (!dirty) return;
  dirty = false;
  void api.updateSettings({ uiPrefs: JSON.stringify(state) }).catch(() => { dirty = true; });
}
window.addEventListener('pagehide', flush);

/** Change the preferences; the screen follows at once, the core is told shortly after. */
export function updatePrefs(fn: (p: UiPrefs) => UiPrefs) {
  const next = fn(state);
  if (next === state) return;
  state = next;
  dirty = true;
  listeners.forEach((l) => l());
  clearTimeout(timer);
  timer = setTimeout(flush, 400);
}

export function useUiPrefs() {
  const settings = useQuery({ queryKey: KEY, queryFn: api.getSettings });
  if (!loaded && settings.data) { state = parsePrefs(settings.data.uiPrefs); loaded = true; }
  const prefs = useSyncExternalStore(subscribe, snapshot);
  const update = useCallback((fn: (p: UiPrefs) => UiPrefs) => updatePrefs(fn), []);
  return { prefs, update, ready: loaded };
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
