import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Accent, Density, Theme } from './contract';

/*
 * Appearance (SPEC 6.10): theme (light / dark / system / high contrast) × accent colour, row density
 * and UI scale. Applied as attributes on <html> so every token in globals.css follows; remembered
 * locally too, so the lock screen and start-up paint in the owner's choice before settings load.
 */
export type Appearance = { theme: Theme; accent: Accent; density: Density; uiScale: number };
export const DEFAULT_APPEARANCE: Appearance = { theme: 'dark', accent: 'blue', density: 'regular', uiScale: 100 };

type Resolved = 'dark' | 'light' | 'high_contrast';
type Ctx = Appearance & {
  resolved: Resolved;
  setTheme: (t: Theme) => void;
  set: (patch: Partial<Appearance>) => void;
};
const ThemeCtx = createContext<Ctx>({ ...DEFAULT_APPEARANCE, resolved: 'dark', setTheme: () => {}, set: () => {} });

const KEY = 'ppfeez.appearance';
export function rememberedAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) };
    const old = localStorage.getItem('ppfeez.theme') as Theme | null; // before 0.6.0
    return old ? { ...DEFAULT_APPEARANCE, theme: old } : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}
function remember(a: Appearance) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* private mode: fine */ }
}

const media = () => window.matchMedia('(prefers-color-scheme: dark)');
const clampScale = (n: number) => Math.min(150, Math.max(90, Math.round(n)));

/** Applies an appearance to the document (also used for the live preview in Settings). */
export function applyAppearance(a: Appearance, systemDark: boolean) {
  const resolved: Resolved = a.theme === 'system' ? (systemDark ? 'dark' : 'light') : a.theme;
  const el = document.documentElement;
  el.dataset.theme = resolved;
  el.dataset.accent = a.accent;
  el.dataset.density = a.density;
  // zoom keeps every px-sized detail in proportion (WebView2 / Chromium)
  const root = document.getElementById('root');
  if (root) root.style.zoom = String(clampScale(a.uiScale) / 100);
  return resolved;
}

export function ThemeProvider({ initial, onChange, children }: { initial: Appearance; onChange?: (patch: Partial<Appearance>) => void; children: ReactNode }) {
  const [a, setA] = useState<Appearance>(initial);
  const [systemDark, setSystemDark] = useState(() => media().matches);
  const key = `${initial.theme}|${initial.accent}|${initial.density}|${initial.uiScale}`;
  useEffect(() => setA(initial), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = media();
    const h = () => setSystemDark(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  const [resolved, setResolved] = useState<Resolved>('dark');
  useEffect(() => { setResolved(applyAppearance(a, systemDark)); remember(a); }, [a, systemDark]);
  const set = (patch: Partial<Appearance>) => {
    const next = { ...a, ...patch, ...(patch.uiScale !== undefined && { uiScale: clampScale(patch.uiScale) }) };
    setA(next);
    onChange?.(patch);
  };
  return <ThemeCtx.Provider value={{ ...a, resolved, setTheme: (theme) => set({ theme }), set }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
