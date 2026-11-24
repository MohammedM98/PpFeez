import { useState } from 'react';
import { Button as RacButton, DialogTrigger, Dialog as RacDialog, Popover } from 'react-aria-components';
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
  const item = 'flex h-8 min-w-0 flex-1 cursor-default items-center rounded-[6px] px-2.5 text-sm outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus data-[hovered]:bg-raised';
  return (
    <DialogTrigger>
      <Button variant="secondary" size="icon" aria-label="طرق العرض" className="size-8"><Bookmark /></Button>
      <Popover placement="bottom end" className="w-72 rounded-card border border-line bg-surface shadow-(--shadow-float) outline-none">
        <RacDialog aria-label="طرق العرض" className="flex flex-col outline-none">
          {({ close }) => (
            <>
              {views.length > 0 ? (
                <ul className="max-h-64 overflow-auto p-1" aria-label="طرق العرض المحفوظة">
                  {views.map((v) => (
                    <li key={v.name} className="flex items-center gap-1">
                      <RacButton className={item} onPress={() => { apply(v); close(); }}>{v.name}</RacButton>
                      <RacButton aria-label={`حذف ${v.name}`} onPress={() => remove(v.name)}
                        className="grid size-7 shrink-0 place-items-center rounded text-fg-3 outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus data-[hovered]:bg-raised data-[hovered]:text-neg">
                        <Trash2 className="size-3.5" />
                      </RacButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-3 text-[13px] text-fg-3">لا طرق عرض محفوظة بعد. احفظ الفلاتر والترتيب والأعمدة الحالية باسم لتعود إليها بنقرة.</p>
              )}
              <form className="flex gap-2 border-t border-line p-2" onSubmit={(e) => {
                e.preventDefault();
                const n = name.trim();
                if (!n) return;
                save({ name: n, ...capture() });
                setName('');
                close();
                toast.ok(`حُفظ العرض «${n}»`);
              }}>
                <input aria-label="اسم العرض" value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم العرض الحالي"
                  className="h-8 min-w-0 flex-1 rounded-ctl border border-line bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-3 focus:border-focus" />
                <Button type="submit" size="sm" variant="primary" isDisabled={!name.trim()}>حفظ</Button>
              </form>
            </>
          )}
        </RacDialog>
      </Popover>
    </DialogTrigger>
  );
}
