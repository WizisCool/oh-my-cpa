import * as React from 'react';
import { cn } from '@/lib/utils';

export function ButtonGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        'inline-flex items-center',
        '[&>[data-slot=button]:not(:first-child)]:rounded-l-none',
        '[&>[data-slot=button]:not(:last-child)]:rounded-r-none',
        '[&>[data-slot=button]+[data-slot=button]]:border-l-[length:var(--hairline)] [&>[data-slot=button]+[data-slot=button]]:border-l-border',
        '[&>[data-slot=button][data-variant=primary]+[data-slot=button]]:border-l-[color-mix(in_srgb,var(--primary-on)_22%,transparent)]',
        '[&>[data-slot=button][data-split-caret]]:w-[26px] [&>[data-slot=button][data-split-caret]]:min-w-[26px] [&>[data-slot=button][data-split-caret]]:px-0',
        '[&>[data-slot=button][data-variant=primary][data-split-caret]_[data-slot=dropdown-caret]]:text-primary-foreground [&>[data-slot=button][data-variant=primary][data-split-caret]_[data-slot=dropdown-caret]]:opacity-85',
        className,
      )}
      {...props}
    />
  );
}
