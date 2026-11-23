import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';

async function boot() {
  if (!window.__TAURI_INTERNALS__) {
    const { installMocks } = await import('@/mocks');
    installMocks();
  }
  const { App } = await import('./App');
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
void boot();
