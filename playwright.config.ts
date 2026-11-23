import { defineConfig } from '@playwright/test';

// The UI runs in a plain browser with mockIPC (no Tauri), so the dev server is enough.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:1420',
    viewport: { width: 1280, height: 800 },
    locale: 'ar',
    trace: 'off',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
