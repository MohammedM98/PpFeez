import { Toast, ToastQueue, Button as HeroButton } from '@heroui/react';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';

export type ToastAction = { label: string; onPress: () => void };
type Tone = 'ok' | 'error' | 'warn';
type ToastData = { title: string; description?: string; tone: Tone; actions?: ToastAction[] };
export const toastQueue = new ToastQueue<ToastData>({ maxVisibleToasts: 4 });

export const toast = {
  ok: (title: string, description?: string) => toastQueue.add({ title, description, tone: 'ok' }, { timeout: 4000 }),
  error: (title: string, description?: string) => toastQueue.add({ title, description, tone: 'error' }, { timeout: 7000 }),
  /** a success with follow-up buttons (e.g. "فتح" / "تراجع"); stays longer so there is time to press them */
  action: (title: string, actions: ToastAction[], description?: string) => toastQueue.add({ title, description, tone: 'ok', actions }, { timeout: 9000 }),
  /** something saved but a follow-up did not happen yet (e.g. the Excel file is open); it says why and how to retry */
  warn: (title: string, description?: string, actions?: ToastAction[]) => toastQueue.add({ title, description, tone: 'warn', actions }, { timeout: 12000 }),
};

const variant = { ok: 'success', error: 'danger', warn: 'warning' } as const;
const icon = { ok: <CircleCheck />, error: <CircleAlert />, warn: <TriangleAlert /> };

/**
 * HeroUI toasts, bottom-left (SPEC §6): the side away from the sidebar. All of them stay readable at
 * once (`isExpanded`): a money app never hides "saved" behind a newer message.
 */
export function Toasts() {
  return (
    <Toast.Provider queue={toastQueue} placement="bottom end" isExpanded maxVisibleToasts={4} width={380} gap={8} aria-label="الإشعارات" className="toasts">
      {({ toast: t }) => (
        <Toast toast={t} variant={variant[t.content.tone]} data-tone={t.content.tone}>
          <Toast.Indicator variant={variant[t.content.tone]}>{icon[t.content.tone]}</Toast.Indicator>
          <Toast.Content>
            <Toast.Title>{t.content.title}</Toast.Title>
            {t.content.description && <Toast.Description>{t.content.description}</Toast.Description>}
            {t.content.actions && (
              <div className="mt-2 flex gap-2">
                {t.content.actions.map((a) => (
                  <HeroButton key={a.label} size="sm" variant="outline" className="h-7" onPress={() => { toastQueue.close(t.key); a.onPress(); }}>{a.label}</HeroButton>
                ))}
              </div>
            )}
          </Toast.Content>
          <Toast.CloseButton aria-label="إغلاق" />
        </Toast>
      )}
    </Toast.Provider>
  );
}
