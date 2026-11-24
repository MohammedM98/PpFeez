import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ProgressBar } from 'react-aria-components';
import { FolderOpen, TriangleAlert } from 'lucide-react';
import { api, native, toAppError } from '@/lib/api';
import { updater, updaterErrorAr, type AvailableUpdate } from '@/lib/updater';
import { usePull } from '@/lib/pull';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { Trunc } from '@/components/ui/Trunc';

type Ctx = { checking: boolean; checkNow: () => Promise<void> };
const UpdatesCtx = createContext<Ctx>({ checking: false, checkNow: async () => {} });
export const useUpdates = () => useContext(UpdatesCtx);

/**
 * SPEC 6.9: silent check once after unlock when autoCheckUpdates is on (no message on
 * "none" or network errors); a manual check from Settings reports every outcome.
 */
export function UpdatesProvider({ children }: { children: ReactNode }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const autoChecked = useRef(false);

  useEffect(() => {
    if (autoChecked.current || !settings.data?.autoCheckUpdates) return;
    autoChecked.current = true;
    updater.check().then((u) => u && setUpdate(u)).catch(() => { /* silent by design */ });
  }, [settings.data?.autoCheckUpdates]);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      const u = await updater.check();
      if (u) setUpdate(u);
      else toast.ok('لديك أحدث إصدار');
    } catch (e) {
      toast.error(updaterErrorAr(e));
    } finally { setChecking(false); }
  }, []);

  return (
    <UpdatesCtx.Provider value={{ checking, checkNow }}>
      {children}
      {update && <UpdateDialog update={update} onLater={() => setUpdate(null)} />}
    </UpdatesCtx.Provider>
  );
}

type Step = 'offer' | 'no-folder' | 'backing-up' | 'downloading' | 'restarting' | 'failed';

/** Notes come from CHANGELOG.md: drop the "## x.y.z" heading, keep bullet lines. */
function Notes({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return null;
  return (
    <ul className="max-h-48 list-disc space-y-1.5 overflow-auto rounded-card bg-raised/60 py-3 pe-4 ps-8 text-sm leading-relaxed text-fg-2">
      {lines.map((l, i) => <li key={i}>{l.replace(/^[-*]\s*/, '')}</li>)}
    </ul>
  );
}

function UpdateDialog({ update, onLater }: { update: AvailableUpdate; onLater: () => void }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { run: pullRun } = usePull();
  const [step, setStep] = useState<Step>('offer');
  const [progress, setProgress] = useState<{ received: number; total: number | null }>({ received: 0, total: null });
  const [error, setError] = useState<string | null>(null);
  const busy = step === 'backing-up' || step === 'downloading' || step === 'restarting';

  const install = async () => {
    setStep('downloading'); setError(null);
    try {
      await update.install((received, total) => setProgress({ received, total }));
      setStep('restarting');
      await updater.relaunch();
    } catch (e) {
      setError(updaterErrorAr(e));
      setStep('failed');
    }
  };

  const start = async (skipBackup = false) => {
    if (pullRun) return;
    if (!skipBackup) {
      if (!settings.data?.backupDir) { setStep('no-folder'); return; }
      setStep('backing-up');
      try {
        await api.backupNow();
      } catch (e) {
        setError(`تعذّر أخذ النسخة الاحتياطية: ${toAppError(e).messageAr}`);
        setStep('no-folder');
        return;
      }
    }
    await install();
  };

  const pickFolder = async () => {
    const dir = await native.pickFolder();
    if (!dir) return;
    await api.updateSettings({ backupDir: dir });
    await qc.invalidateQueries({ queryKey: ['settings'] });
    setError(null);
    setStep('offer');
  };

  const pct = progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : null;
  const mb = (n: number) => (n / 1_048_576).toFixed(1);

  return (
    <Dialog isOpen onOpenChange={(o) => !o && !busy && onLater()} isDismissable={!busy} width="md"
      title={<>يتوفر إصدار جديد <bdi dir="ltr" className="num">{update.version}</bdi></>}
      description={<>الإصدار المثبّت <bdi dir="ltr" className="num">{update.currentVersion}</bdi>. بياناتك لا تتأثر بالتحديث.</>}
      footer={
        step === 'no-folder' ? <>
          <Button variant="quiet" className="me-auto" onPress={() => void start(true)}>المتابعة بلا نسخة</Button>
          <Button variant="secondary" onPress={onLater}>لاحقاً</Button>
          <Button variant="primary" onPress={pickFolder}><FolderOpen />اختيار مجلد</Button>
        </> : step === 'failed' ? <>
          <Button variant="secondary" onPress={onLater}>إغلاق</Button>
          <Button variant="primary" onPress={() => void install()}>إعادة المحاولة</Button>
        </> : <>
          <Button variant="secondary" onPress={onLater} isDisabled={busy}>لاحقاً</Button>
          <Button variant="primary" onPress={() => void start()} isPending={busy} isDisabled={!!pullRun}>تحديث الآن</Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <Notes text={update.notes} />

        {pullRun && step === 'offer' && (
          <p className="flex items-center gap-2 rounded-card bg-warn-soft px-3 py-2 text-[13px] text-warn">
            <TriangleAlert className="size-4 shrink-0" />يجري سحب من {pullRun.mailboxLabel}. انتظر انتهاءه أو ألغه قبل التحديث
          </p>
        )}

        {step === 'no-folder' && (
          <div className="rounded-card bg-warn-soft px-4 py-3 text-sm text-fg-2">
            <p className="font-medium text-warn">{error ?? 'لم يُحدَّد مجلد للنسخ الاحتياطي'}</p>
            <p className="mt-1">يأخذ البرنامج نسخة من بياناتك قبل التحديث. اختر مجلداً، أو تابع بلا نسخة على مسؤوليتك.</p>
          </div>
        )}

        {step === 'backing-up' && <p className="text-sm text-fg-2">جارٍ أخذ نسخة احتياطية…</p>}

        {(step === 'downloading' || step === 'restarting') && (
          <div className="flex flex-col gap-2">
            <ProgressBar aria-label="تنزيل التحديث" value={pct ?? undefined} isIndeterminate={pct === null} className="flex flex-col gap-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
                <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${pct ?? 30}%` }} />
              </div>
            </ProgressBar>
            <div className="flex justify-between text-[13px] text-fg-3">
              <span>{step === 'restarting' ? 'اكتمل التثبيت، يُعاد تشغيل البرنامج…' : 'جارٍ التنزيل والتثبيت…'}</span>
              <bdi dir="ltr" className="num">{progress.total ? `${mb(progress.received)} / ${mb(progress.total)} MB` : progress.received ? `${mb(progress.received)} MB` : ''}</bdi>
            </div>
          </div>
        )}

        {step === 'failed' && error && <p className="rounded-card bg-neg-soft px-3 py-2 text-sm text-neg">{error}</p>}
      </div>
    </Dialog>
  );
}

export function UpdateSettingsRows({ version }: { version?: string }) {
  const { checking, checkNow } = useUpdates();
  return (
    <div className="flex items-center gap-2">
      {version && <Trunc className="text-[13px] text-fg-2"><bdi dir="ltr" className="num">{version}</bdi></Trunc>}
      <Button size="sm" variant="secondary" isPending={checking} onPress={() => void checkNow()}>التحقق من التحديثات</Button>
    </div>
  );
}
