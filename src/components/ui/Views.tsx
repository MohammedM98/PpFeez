import { useState } from 'react';
import { Popover, Input, Button as HeroButton } from '@heroui/react';
import { Bookmark, Trash2 } from 'lucide-react';
import { useSavedViews, type SavedView } from '@/lib/uiPrefs';
import { Button } from './Button';
import { toast } from './Toast';

/**
 * SPEC 6.10 "طرق عرض محفوظة": the list's filters, sort and columns under a name ("غير المطابق هذا
 * الشهر"), back with one click.
 */
export function ViewsMenu({ list, capture, apply }: { list: string; capture: () => Omit<SavedView, 'name'>; apply: (v: SavedView) => void }) {
  const { views, save, remove } = useSavedViews(list);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button variant="secondary" size="icon" aria-label="طرق العرض"><Bookmark /></Button>
      <Popover.Content placement="bottom end" className="w-72">
        <Popover.Dialog aria-label="طرق العرض" className="flex flex-col p-0">
          <>
              {views.length > 0 ? (
                <ul className="max-h-64 overflow-auto p-1.5" aria-label="طرق العرض المحفوظة">
                  {views.map((v) => (
                    <li key={v.name} className="flex items-center gap-1">
                      <HeroButton variant="ghost" size="sm" className="min-w-0 flex-1 justify-start font-normal" onPress={() => { apply(v); close(); }}>{v.name}</HeroButton>
                      <HeroButton variant="ghost" size="sm" isIconOnly aria-label={`حذف ${v.name}`} onPress={() => remove(v.name)} className="text-fg-3 data-[hovered=true]:text-neg">
                        <Trash2 />
                      </HeroButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-3 text-[13px] leading-relaxed text-fg-3">لا طرق عرض محفوظة بعد. احفظ الفلاتر والترتيب والأعمدة الحالية باسم لتعود إليها بنقرة.</p>
              )}
              <form className="flex gap-2 border-t border-line p-2.5" onSubmit={(e) => {
                e.preventDefault();
                const n = name.trim();
                if (!n) return;
                save({ name: n, ...capture() });
                setName('');
                close();
                toast.ok(`حُفظ العرض «${n}»`);
              }}>
                <Input aria-label="اسم العرض" value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم العرض الحالي" className="h-8 min-w-0 flex-1" />
                <Button type="submit" size="sm" variant="primary" isDisabled={!name.trim()}>حفظ</Button>
              </form>
          </>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
