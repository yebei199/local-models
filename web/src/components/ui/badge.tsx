// A small status label; `on` marks something that holds the GPU.
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center rounded-full px-2.5 text-sm font-semibold', {
  variants: {
    tone: {
      idle: 'bg-soft text-accent',
      on: 'bg-busy text-on-accent',
    },
  },
  defaultVariants: { tone: 'idle' },
});

export function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
