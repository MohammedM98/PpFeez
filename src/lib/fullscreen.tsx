import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/*
 * SPEC 6.10 "وضع ملء الشاشة للجدول": a button or F11 hides the sidebar and the page header; the
 * selection bar, the summary strip, the filters and the table stay.
 */
type Ctx = { full: boolean; toggle: () => void; exit: () => void };
const FullCtx = createContext<Ctx>({ full: false, toggle: () => {}, exit: () => {} });

export function FullscreenProvider({ children }: { children: ReactNode }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F11') return;
      e.preventDefault();
      setFull((f) => !f);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-table-fullscreen', full);
  }, [full]);
  return <FullCtx.Provider value={{ full, toggle: () => setFull((f) => !f), exit: () => setFull(false) }}>{children}</FullCtx.Provider>;
}

export const useFullscreen = () => useContext(FullCtx);
