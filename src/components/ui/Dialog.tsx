import { Dialog as RacDialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { cx } from './cx';

type Props = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  isDismissable?: boolean;
  /**
   * Unsaved input: closing by Esc, X or a click outside asks "تجاهل التغييرات؟" first (SPEC 6.10).
   * Typing in the dialog sets it on its own; pass it for what was typed before (e.g. a confirm step).
   */
  dirty?: boolean;
};

const widths = { sm: 'w-[420px]', md: 'w-[520px]', lg: 'w-[680px]', xl: 'w-[900px]' };

export function Dialog({ isOpen, onOpenChange, title, description, children, footer, width = 'md', isDismissable = true, dirty = false }: Props) {
  const [asking, setAsking] = useState(false);
  // anything typed in the dialog counts as unsaved until it is saved or discarded
  const [typed, setTyped] = useState(false);
  useEffect(() => { if (!isOpen) { setTyped(false); setAsking(false); } }, [isOpen]);
  const unsaved = dirty || typed;
  const change = (open: boolean) => {
    if (!open && unsaved) setAsking(true);
    else onOpenChange(open);
  };
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={change}
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6 transition-opacity duration-200 ease-out data-[entering]:opacity-0 data-[exiting]:opacity-0"
    >
      <Modal className={cx('max-h-full max-w-full overflow-hidden rounded-panel border border-line bg-surface shadow-(--shadow-float) transition-[opacity,transform] duration-200 ease-out data-[entering]:translate-y-2 data-[entering]:opacity-0', widths[width])}>
        <RacDialog className="flex max-h-[calc(100vh-48px)] flex-col outline-none">
          {({ close }) => (
            <>
              <header className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
                <div>
                  <Heading slot="title" className="text-[18px] font-medium leading-snug text-fg">{title}</Heading>
                  {description && <div className="mt-1 text-sm text-fg-2">{description}</div>}
                </div>
                <Button variant="quiet" size="icon" aria-label="إغلاق" onPress={unsaved ? () => setAsking(true) : close} className="-me-2"><X /></Button>
              </header>
              <div className="min-h-0 flex-1 overflow-auto px-6 py-4" onInput={() => setTyped(true)}>{children}</div>
              {asking ? (
                <footer role="alertdialog" aria-label="تجاهل التغييرات؟" className="flex items-center justify-end gap-2 border-t border-line bg-warn-soft px-6 py-4">
                  <span className="me-auto text-sm text-fg">تجاهل التغييرات؟ <span className="text-fg-2">لم يُحفظ ما كتبته.</span></span>
                  <Button variant="secondary" autoFocus onPress={() => setAsking(false)}>متابعة التعديل</Button>
                  <Button variant="danger" onPress={() => { setAsking(false); onOpenChange(false); }}>تجاهل</Button>
                </footer>
              ) : footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">{footer}</footer>}
            </>
          )}
        </RacDialog>
      </Modal>
    </ModalOverlay>
  );
}
