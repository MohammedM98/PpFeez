// Auto-update (SPEC 6.9) through plugin-updater / plugin-process. Pages use this
// module only; in browser mode it is replaced by src/mocks/updater.ts.
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type AvailableUpdate = {
  version: string;
  currentVersion: string;
  date?: string;
  notes: string;
  /** Downloads and installs; `onProgress(received, total)` with total null when unknown. */
  install: (onProgress: (received: number, total: number | null) => void) => Promise<void>;
};

export type UpdaterImpl = {
  check: () => Promise<AvailableUpdate | null>;
  relaunch: () => Promise<void>;
};

const real: UpdaterImpl = {
  async check() {
    const u = await check();
    if (!u) return null;
    return {
      version: u.version,
      currentVersion: u.currentVersion,
      date: u.date,
      notes: u.body ?? '',
      install: async (onProgress) => {
        let received = 0;
        let total: number | null = null;
        await u.downloadAndInstall((e) => {
          if (e.event === 'Started') total = e.data.contentLength ?? null;
          else if (e.event === 'Progress') received += e.data.chunkLength;
          onProgress(received, total);
        });
      },
    };
  },
  relaunch: () => relaunch(),
};

let impl: UpdaterImpl = real;
export function setUpdaterImpl(m: UpdaterImpl) { impl = m; }

export const updater = {
  check: () => impl.check(),
  relaunch: () => impl.relaunch(),
};

/** Arabic message for an updater failure (no connection, download failed, bad signature). */
export function updaterErrorAr(e: unknown): string {
  const text = String((e as { message?: string })?.message ?? e).toLowerCase();
  if (text.includes('signature')) return 'فشل التحقق من توقيع التحديث، فلم يُثبَّت. البرنامج كما هو';
  if (/network|connect|dns|timed? ?out|offline|request|resolve/.test(text)) return 'تعذّر الاتصال بخادم التحديثات. تحقق من الإنترنت ثم أعد المحاولة';
  return 'فشل تنزيل التحديث. أعد المحاولة لاحقاً';
}
