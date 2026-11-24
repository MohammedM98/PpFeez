import type { ReactNode } from 'react';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { Amount } from './Amount';
import type { Currency, Minor } from '@/lib/contract';

/** Every money action asks first and shows the amount (contract §5). */
export function ConfirmMoney({ isOpen, onOpenChange, title, amount, amountText, currency, children, confirmLabel, tone = 'primary', onConfirm, pending, extraValid = true, dirty }: {
  isOpen: boolean; onOpenChange: (o: boolean) => void; title: string; amount?: Minor | null; amountText?: string; currency: Currency;
  children?: ReactNode; confirmLabel: string; tone?: 'primary' | 'danger'; onConfirm: () => void; pending?: boolean; extraValid?: boolean; dirty?: boolean;
}) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} title={title} width="sm" dirty={dirty}
      footer={<>
        <Button variant="secondary" onPress={() => onOpenChange(false)}>تراجع</Button>
        <Button variant={tone} onPress={onConfirm} isPending={pending} isDisabled={!extraValid}>{confirmLabel}</Button>
      </>}>
      <div className="mb-4 rounded-card bg-raised/60 px-4 py-5 text-center">
        {amountText !== undefined
          ? <bdi dir="ltr" className="num text-[28px] font-medium leading-none text-fg">{amountText} <span className="text-[0.8em] text-fg-3">{currency}</span></bdi>
          : <Amount minor={amount ?? null} currency={currency} className="text-[28px] font-medium leading-none text-fg" />}
      </div>
      {children}
    </Dialog>
  );
}
