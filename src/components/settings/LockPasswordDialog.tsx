import { useState } from 'react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/useAction';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Dialog } from '@/components/ui/Dialog';

export const LOCK_NOTE = 'لا يمكن استرجاع كلمة القفل إن نُسيت. القفل يمنع الاستخدام العابر فقط، والبيانات نفسها غير مشفّرة.';

export function LockPasswordFields({ next, setNext, confirm, setConfirm, error }: { next: string; setNext: (v: string) => void; confirm: string; setConfirm: (v: string) => void; error?: string }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <TextField label="كلمة القفل" type="password" ltr value={next} onChange={setNext} />
      <TextField label="تأكيدها" type="password" ltr value={confirm} onChange={setConfirm} errorMessage={error} />
    </div>
  );
}

/** mode: set (first time), change, or disable. */
export function LockPasswordDialog({ mode, onClose }: { mode: 'set' | 'change' | 'disable'; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<Record<string, string>>({});
  const { run, pending } = useAction();
  const submit = async () => {
    if (mode !== 'disable') {
      if (next.length < 4) return setErr({ confirm: 'أربعة أحرف على الأقل' });
      if (next !== confirm) return setErr({ confirm: 'الكلمتان غير متطابقتين' });
    }
    const r = await run(() => api.setLockPassword(mode === 'disable' ? null : next, mode === 'set' ? undefined : current),
      mode === 'disable' ? 'عُطّل القفل' : 'حُفظت كلمة القفل', { quiet: (e) => e.field === 'current' || e.code === 'wrong_password' });
    if (r.ok) onClose();
    else if (r.error.field === 'current' || r.error.code === 'wrong_password') setErr({ current: r.error.messageAr });
  };
  const title = mode === 'set' ? 'تفعيل القفل' : mode === 'change' ? 'تغيير كلمة القفل' : 'تعطيل القفل';
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md" title={title}
      footer={<><Button variant="secondary" onPress={onClose}>تراجع</Button><Button variant={mode === 'disable' ? 'danger' : 'primary'} onPress={submit} isPending={pending}>{title}</Button></>}>
      <div className="flex flex-col gap-4">
        {mode !== 'set' && <TextField label="كلمة القفل الحالية" type="password" ltr value={current} onChange={(v) => { setCurrent(v); setErr({}); }} errorMessage={err.current} autoFocus />}
        {mode !== 'disable' && <LockPasswordFields next={next} setNext={(v) => { setNext(v); setErr({}); }} confirm={confirm} setConfirm={(v) => { setConfirm(v); setErr({}); }} error={err.confirm} />}
        {mode !== 'disable' && <p className="text-[13px] text-fg-3">{LOCK_NOTE}</p>}
      </div>
    </Dialog>
  );
}
