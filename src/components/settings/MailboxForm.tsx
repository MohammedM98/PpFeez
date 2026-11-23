import { useState } from 'react';
import { Disclosure, DisclosurePanel, Button as RacButton, Heading } from 'react-aria-components';
import { ChevronDown, ExternalLink, PlugZap } from 'lucide-react';
import { api, native, toAppError } from '@/lib/api';
import type { Mailbox, MailboxInput } from '@/lib/contract';
import { useAction } from '@/lib/useAction';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Dialog } from '@/components/ui/Dialog';
import { cx } from '@/components/ui/cx';

export const APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords';

/** How to create a Gmail app password (SPEC 6.0 step 2). */
export function AppPasswordHelp() {
  return (
    <div className="rounded-card bg-raised/60 p-4 text-[13px] leading-relaxed text-fg-2">
      <ol className="list-decimal space-y-1 ps-5">
        <li>فعّل التحقق بخطوتين في حساب Google إن لم يكن مفعّلاً</li>
        <li>افتح صفحة «كلمات مرور التطبيقات» وأنشئ كلمة باسم PpFeez</li>
        <li>انسخ الكلمة المكوّنة من 16 حرفاً والصقها هنا</li>
      </ol>
      <Button size="sm" variant="quiet" className="mt-2 -ms-3 text-accent-ink" onPress={() => void native.openUrl(APP_PASSWORDS_URL)}>
        <ExternalLink />فتح صفحة كلمات مرور التطبيقات
      </Button>
      <p className="mt-1 text-[12.5px] text-fg-3">تُحفظ الكلمة في خزنة ويندوز، ويمكنك إلغاؤها من حساب Google في أي وقت</p>
    </div>
  );
}

export function useMailboxForm(initial?: Mailbox | null) {
  const [f, setF] = useState({
    label: initial?.label ?? 'Gmail الرئيسي', email: initial?.email ?? '', password: '',
    host: initial?.host ?? 'imap.gmail.com', port: String(initial?.port ?? 993), folder: initial?.folder ?? 'INBOX',
  });
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const input = (): MailboxInput => ({
    label: f.label.trim(), email: f.email.trim(), host: f.host.trim() || undefined, port: Number(f.port) || undefined,
    folder: f.folder.trim() || undefined, password: f.password.replace(/\s/g, '') || undefined,
  });
  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      const r = initial && !f.password ? await api.mailboxTest({ id: initial.id }) : await api.mailboxTest({ input: input() });
      setTest({ ok: true, msg: `نجح الاتصال، وُجد ${r.folderCount} مجلداً` });
    } catch (e) {
      setTest({ ok: false, msg: toAppError(e).messageAr });
    } finally { setTesting(false); }
  };
  return { f, setF, input, test, testing, runTest };
}

export function MailboxFields({ form, editing }: { form: ReturnType<typeof useMailboxForm>; editing?: boolean }) {
  const { f, setF, test, testing, runTest } = form;
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <TextField label="التسمية" value={f.label} onChange={set('label')} />
        <TextField label="عنوان Gmail" ltr value={f.email} onChange={set('email')} placeholder="name@gmail.com" isRequired />
      </div>
      <TextField label={editing ? 'كلمة مرور التطبيق الجديدة' : 'كلمة مرور التطبيق'} ltr type="password" value={f.password} onChange={set('password')}
        placeholder="xxxx xxxx xxxx xxxx" description={editing ? 'اتركها فارغة للإبقاء على الحالية' : undefined} />
      <AppPasswordHelp />
      <Disclosure className="group">
        <Heading><RacButton slot="trigger" className="flex items-center gap-1 text-[13px] text-fg-3 outline-none hover:text-fg-2"><ChevronDown className="size-4 transition-transform group-data-[expanded]:rotate-180" />إعدادات متقدمة</RacButton></Heading>
        <DisclosurePanel>
          <div className="grid grid-cols-[1fr_100px_1fr] gap-3 pt-3">
            <TextField label="الخادم" ltr value={f.host} onChange={set('host')} />
            <TextField label="المنفذ" ltr value={f.port} onChange={set('port')} />
            <TextField label="المجلد" ltr value={f.folder} onChange={set('folder')} />
          </div>
        </DisclosurePanel>
      </Disclosure>
      <div className="flex items-center gap-3">
        <Button variant="secondary" onPress={runTest} isPending={testing} isDisabled={!f.email.includes('@')}><PlugZap />اختبار الاتصال</Button>
        {test && <span className={cx('text-[13px]', test.ok ? 'text-pos' : 'text-neg')}>{test.msg}</span>}
      </div>
    </div>
  );
}

export function MailboxDialog({ mailbox, onClose }: { mailbox: Mailbox | null; onClose: () => void }) {
  const form = useMailboxForm(mailbox);
  const { run, pending } = useAction();
  const save = async () => {
    const r = mailbox ? await run(() => api.mailboxUpdate(mailbox.id, form.input()), 'حُفظ البريد') : await run(() => api.mailboxCreate(form.input()), 'أُضيف البريد');
    if (r.ok) onClose();
  };
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="lg" title={mailbox ? `تعديل ${mailbox.label}` : 'إضافة بريد Gmail'}
      footer={<><Button variant="secondary" onPress={onClose}>تراجع</Button><Button variant="primary" onPress={save} isPending={pending} isDisabled={!form.f.email.includes('@')}>حفظ</Button></>}>
      <MailboxFields form={form} editing={!!mailbox} />
    </Dialog>
  );
}
