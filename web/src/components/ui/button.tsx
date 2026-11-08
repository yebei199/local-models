// The one button: variants instead of ad hoc classes, after meow_web's components/ui.
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        solid: 'bg-accent text-on-accent hover:bg-accent/90',
        outline:
          'border border-line bg-panel hover:border-accent aria-pressed:border-accent aria-pressed:bg-soft',
        ghost: 'hover:bg-soft',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4',
        icon: 'size-10',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
