import { api } from '@/lib/api';
import { useAction } from '@/lib/useAction';
import { toast } from '@/components/ui/Toast';

/** "تحديث ملف Excel" with a clear message when Windows has the file locked (SPEC 6.8). */
export function useExcelUpdate() {
  const { run, pending } = useAction();
  const update = async () => {
    const r = await run(() => api.excelUpdate(), (x) => `حُدّث ملف Excel: ${x.sheets} أوراق، ${x.rows} صفاً`, { quiet: (e) => e.code === 'file_locked' });
    if (!r.ok && r.error.code === 'file_locked') toast.error('الملف مفتوح في Excel', 'أغلق الملف في Excel ثم أعد المحاولة. النسخة السابقة من الملف سليمة.');
  };
  return { update, pending };
}
