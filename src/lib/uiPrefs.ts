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

export type UiPrefs = {
  sidebarCollapsed?: boolean;
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
function save(qc: QueryClient) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const s = qc.getQueryData<Settings>(KEY);
    if (s) void api.updateSettings({ uiPrefs: s.uiPrefs }).catch(() => undefined);
  }, 400);
}

/** Change the preferences; the screen follows at once, the core is told shortly after. */
export function updatePrefs(qc: QueryClient, fn: (p: UiPrefs) => UiPrefs) {
  const s = qc.getQueryData<Settings>(KEY);
  if (!s) return;
  const next = fn(parsePrefs(s.uiPrefs));
  qc.setQueryData<Settings>(KEY, { ...s, uiPrefs: JSON.stringify(next) });
  save(qc);
}

export function useUiPrefs() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: KEY, queryFn: api.getSettings });
  const prefs = parsePrefs(settings.data?.uiPrefs);
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
