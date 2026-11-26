import { useEffect, useState } from 'react';
import { Form } from 'react-aria-components';
import { LockKeyhole } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api, toAppError } from '@/lib/api';
import type { AppStatus } from '@/lib/contract';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Logo } from '@/components/layout/Shell';

function useSecondsUntil(iso?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [iso]);
  return iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000)) : 0;
}

export function LockPage({ status }: { status: AppStatus }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [until, setUntil] = useState<string | undefined>(status.lockedUntil);
  const [pending, setPending] = useState(false);
  const wait = useSecondsUntil(until);

  const submit = async () => {
    if (!password || wait > 0) return;
    setPending(true); setError(null);
    try {
      const s = await api.unlock(password);
      qc.setQueryData(['app_status'], s);
      await qc.invalidateQueries();
    } catch (e) {
      const err = toAppError(e);
      setError(err.messageAr);
      setPassword('');
      if (err.code === 'too_many_attempts') setUntil((await api.appStatus()).lockedUntil ?? new Date(Date.now() + 30000).toISOString());
    } finally { setPending(false); }
  };

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-[380px]">
        <div className="mb-8 flex justify-center"><Logo /></div>
        <Form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="rounded-panel border border-line bg-surface p-6 shadow-(--shadow-float)">
          <div className="mb-5 flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-card bg-raised text-fg-2"><LockKeyhole className="size-5" strokeWidth={1.6} /></span>
            <div>
              <h1 className="text-[17px] font-medium text-fg">البرنامج مقفل</h1>
              <p className="text-[13px] text-fg-3">أدخل كلمة القفل للمتابعة</p>
            </div>
          </div>
          <TextField label="كلمة القفل" type="password" ltr autoFocus value={password} onChange={(v) => { setPassword(v); setError(null); }}
            isDisabled={wait > 0} errorMessage={wait > 0 ? `محاولات كثيرة، انتظر ${wait} ثانية` : error ?? undefined} />
          <Button type="submit" variant="primary" className="mt-4 w-full" isPending={pending} isDisabled={!password || wait > 0}>فتح</Button>
        </Form>
        <p className="mt-4 text-center text-[12.5px] text-fg-3">لا يمكن استرجاع كلمة القفل إن نُسيت</p>
      </div>
    </div>
  );
}
