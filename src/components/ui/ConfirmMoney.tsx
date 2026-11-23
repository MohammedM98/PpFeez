import type { ReactNode } from 'react';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { Amount } from './Amount';
import type { Currency, Minor } from '@/lib/contract';

/** Every money action asks first and shows the amount (contract §5). */
export function ConfirmMoney({ isOpen, onOpenChange, title, amount, currency, children, confirmLabel, tone = 'primary', onConfirm, pending, extraValid = true }: {
  isOpen: boolean; onOpenChange: (o: boolean) => void; title: string; amount: Minor | null; currency: Currency;
  children?: ReactNode; confirmLabel: string; tone?: 'primary' | 'danger'; onConfirm: () => void; pending?: boolean; extraValid?: boolean;
}) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} title={title} width="sm"
      footer={<>
        <Button variant="secondary" onPress={() => onOpenChange(false)}>تراجع</Button>
        <Button variant={tone} onPress={onConfirm} isDisabled={pending || !extraValid}>{confirmLabel}</Button>
      </>}>
      <div className="mb-4 rounded-card bg-raised/60 px-4 py-5 text-center">
        <Amount minor={amount} currency={currency} className="text-[28px] font-medium leading-none text-fg" />
      </div>
      {children}
    </Dialog>
  );
}
