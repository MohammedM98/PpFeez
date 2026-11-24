import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MenuTrigger, Menu, MenuItem, Popover, type Key } from 'react-aria-components';
import { FileSpreadsheet, FolderOpen, HardDriveDownload, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { api, native } from '@/lib/api';
import type { BackupFile, Mailbox, Settings as SettingsT, Theme } from '@/lib/contract';
import { amountTextToMinor2, bpsToPercentText, formatMinor, percentTextToBps } from '@/lib/money';
import { useTheme } from '@/lib/theme';
import { useAction } from '@/lib/useAction';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Field';
import { Segmented } from '@/components/ui/Segmented';
import { TextField } from '@/components/ui/TextField';
import { Dialog } from '@/components/ui/Dialog';
import { DateTime } from '@/components/ui/DateTime';
import { Trunc } from '@/components/ui/Trunc';
import { cx } from '@/components/ui/cx';
import { pullRangeLabel } from '@/lib/strings';
import { MailboxDialog } from '@/components/settings/MailboxForm';
import { LockPasswordDialog } from '@/components/settings/LockPasswordDialog';
import { useExcelUpdate } from '@/components/settings/useExcelUpdate';

const SECTIONS = [
  ['mail', 'البريد'], ['pulls', 'سجل السحب'], ['fees', 'العمولة والرسوم'], ['excel', 'ملف Excel'],
  ['backup', 'النسخ الاحتياطي'], ['security', 'الأمان'], ['appearance', 'المظهر'], ['about', 'حول'],
] as const;

function Section({ id, title, description, actions, children }: { id: string; title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-card border border-line bg-surface">
      <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-[16px] font-medium text-fg">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-fg-3">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm text-fg">{label}</div>
        {hint && <div className="text-[12.5px] text-fg-3">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

const sizeText = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

// ------------------------------------------------------------------ mail
function MailSection() {
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: api.mailboxList });
  const [editing, setEditing] = useState<Mailbox | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Mailbox | null>(null);
  const [pwFor, setPwFor] = useState<Mailbox | null>(null);
  const [pw, setPw] = useState('');
  const { run, pending } = useAction();

  const onMenu = async (m: Mailbox, k: Key) => {
    if (k === 'edit') setEditing(m);
    if (k === 'password') { setPw(''); setPwFor(m); }
    if (k === 'test') await run(() => api.mailboxTest({ id: m.id }), (r) => `نجح الاتصال بـ ${m.label} (${r.folderCount} مجلداً)`);
    if (k === 'toggle') await run(() => api.mailboxSetActive(m.id, !m.isActive), m.isActive ? `أُوقف ${m.label}` : `فُعّل ${m.label}`);
    if (k === 'delete') setDeleting(m);
  };

  return (
    <Section id="mail" title="البريد" description="حسابات Gmail التي تُسحب منها رسائل PayPal"
      actions={<Button size="sm" variant="secondary" onPress={() => setEditing('new')}><Plus />إضافة بريد</Button>}>
      <ul className="flex flex-col gap-2">
        {mailboxes.data?.map((m) => (
          <li key={m.id} className="flex items-center gap-4 rounded-ctl border border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm">
                <span className={m.isActive ? 'text-fg' : 'text-fg-3'}>{m.label}</span>
                {!m.isActive && <Badge tone="outline">موقوف</Badge>}
                {!m.hasPassword && <Badge tone="warn">بلا كلمة مرور</Badge>}
              </div>
              <Trunc className="text-[12.5px] text-fg-3">{m.email}</Trunc>
            </div>
            <div className="text-end text-[12.5px] text-fg-3">
              آخر سحب
              <div className="text-fg-2">{m.lastPulledAt ? <DateTime iso={m.lastPulledAt} /> : 'لم يُسحب'}</div>
            </div>
            <MenuTrigger>
              <Button variant="quiet" size="icon" aria-label={`إجراءات ${m.label}`}><MoreHorizontal /></Button>
              <Popover placement="bottom end" className="min-w-48 rounded-card border border-line bg-surface p-1 shadow-(--shadow-float) outline-none">
                <Menu className="outline-none" onAction={(k) => void onMenu(m, k)}>
                  {[['test', 'اختبار الاتصال'], ['edit', 'تعديل'], ['password', 'تغيير كلمة المرور'], ['toggle', m.isActive ? 'إيقاف' : 'تفعيل'], ['delete', 'حذف']].map(([id, label]) => (
                    <MenuItem key={id} id={id} className={cx('flex h-8 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focused]:bg-raised', id === 'delete' && 'text-neg')}>{label}</MenuItem>
                  ))}
                </Menu>
              </Popover>
            </MenuTrigger>
          </li>
        ))}
        {mailboxes.data?.length === 0 && <li className="py-6 text-center text-sm text-fg-3">لا بريد بعد. أضف Gmail لتسحب منه معاملات PayPal</li>}
      </ul>
      {editing && <MailboxDialog mailbox={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {pwFor && (
        <Dialog isOpen onOpenChange={(o) => !o && setPwFor(null)} title={`كلمة مرور التطبيق لـ ${pwFor.label}`} width="sm"
          footer={<><Button variant="secondary" onPress={() => setPwFor(null)}>تراجع</Button>
            <Button variant="primary" isPending={pending} isDisabled={!pw.trim()} onPress={async () => { const r = await run(() => api.mailboxSetPassword(pwFor.id, pw.replace(/\s/g, '')), 'حُفظت كلمة المرور'); if (r.ok) setPwFor(null); }}>حفظ</Button></>}>
          <TextField label="كلمة مرور التطبيق" type="password" ltr value={pw} onChange={setPw} autoFocus placeholder="xxxx xxxx xxxx xxxx" />
        </Dialog>
      )}
      {deleting && (
        <Dialog isOpen onOpenChange={(o) => !o && setDeleting(null)} title={`حذف ${deleting.label}`} width="sm"
          footer={<><Button variant="secondary" onPress={() => setDeleting(null)}>تراجع</Button>
            <Button variant="danger" isPending={pending} onPress={async () => { await run(() => api.mailboxDelete(deleting.id), 'حُذف البريد'); setDeleting(null); }}>حذف</Button></>}>
          <p className="text-sm text-fg-2">يُحذف البريد فقط إن لم تكن له معاملات. إن كانت له معاملات أوقفه بدلاً من حذفه.</p>
        </Dialog>
      )}
    </Section>
  );
}

function PullsSection() {
  const runs = useQuery({ queryKey: ['pull_runs', 20], queryFn: () => api.pullRunsList(20) });
  const tone = { done: 'pos', failed: 'neg', cancelled: 'outline', running: 'accent' } as const;
  const label = { done: 'تم', failed: 'فشل', cancelled: 'أُلغي', running: 'يعمل' };
  return (
    <Section id="pulls" title="سجل السحب" description="آخر 20 عملية سحب">
      <table className="w-full text-sm">
        <thead><tr className="text-[12.5px] text-fg-3 [&>th]:pb-2 [&>th]:font-medium">
          <th className="text-start">البدء</th><th className="text-start">البريد</th><th className="text-start">النطاق</th><th className="text-start">النتيجة</th>
          <th className="text-end">مقروءة</th><th className="text-end">جديدة</th><th className="text-end">مكررة</th><th className="text-end">متجاهلة</th><th className="text-end">فاشلة</th>
        </tr></thead>
        <tbody className="[&>tr>td]:border-t [&>tr>td]:border-line [&>tr>td]:py-2.5">
          {runs.data?.map((r) => (
            <tr key={r.id}>
              <td><DateTime iso={r.startedAt} className="text-fg-2" /></td>
              <td>{r.mailboxLabel}</td>
              <td className="text-fg-2">{pullRangeLabel(r.range)}</td>
              <td><Badge tone={tone[r.status]}>{label[r.status]}</Badge>{r.error && <span className="ms-2 text-[12.5px] text-neg">{r.error}</span>}</td>
              {[r.fetchedCount, r.newTransactionsCount, r.duplicateCount, r.ignoredCount, r.failedCount].map((n, i) => <td key={i} className="num text-end text-fg-2">{n}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

// ------------------------------------------------------------------ fees
function FeesSection({ s }: { s: SettingsT }) {
  const [commission, setCommission] = useState(bpsToPercentText(s.defaultCommissionBps));
  const [estPct, setEstPct] = useState(bpsToPercentText(s.feeEstimateBps));
  const [estFixed, setEstFixed] = useState(formatMinor(s.feeEstimateFixedMinor, 'USD'));
  const { run, pending } = useAction();
  const cBps = percentTextToBps(commission), eBps = percentTextToBps(estPct), eFixed = amountTextToMinor2(estFixed.replace(/,/g, ''));
  const dirty = cBps !== s.defaultCommissionBps || eBps !== s.feeEstimateBps || eFixed !== s.feeEstimateFixedMinor;
  return (
    <Section id="fees" title="العمولة والرسوم"
      actions={dirty && <Button size="sm" variant="primary" isPending={pending} isDisabled={cBps === null || eBps === null || eFixed === null}
        onPress={() => void run(() => api.updateSettings({ defaultCommissionBps: cBps!, feeEstimateBps: eBps!, feeEstimateFixedMinor: eFixed! }), 'حُفظت الإعدادات')}>حفظ</Button>}>
      <Row label="العمولة الافتراضية للعملاء الجدد" hint="العملاء الحاليون يحتفظون بعمولتهم">
        <TextField aria-label="العمولة الافتراضية" ltr suffix="%" value={commission} onChange={setCommission} className="w-[120px]" errorMessage={cBps === null ? 'غير صالحة' : undefined} />
      </Row>
      <Row label="تقدير رسوم PayPal" hint="يُقترح في نافذة الرسوم بلون مختلف، ولا يُحفظ إلا بتأكيدك">
        <Switch isSelected={s.feeEstimateEnabled} onChange={(v) => void run(() => api.updateSettings({ feeEstimateEnabled: v }), v ? 'فُعّل التقدير' : 'أُوقف التقدير')} aria-label="تقدير الرسوم" />
      </Row>
      {s.feeEstimateEnabled && (
        <Row label="معادلة التقدير" hint="نسبة من الأصلي + مبلغ ثابت بعملة المعاملة">
          <TextField aria-label="نسبة التقدير" ltr suffix="%" value={estPct} onChange={setEstPct} className="w-[110px]" />
          <span className="text-fg-3">+</span>
          <TextField aria-label="المبلغ الثابت" ltr value={estFixed} onChange={setEstFixed} className="w-[100px]" />
        </Row>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ excel
function ExcelSection({ s }: { s: SettingsT }) {
  const { run } = useAction();
  const excel = useExcelUpdate();
  const choose = async () => {
    const path = await native.saveXlsx('PpFeez.xlsx');
    if (path) await run(() => api.excelSetPath(path), 'حُفظ مسار الملف');
  };
  return (
    <Section id="excel" title="ملف Excel" description="ملف واحد يُعاد كتابته بأحدث البيانات: الملخص، المعاملات، العملاء، الدفتر. للقراءة فقط، لا يُستورد منه شيء"
      actions={s.excelExportPath && <>
        <Button size="sm" variant="secondary" onPress={() => void run(() => api.openPath(s.excelExportPath!))}><FileSpreadsheet />فتح الملف</Button>
        <Button size="sm" variant="primary" isPending={excel.pending} onPress={() => void excel.update()}><RefreshCw />تحديث ملف Excel</Button>
      </>}>
      <Row label="مسار الملف" hint={s.excelLastExportedAt ? <>آخر تحديث <DateTime iso={s.excelLastExportedAt} /></> : 'لم يُصدَّر بعد'}>
        {s.excelExportPath ? <Trunc className="max-w-[360px] text-[13px] text-fg-2">{s.excelExportPath}</Trunc> : <span className="text-[13px] text-fg-3">لم يُختر</span>}
        <Button size="sm" variant="secondary" onPress={choose}>{s.excelExportPath ? 'تغيير' : 'اختيار ملف'}</Button>
      </Row>
      <Row label="تحديث الملف عند إغلاق البرنامج" hint="مع النسخة الاحتياطية، وفشله لا يمنع الإغلاق">
        <Switch isSelected={s.excelUpdateOnClose} isDisabled={!s.excelExportPath} onChange={(v) => void run(() => api.updateSettings({ excelUpdateOnClose: v }), 'حُفظ')} aria-label="تحديث عند الإغلاق" />
      </Row>
    </Section>
  );
}

// ------------------------------------------------------------------ backup
function BackupSection({ s }: { s: SettingsT }) {
  const backups = useQuery({ queryKey: ['backups'], queryFn: api.backupList });
  const [keep, setKeep] = useState(String(s.backupKeep));
  const [restoring, setRestoring] = useState<BackupFile | { path: string; createdAt: null } | null>(null);
  const { run, pending } = useAction();
  useEffect(() => setKeep(String(s.backupKeep)), [s.backupKeep]);
  const pickFolder = async () => { const p = await native.pickFolder(); if (p) await run(() => api.updateSettings({ backupDir: p }), 'حُفظ مجلد النسخ'); };
  const pickFile = async () => { const p = await native.pickBackupFile(); if (p) setRestoring({ path: p, createdAt: null }); };
  return (
    <Section id="backup" title="النسخ الاحتياطي"
      actions={<>
        <Button size="sm" variant="secondary" onPress={pickFile}>استعادة من ملف</Button>
        <Button size="sm" variant="primary" isPending={pending} onPress={() => void run(() => api.backupNow(), 'أُخذت نسخة احتياطية')}><HardDriveDownload />نسخة الآن</Button>
      </>}>
      <Row label="المجلد">
        {s.backupDir ? <Trunc className="max-w-[360px] text-[13px] text-fg-2">{s.backupDir}</Trunc> : <span className="text-[13px] text-warn">لم يُختر، لن تُؤخذ نسخ</span>}
        <Button size="sm" variant="secondary" onPress={pickFolder}><FolderOpen />{s.backupDir ? 'تغيير' : 'اختيار'}</Button>
      </Row>
      <Row label="نسخة عند إغلاق البرنامج">
        <Switch isSelected={s.backupOnClose} onChange={(v) => void run(() => api.updateSettings({ backupOnClose: v }), 'حُفظ')} aria-label="نسخة عند الإغلاق" />
      </Row>
      <Row label="عدد النسخ المحفوظة" hint="تُحذف الأقدم تلقائياً">
        <TextField aria-label="عدد النسخ" ltr value={keep} onChange={setKeep} className="w-[90px]" onBlur={() => { const n = Number(keep); if (Number.isInteger(n) && n > 0 && n !== s.backupKeep) void run(() => api.updateSettings({ backupKeep: n }), 'حُفظ'); }} />
      </Row>
      <div className="mt-4">
        <div className="mb-2 text-[13px] text-fg-3">آخر النسخ</div>
        <ul className="divide-y divide-line rounded-ctl border border-line">
          {backups.data?.slice(0, 6).map((b) => (
            <li key={b.path} className="flex items-center gap-4 px-4 py-2 text-sm">
              <DateTime iso={b.createdAt} className="text-fg-2" />
              <Trunc className="min-w-0 flex-1 text-[12.5px] text-fg-3">{b.path}</Trunc>
              <bdi dir="ltr" className="num text-[12.5px] text-fg-3">{sizeText(b.sizeBytes)}</bdi>
              <Button size="sm" variant="quiet" onPress={() => setRestoring(b)}>استعادة</Button>
            </li>
          ))}
        </ul>
      </div>
      {restoring && (
        <Dialog isOpen onOpenChange={(o) => !o && setRestoring(null)} title="استعادة نسخة احتياطية" width="md"
          footer={<><Button variant="secondary" onPress={() => setRestoring(null)}>تراجع</Button>
            <Button variant="danger" isPending={pending} onPress={async () => { const r = await run(() => api.backupRestore(restoring.path), 'تمت الاستعادة، يُعاد تشغيل البرنامج'); if (r.ok) setRestoring(null); }}>استعادة وإعادة التشغيل</Button></>}>
          <div className="flex flex-col gap-3 text-sm text-fg-2">
            <div className="rounded-card bg-raised/60 px-4 py-3">
              <Trunc className="text-fg">{restoring.path}</Trunc>
              {restoring.createdAt && <div className="text-[12.5px] text-fg-3">أُخذت <DateTime iso={restoring.createdAt} /></div>}
            </div>
            <p>تحل هذه النسخة محل كل البيانات الحالية: المعاملات والأرصدة والقيود. تُؤخذ نسخة من الحالة الحالية أولاً، ثم يُعاد تشغيل البرنامج.</p>
          </div>
        </Dialog>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ security / appearance / about
function SecuritySection({ s }: { s: SettingsT }) {
  const status = useQuery({ queryKey: ['app_status'], queryFn: api.appStatus });
  const [dialog, setDialog] = useState<'set' | 'change' | 'disable' | null>(null);
  const { run } = useAction();
  const enabled = status.data?.lockEnabled;
  return (
    <Section id="security" title="الأمان" description="القفل يمنع الاستخدام العابر للبرنامج على هذا الجهاز">
      <Row label="قفل البرنامج بكلمة مرور" hint={enabled ? 'مفعّل' : 'معطّل'}>
        {enabled ? <>
          <Button size="sm" variant="quiet" onPress={() => setDialog('disable')}>تعطيل</Button>
          <Button size="sm" variant="secondary" onPress={() => setDialog('change')}>تغيير الكلمة</Button>
        </> : <Button size="sm" variant="secondary" onPress={() => setDialog('set')}>تفعيل القفل</Button>}
      </Row>
      <Row label="قفل تلقائي بعد خمول" hint={enabled ? undefined : 'يحتاج تفعيل القفل'}>
        <Select label="مدة الخمول" value={String(s.autoLockMinutes ?? 'off')} className="w-[150px]"
          onChange={(k) => void run(() => api.updateSettings({ autoLockMinutes: k === 'off' ? null : Number(k) }), 'حُفظ')}
          options={[{ id: 'off', label: 'بلا قفل تلقائي' }, ...[5, 10, 15, 30, 60].map((m) => ({ id: String(m), label: `${m} دقيقة` }))]} />
      </Row>
      {dialog && <LockPasswordDialog mode={dialog} onClose={() => setDialog(null)} />}
    </Section>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <Section id="appearance" title="المظهر">
      <Row label="المظهر">
        <Segmented<Theme> label="المظهر" value={theme} onChange={setTheme} className="w-[300px]"
          options={[{ id: 'dark', label: 'داكن' }, { id: 'light', label: 'فاتح' }, { id: 'system', label: 'حسب النظام' }]} />
      </Row>
    </Section>
  );
}

function AboutSection() {
  const status = useQuery({ queryKey: ['app_status'], queryFn: api.appStatus });
  const { run } = useAction();
  return (
    <Section id="about" title="حول">
      <Row label="الإصدار"><bdi dir="ltr" className="num text-fg-2">{status.data?.version}</bdi></Row>
      <Row label="مجلد البيانات">
        <Trunc className="max-w-[360px] text-[13px] text-fg-2">{status.data?.dataDir}</Trunc>
        <Button size="sm" variant="secondary" onPress={() => void run(() => api.openDataDir())}><FolderOpen />فتح المجلد</Button>
      </Row>
    </Section>
  );
}

export function SettingsPage() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const [active, setActive] = useState('mail');
  useEffect(() => {
    const root = document.querySelector('main');
    const obs = new IntersectionObserver((es) => { const v = es.find((e) => e.isIntersecting); if (v) setActive(v.target.id); }, { root, rootMargin: '0px 0px -70% 0px' });
    SECTIONS.forEach(([id]) => { const el = document.getElementById(id); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, [settings.data !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = settings.data;
  return (
    <div className="mx-auto flex min-h-full max-w-[1200px] flex-col px-6 pb-16 pt-6">
      <PageHeader title="الإعدادات" />
      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-8">
        <nav aria-label="أقسام الإعدادات" className="sticky top-6 flex flex-col gap-0.5">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); setActive(id); }}
              className={cx('flex h-8 items-center rounded-ctl px-3 text-sm outline-none transition-colors focus-visible:outline-2 focus-visible:outline-focus', active === id ? 'bg-raised text-fg' : 'text-fg-3 hover:text-fg-2')}>
              {label}
            </a>
          ))}
        </nav>
        {s && (
          <div className="flex flex-col gap-5">
            <MailSection />
            <PullsSection />
            <FeesSection key={`${s.defaultCommissionBps}-${s.feeEstimateBps}-${s.feeEstimateFixedMinor}`} s={s} />
            <ExcelSection s={s} />
            <BackupSection s={s} />
            <SecuritySection s={s} />
            <AppearanceSection />
            <AboutSection />
          </div>
        )}
      </div>
    </div>
  );
}
