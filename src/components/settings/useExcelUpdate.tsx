import { useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import type { ExcelExportResult } from '@/lib/contract';
import { useAction } from '@/lib/useAction';
import { toast } from '@/components/ui/Toast';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';

/** "أُضيفت 3 معاملات جديدة" / "حُدّث صفّان": Arabic counted nouns for the append result. */
export function addedLabel(n: number): string {
  if (n === 0) return 'لا معاملات جديدة';
  if (n === 1) return 'أُضيفت معاملة جديدة';
  if (n === 2) return 'أُضيفت معاملتان جديدتان';
  return n <= 10 ? `أُضيفت ${n} معاملات جديدة` : `أُضيفت ${n} معاملة جديدة`;
}
export function updatedLabel(n: number): string {
  if (n === 0) return 'ولم يتغيّر أي صف';
  if (n === 1) return 'وحُدّث صف واحد';
  if (n === 2) return 'وحُدّث صفّان';
  return n <= 10 ? `وحُدّثت ${n} صفوف` : `وحُدّث ${n} صفاً`;
}

function resultToast(x: ExcelExportResult, rewrote: boolean) {
  if (x.created) toast.ok('أُنشئ ملف Excel', x.path);
  else if (rewrote) toast.ok('أُعيدت كتابة ملف Excel', `النسخة السابقة محفوظة بجانبه باسم .previous.xlsx`);
  else toast.ok('حُدّث ملف Excel', `${addedLabel(x.added)}، ${updatedLabel(x.updated)}`);
}

/**
 * "تحديث ملف Excel" (SPEC 6.8, 6.8.1). Append mode keeps the owner's edits; when the file's layout no
 * longer matches (`excel_layout`) the owner can rewrite it this one time, after an explicit confirm.
 * Render `dialog` next to the button.
 */
export function useExcelUpdate(): { update: () => Promise<void>; pending: boolean; dialog: ReactNode } {
  const { run, pending } = useAction();
  const [layout, setLayout] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const update = async () => {
    const r = await run(() => api.excelUpdate(), undefined, { quiet: (e) => e.code === 'file_locked' || e.code === 'excel_layout' });
    if (r.ok) {
      const s = await api.getSettings().catch(() => null);
      resultToast(r.value, s?.excelMode === 'rewrite');
    } else if (r.error.code === 'file_locked') toast.error('الملف مفتوح في Excel', 'أغلق الملف في Excel ثم أعد المحاولة. النسخة السابقة من الملف سليمة.');
    else if (r.error.code === 'excel_layout') setLayout(r.error.messageAr);
  };

  // one rewrite, then back to the mode the owner chose
  const rewriteOnce = async () => {
    const before = (await api.getSettings()).excelMode;
    const r = await run(async () => {
      await api.updateSettings({ excelMode: 'rewrite' });
      try { return await api.excelUpdate(); } finally { await api.updateSettings({ excelMode: before }); }
    }, undefined, { quiet: (e) => e.code === 'file_locked' });
    if (r.ok) { setConfirming(false); setLayout(null); resultToast(r.value, true); }
    else if (r.error.code === 'file_locked') toast.error('الملف مفتوح في Excel', 'أغلق الملف في Excel ثم أعد المحاولة. النسخة السابقة من الملف سليمة.');
  };

  const dialog = layout && (
    <Dialog isOpen onOpenChange={(o) => { if (!o) { setLayout(null); setConfirming(false); } }} width="md"
      title={<span className="flex items-center gap-2"><TriangleAlert className="size-5 text-warn" strokeWidth={1.7} />{confirming ? 'إعادة كتابة كاملة لهذه المرة' : 'لم يُحدَّث ملف Excel'}</span>}
      footer={confirming ? <>
        <Button variant="secondary" onPress={() => setConfirming(false)}>تراجع</Button>
        <Button variant="danger" isPending={pending} onPress={() => void rewriteOnce()}>إعادة الكتابة</Button>
      </> : <>
        <Button variant="secondary" onPress={() => setLayout(null)}>سأصلح العنوان</Button>
        <Button variant="primary" onPress={() => setConfirming(true)}>إعادة كتابة كاملة لهذه المرة</Button>
      </>}>
      {confirming ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-fg">سيُعاد إنشاء الملف وتضيع تعديلاتك فيه: الأعمدة الإضافية والألوان والتعليقات والأوراق التي أضفتها.</p>
          <p className="text-fg-2">نسخة من الملف الحالي تُحفظ بجانبه باسم <bdi dir="ltr" className="num">.previous.xlsx</bdi>، ويبقى وضع «إضافة الجديد» للتحديثات القادمة.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="rounded-card bg-warn-soft px-4 py-3 text-fg">{layout}</p>
          <p className="text-fg-2">لم يُكتب شيء، والملف كما هو. أعد عنوان العمود في ورقة المعاملات ثم حدّث، أو أعد كتابة الملف كاملاً هذه المرة.</p>
        </div>
      )}
    </Dialog>
  );

  return { update, pending, dialog };
}
