import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, FolderOpen } from 'lucide-react';
import { api, native, toAppError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { Trunc } from '@/components/ui/Trunc';
import { cx } from '@/components/ui/cx';
import { Logo } from '@/components/layout/Shell';
import { LOCK_NOTE, LockPasswordFields } from '@/components/settings/LockPasswordDialog';
import { MailboxFields, useMailboxForm } from '@/components/settings/MailboxForm';

const STEPS = ['كلمة القفل', 'بريد Gmail', 'النسخ الاحتياطي'];

function Steps({ current, done }: { current: number; done: boolean[] }) {
  return (
    <ol className="mb-6 flex items-center gap-3" aria-label="خطوات الإعداد">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-3" aria-current={i === current ? 'step' : undefined}>
          <span className={cx('grid size-7 place-items-center rounded-full text-[13px] font-medium',
            done[i] ? 'bg-pos-soft text-pos' : i === current ? 'bg-accent text-accent-fg' : 'bg-raised text-fg-3')}>
            {done[i] ? <Check className="size-4" /> : <span className="num">{i + 1}</span>}
          </span>
          <span className={cx('text-sm', i === current ? 'text-fg' : 'text-fg-3')}>{label}</span>
          {i < STEPS.length - 1 && <span className="h-px w-10 bg-line-strong" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function StepCard({ title, description, children, footer }: { title: string; description: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="rounded-panel border border-line bg-surface shadow-(--shadow-float)">
      <div className="p-6">
        <h2 className="text-[19px] font-medium text-fg">{title}</h2>
        <p className="mb-5 mt-1 text-sm text-fg-2">{description}</p>
        {children}
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-line px-6 py-4">{footer}</footer>
    </div>
  );
}

/** First run: three skippable steps (SPEC 6.0). */
export function OnboardingPage() {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState([false, false, false]);
  const [pending, setPending] = useState(false);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwError, setPwError] = useState<string>();
  const [folder, setFolder] = useState<string | null>(null);
  const mailbox = useMailboxForm(null);

  const mark = (i: number) => setDone((d) => d.map((v, j) => (j === i ? true : v)));
  const guard = async (fn: () => Promise<unknown>) => {
    setPending(true);
    try { await fn(); return true; } catch (e) { toast.error(toAppError(e).messageAr); return false; } finally { setPending(false); }
  };
  const finish = async () => {
    if (await guard(() => api.updateSettings({ onboardingDone: true }))) {
      await qc.invalidateQueries();
      toast.ok('اكتمل الإعداد', 'يمكنك تغيير كل شيء لاحقاً من الإعدادات');
    }
  };

  const saveLock = async () => {
    if (next.length < 4) return setPwError('أربعة أحرف على الأقل');
    if (next !== confirm) return setPwError('الكلمتان غير متطابقتين');
    if (await guard(() => api.setLockPassword(next))) { mark(0); setStep(1); }
  };
  const saveMailbox = async () => {
    if (await guard(() => api.mailboxCreate(mailbox.input()))) { mark(1); setStep(2); }
  };
  const saveFolder = async () => {
    if (folder && (await guard(() => api.updateSettings({ backupDir: folder })))) mark(2);
    await finish();
  };

  return (
    <div className="grid min-h-screen place-items-center bg-sunken p-6">
      <div className="w-[640px]">
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <Button variant="quiet" size="sm" onPress={finish} isPending={pending}>تخطّي الإعداد</Button>
        </div>
        <Steps current={step} done={done} />

        {step === 0 && (
          <StepCard title="كلمة قفل البرنامج" description="تُطلب عند فتح البرنامج وبعد الخمول. يمكنك تخطّيها وتفعيلها لاحقاً."
            footer={<><Button variant="quiet" onPress={() => setStep(1)}>تخطٍّ</Button><Button variant="primary" onPress={saveLock} isPending={pending}>حفظ والمتابعة</Button></>}>
            <LockPasswordFields next={next} setNext={(v) => { setNext(v); setPwError(undefined); }} confirm={confirm} setConfirm={(v) => { setConfirm(v); setPwError(undefined); }} error={pwError} />
            <p className="mt-3 text-[13px] text-fg-3">{LOCK_NOTE}</p>
          </StepCard>
        )}

        {step === 1 && (
          <StepCard title="إضافة بريد Gmail" description="يقرأ البرنامج منه رسائل PayPal عند الضغط على «سحب المعاملات». يحتاج كلمة مرور تطبيق، لا كلمة حسابك."
            footer={<><Button variant="quiet" onPress={() => setStep(0)}>رجوع</Button>
              <span className="flex gap-2"><Button variant="quiet" onPress={() => setStep(2)}>تخطٍّ</Button>
                <Button variant="primary" onPress={saveMailbox} isPending={pending} isDisabled={!mailbox.f.email.includes('@')}>حفظ والمتابعة</Button></span></>}>
            <MailboxFields form={mailbox} />
          </StepCard>
        )}

        {step === 2 && (
          <StepCard title="مجلد النسخ الاحتياطي" description="تُحفظ فيه نسخة من البيانات عند إغلاق البرنامج. اختر مجلداً على قرص آخر أو مجلداً متزامناً مع السحابة إن أمكن."
            footer={<><Button variant="quiet" onPress={() => setStep(1)}>رجوع</Button>
              <span className="flex gap-2"><Button variant="quiet" onPress={finish} isPending={pending}>تخطٍّ وإنهاء</Button>
                <Button variant="primary" onPress={saveFolder} isPending={pending} isDisabled={!folder}>إنهاء</Button></span></>}>
            <div className="flex items-center gap-3 rounded-card border border-dashed border-line-strong p-4">
              {folder ? <Trunc className="min-w-0 flex-1 text-sm text-fg">{folder}</Trunc> : <span className="flex-1 text-sm text-fg-3">لم يُختر مجلد</span>}
              <Button variant="secondary" onPress={async () => setFolder(await native.pickFolder())}><FolderOpen />{folder ? 'تغيير' : 'اختيار مجلد'}</Button>
            </div>
          </StepCard>
        )}
      </div>
    </div>
  );
}
