import { Button as HeroButton, type ButtonProps as HeroButtonProps } from '@heroui/react';
import { buttonVariants } from '@heroui/styles';
import { composeRenderProps } from 'react-aria-components';
import { cx } from './cx';

/*
 * HeroUI Button under the app's four intents:
 *   primary → primary, secondary → tertiary (neutral fill), quiet → ghost, danger → danger.
 * `size="icon"` is HeroUI's icon-only small button.
 */
const variants = { primary: 'primary', secondary: 'tertiary', quiet: 'ghost', danger: 'danger' } as const;
type Variant = keyof typeof variants;
type Size = 'sm' | 'md' | 'icon';

export type ButtonProps = Omit<HeroButtonProps, 'variant' | 'size' | 'isIconOnly'> & { variant?: Variant; size?: Size };

const extra = '[&_svg]:stroke-[1.75]';

/** The same look for things that are not buttons (a router <Link>). */
export function button({ variant = 'secondary', size = 'md', className }: { variant?: Variant; size?: Size; className?: string } = {}) {
  return cx(buttonVariants({ variant: variants[variant], size: size === 'md' ? 'md' : 'sm', isIconOnly: size === 'icon' }), extra, className);
}

export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonProps) {
  return (
    <HeroButton
      {...props}
      variant={variants[variant]}
      size={size === 'md' ? 'md' : 'sm'}
      isIconOnly={size === 'icon'}
      className={composeRenderProps(className, (c) => cx(extra, c))}
    />
  );
}
