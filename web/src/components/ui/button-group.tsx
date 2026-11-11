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
        '[&>[data-slot=button]+[data-slot=button]]:border-l [&>[data-slot=button]+[data-slot=button]]:border-l-[color-mix(in_srgb,var(--bg)_24%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}
