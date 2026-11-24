import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { quietKey } from '@/lib/keys';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { SCREENS, openSearch } from '@/components/transactions/SearchDialog';

/*
 * SPEC 6.10 "اختصارات لوحة المفاتيح": the app-wide ones live here ("?" for the sheet, "/" for search,
 * G then a letter for a screen); the table ones live with their tables. No shortcut runs a money
 * action without its confirmation dialog.
 */

const GROUPS: { title: string; keys: [string, string][] }[] = [
  { title: 'في كل مكان', keys: [
    ['Ctrl K', 'لوحة الأوامر والبحث في كل المعاملات'],
    ['/', 'البحث'],
    ['?', 'هذه القائمة'],
    ['F11', 'ملء الشاشة للجدول'],
    ['Esc', 'إغلاق اللوحة أو النافذة'],
    ...SCREENS.map((s): [string, string] => [s.key, `الانتقال إلى ${s.label}`]),
  ] },
  { title: 'في جدول المعاملات', keys: [
    ['↑ ↓  أو  J K', 'التنقل بين الصفوف'],
    ['Space', 'تحديد الصف'],
    ['Shift ↓  /  Shift+نقر', 'تحديد متصل'],
    ['Ctrl A', 'تحديد الكل'],
    ['Enter', 'فتح التفاصيل'],
    ['A', 'تخصيص المحدد (أو الصف الحالي) لعميل'],
    ['F', 'تعديل رسوم الصف الحالي'],
    ['F2', 'تعديل الخلية (الرسوم، العمولة، الملاحظة)'],
  ] },
  { title: 'في كشف العميل', keys: [
    ['E', 'إضافة المحدد (أو الصف الحالي) إلى ملف العميل'],
    ['Shift E', 'إرسال كل غير المُصدَّر إلى ملف العميل'],
  ] },
];

export const openShortcuts = () => window.dispatchEvent(new Event('ppfeez:shortcuts'));

export function Shortcuts() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const chord = useRef<number>(0);
  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if (quietKey(e)) return;
      if (e.key === '?') { e.preventDefault(); setOpen(true); return; }
      if (e.key === '/') { e.preventDefault(); openSearch(); return; }
      // G then a letter, within a second
      if (e.code === 'KeyG' && !e.shiftKey) { chord.current = Date.now(); return; }
      if (Date.now() - chord.current < 1000) {
        const letter = e.code.replace('Key', '');
        const to = SCREENS.find((s) => s.key === `G ${letter}`);
        chord.current = 0;
        if (to) { e.preventDefault(); navigate(to.to); }
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('ppfeez:shortcuts', show);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('ppfeez:shortcuts', show); };
  }, [navigate]);
  if (!open) return null;
  return (
    <Dialog isOpen onOpenChange={setOpen} width="lg" title="اختصارات لوحة المفاتيح" description="لا اختصار ينفّذ عملية مالية دون نافذة تأكيد"
      footer={<Button variant="secondary" onPress={() => setOpen(false)}>إغلاق</Button>}>
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {GROUPS.map((g) => (
          <section key={g.title} aria-label={g.title} className={g.keys.length > 8 ? 'row-span-2' : ''}>
            <h3 className="mb-2 text-[13px] font-medium text-fg-2">{g.title}</h3>
            <dl className="flex flex-col gap-1.5 text-sm">
              {g.keys.map(([k, what]) => (
                <div key={k} className="flex items-center justify-between gap-4">
                  <dt className="text-fg">{what}</dt>
                  <dd><kbd dir="ltr" className="num whitespace-nowrap rounded border border-line bg-raised px-1.5 py-0.5 text-[12px] text-fg-2">{k}</kbd></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
