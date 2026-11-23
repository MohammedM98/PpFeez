import { Button as RacButton, type ButtonProps, composeRenderProps } from 'react-aria-components';
import { tv, type VariantProps } from 'tailwind-variants';

export const button = tv({
  base: [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-ctl font-medium select-none',
    'transition-[background-color,border-color,color,transform] duration-150 ease-out',
    'outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus',
    'data-[pressed]:scale-[0.98] data-[disabled]:opacity-45 data-[disabled]:cursor-not-allowed cursor-default',
    '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]',
  ],
  variants: {
    variant: {
      primary: 'bg-accent text-accent-fg data-[hovered]:brightness-110 shadow-[inset_0_1px_0_rgb(255_255_255/0.14)]',
      secondary: 'bg-raised text-fg border border-line data-[hovered]:border-line-strong',
      quiet: 'text-fg-2 data-[hovered]:bg-raised data-[hovered]:text-fg',
      danger: 'bg-neg text-white data-[hovered]:brightness-110',
    },
    size: {
      sm: 'h-8 px-3 text-[13px]',
      md: 'h-9 px-4 text-sm',
      icon: 'size-8 p-0',
    },
  },
  defaultVariants: { variant: 'secondary', size: 'md' },
});

export function Button({ variant, size, className, ...props }: ButtonProps & VariantProps<typeof button>) {
  return (
    <RacButton
      {...props}
      className={composeRenderProps(className, (c, rp) => button({ variant, size, className: c, ...rp }))}
    />
  );
}
