import { UNSTABLE_Toast as Toast, UNSTABLE_ToastContent as ToastContent, UNSTABLE_ToastQueue as ToastQueue, UNSTABLE_ToastRegion as ToastRegion, Button as RacButton, Text } from 'react-aria-components';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { cx } from './cx';

type ToastData = { title: string; description?: string; tone: 'ok' | 'error' };
export const toastQueue = new ToastQueue<ToastData>({ maxVisibleToasts: 4 });

export const toast = {
  ok: (title: string, description?: string) => toastQueue.add({ title, description, tone: 'ok' }, { timeout: 4000 }),
  error: (title: string, description?: string) => toastQueue.add({ title, description, tone: 'error' }, { timeout: 7000 }),
};

/** Toasts sit bottom-left (SPEC §6), i.e. the side away from the sidebar. */
export function Toasts() {
  return (
    <ToastRegion queue={toastQueue} className="fixed bottom-5 left-5 z-[60] flex flex-col-reverse gap-2 outline-none">
      {({ toast: t }) => (
        <Toast toast={t} className="flex w-[360px] items-start gap-3 rounded-card border border-line bg-surface p-3.5 shadow-(--shadow-float) outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus">
          <span className={cx('mt-0.5 [&_svg]:size-[18px]', t.content.tone === 'ok' ? 'text-pos' : 'text-neg')}>
            {t.content.tone === 'ok' ? <CircleCheck /> : <CircleAlert />}
          </span>
          <ToastContent className="min-w-0 flex-1">
            <Text slot="title" className="block text-sm font-medium text-fg">{t.content.title}</Text>
            {t.content.description && <Text slot="description" className="block text-[13px] text-fg-2">{t.content.description}</Text>}
          </ToastContent>
          <RacButton slot="close" aria-label="إغلاق" className="grid size-6 place-items-center rounded-[6px] text-fg-3 outline-none hover:bg-raised data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"><X className="size-3.5" /></RacButton>
        </Toast>
      )}
    </ToastRegion>
  );
}
