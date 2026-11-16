import { mergeProps, useRender } from '@base-ui/react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const solidFocusRing =
  'focus-visible:inset-ring-2 focus-visible:inset-ring-white-1000 focus-visible:border-blue-500';

const buttonVariants = cva(
  "typography-body-medium inline-flex shrink-0 items-center justify-center gap-1 rounded-md whitespace-nowrap outline-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: cn(
          'bg-blue-500 text-white-1000 active:bg-blue-600 disabled:bg-grey-500',
          solidFocusRing,
        ),
        secondary:
          'border border-grey-200 text-black-800 focus-visible:border-none focus-visible:inset-ring focus-visible:inset-ring-blue-500 active:border-grey-300 active:bg-grey-100 disabled:border-grey-300 disabled:text-grey-500',
        link: 'text-blue-600 focus-visible:inset-ring focus-visible:inset-ring-blue-500 active:bg-blue-200 disabled:text-grey-500',
        ghost:
          'border-none hover:bg-black-200 focus-visible:inset-ring focus-visible:inset-ring-blue-500 active:bg-black-1000/15 disabled:text-grey-500',
      },
      size: {
        default: 'h-6 px-2 has-[>svg]:px-3',
        large: 'h-8 px-3 has-[>svg]:px-4',
        icon: 'size-6',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
);

interface ButtonProps
  extends useRender.ComponentProps<'button'>,
    VariantProps<typeof buttonVariants> {}

function Button({ variant, size, render, className, ...props }: ButtonProps) {
  return useRender({
    defaultTagName: 'button',
    render,
    props: mergeProps<'button'>(props, {
      className: cn(buttonVariants({ variant, size, className })),
    }),
  });
}

export { Button };
