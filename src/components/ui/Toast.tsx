import { UNSTABLE_Toast as Toast, UNSTABLE_ToastContent as ToastContent, UNSTABLE_ToastQueue as ToastQueue, UNSTABLE_ToastRegion as ToastRegion, Button as RacButton, Text } from 'react-aria-components';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { cx } from './cx';

export type ToastAction = { label: string; onPress: () => void };
type ToastData = { title: string; description?: string; tone: 'ok' | 'error'; actions?: ToastAction[] };
export const toastQueue = new ToastQueue<ToastData>({ maxVisibleToasts: 4 });

export const toast = {
  ok: (title: string, description?: string) => toastQueue.add({ title, description, tone: 'ok' }, { timeout: 4000 }),
  error: (title: string, description?: string) => toastQueue.add({ title, description, tone: 'error' }, { timeout: 7000 }),
  /** a success with follow-up buttons (e.g. "فتح" / "تراجع"); stays longer so there is time to press them */
  action: (title: string, actions: ToastAction[], description?: string) => toastQueue.add({ title, description, tone: 'ok', actions }, { timeout: 9000 }),
};

/** Toasts sit bottom-left (SPEC §6), i.e. the side away from the sidebar. */
export function Toasts() {
  return (
    <ToastRegion queue={toastQueue} className="toasts fixed bottom-5 left-5 z-[60] flex flex-col-reverse gap-2 outline-none transition-[left] duration-200">
      {({ toast: t }) => (
        <Toast toast={t} className="flex w-[360px] items-start gap-3 rounded-card border border-line bg-surface p-3.5 shadow-(--shadow-float) outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus">
          <span className={cx('mt-0.5 [&_svg]:size-[18px]', t.content.tone === 'ok' ? 'text-pos' : 'text-neg')}>
            {t.content.tone === 'ok' ? <CircleCheck /> : <CircleAlert />}
          </span>
          <ToastContent className="min-w-0 flex-1">
            <Text slot="title" className="block text-sm font-medium text-fg">{t.content.title}</Text>
            {t.content.description && <Text slot="description" className="block text-[13px] text-fg-2">{t.content.description}</Text>}
            {t.content.actions && (
              <div className="mt-2 flex gap-2">
                {t.content.actions.map((a) => (
                  <RacButton key={a.label} onPress={() => { toastQueue.close(t.key); a.onPress(); }}
                    className="h-7 rounded-[6px] border border-line px-2.5 text-[13px] font-medium text-fg outline-none hover:bg-raised data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus">
                    {a.label}
                  </RacButton>
                ))}
              </div>
            )}
          </ToastContent>
          <RacButton slot="close" aria-label="إغلاق" className="grid size-6 place-items-center rounded-[6px] text-fg-3 outline-none hover:bg-raised data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"><X className="size-3.5" /></RacButton>
        </Toast>
      )}
    </ToastRegion>
  );
}
