import type { Accent } from '@/lib/contract';
// Browser-only mode (contract §1): when there is no Tauri runtime, answer every
// command from the in-memory mock backend in ./handlers.ts.
import { mockIPC } from '@tauri-apps/api/mocks';
import { getDb, handle, resetDb, setExcelLocked } from './handlers';
import { addManyRows, addStressData } from './db';
import { mockUpdater } from './updater';
import { setUpdaterImpl } from '@/lib/updater';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function installMocks() {
  const params = new URLSearchParams(location.search);
  resetDb({
    locked: params.get('locked') === '1',
    onboardingDone: params.get('onboarding') !== '1',
  });
  if (params.get('onboarding') === '1') {
    const db = getDb();
    db.settings.onboardingDone = false;
    db.lockPassword = null;
    db.status.lockEnabled = false;
    db.mailboxes = [];
    db.settings.backupDir = null;
  }
  if (params.get('empty') === '1') {
    // a fresh install: no transactions, customers, ledger or emails yet
    const db = getDb();
    db.txns = []; db.customers = []; db.ledger = []; db.emails = []; db.history = [];
  }
  if (params.get('stress') === '1') addStressData(getDb());
  if (params.get('rows')) addManyRows(getDb(), Number(params.get('rows')));
  if (params.get('theme')) getDb().settings.theme = params.get('theme') as 'dark' | 'light' | 'system';
  if (params.get('accent')) getDb().settings.accent = params.get('accent') as Accent;
  const latency = Number(params.get('latency') ?? 60);

  mockIPC(
    async (cmd, args) => {
      await delay(latency);
      // Clone so the UI can never mutate mock state by reference.
      const out = handle(cmd, (args ?? {}) as Record<string, unknown>);
      return out === undefined ? null : structuredClone(out);
    },
    { shouldMockEvents: true },
  );
  setUpdaterImpl(mockUpdater(params));
  Object.assign(window, { __ppfeezMock: { getDb, resetDb, setExcelLocked } });
  console.info('[PpFeez] Running in browser mode with mock data');
}
