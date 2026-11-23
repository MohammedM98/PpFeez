import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Theme } from './contract';

type Ctx = { theme: Theme; resolved: 'dark' | 'light'; setTheme: (t: Theme) => void };
const ThemeCtx = createContext<Ctx>({ theme: 'dark', resolved: 'dark', setTheme: () => {} });

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function ThemeProvider({ initial, onChange, children }: { initial: Theme; onChange?: (t: Theme) => void; children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initial);
  const [systemDark, setSystemDark] = useState(() => media().matches);
  useEffect(() => setThemeState(initial), [initial]);
  useEffect(() => {
    const m = media();
    const h = () => setSystemDark(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  const setTheme = (t: Theme) => {
    setThemeState(t);
    onChange?.(t);
  };
  return <ThemeCtx.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
