import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { measureDigits } from '@/components/ui/Amount';

async function boot() {
  if (!window.__TAURI_INTERNALS__) {
    const { installMocks } = await import('@/mocks');
    installMocks();
  }
  measureDigits();
  const { App } = await import('./App');
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
void boot();
