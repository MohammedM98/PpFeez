import { Dropdown, type DropdownProps, type DropdownPopoverProps, type DropdownMenuProps, type DropdownItemProps } from '@heroui/react';
import { cx } from './cx';

/*
 * Action menus (the ⋯ of a row, "المزيد", the Excel chip): HeroUI Dropdown.
 * <MenuTrigger> takes the button and a <MenuPopover>; destructive items use `variant="danger"`.
 */
export function MenuTrigger(props: DropdownProps) {
  return <Dropdown {...props} />;
}

export function MenuPopover({ className, placement = 'bottom end', ...props }: DropdownPopoverProps) {
  return <Dropdown.Popover placement={placement} {...props} className={cx('min-w-48', className as string)} />;
}

export function Menu<T extends object>(props: DropdownMenuProps<T>) {
  return <Dropdown.Menu {...props} />;
}

export function MenuItem({ className, ...props }: DropdownItemProps) {
  return <Dropdown.Item {...props} className={cx('min-h-8 gap-2 text-sm [&>svg]:size-4 [&>svg]:text-fg-3', className as string)} />;
}
