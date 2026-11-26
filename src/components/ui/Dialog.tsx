import { Modal } from '@heroui/react';
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

/** HeroUI Modal with the app's fixed widths and the "discard changes?" guard. */
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
    <Modal.Backdrop isOpen={isOpen} onOpenChange={change} isDismissable={isDismissable}>
      <Modal.Container placement="center" scroll="inside" className="p-6">
        <Modal.Dialog className={cx('max-h-[calc(100vh-48px)] max-w-full gap-0 p-0', widths[width])}>
          <Modal.CloseTrigger aria-label="إغلاق" />
          <Modal.Header className="gap-1 px-6 pb-2 pe-14 pt-5">
            <Modal.Heading className="text-[18px] leading-snug">{title}</Modal.Heading>
            {description && <div className="text-sm text-fg-2">{description}</div>}
          </Modal.Header>
          <Modal.Body className="m-0 px-6 py-4 text-sm leading-[1.6] text-fg" onInput={() => setTyped(true)}>{children}</Modal.Body>
          {asking ? (
            <Modal.Footer role="alertdialog" aria-label="تجاهل التغييرات؟" className="m-0 border-t border-line bg-warn-soft px-6 py-4">
              <span className="me-auto text-sm text-fg">تجاهل التغييرات؟ <span className="text-fg-2">لم يُحفظ ما كتبته.</span></span>
              <Button variant="secondary" autoFocus onPress={() => setAsking(false)}>متابعة التعديل</Button>
              <Button variant="danger" onPress={() => { setAsking(false); onOpenChange(false); }}>تجاهل</Button>
            </Modal.Footer>
          ) : footer && <Modal.Footer className="m-0 border-t border-line px-6 py-4">{footer}</Modal.Footer>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
