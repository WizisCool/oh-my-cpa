import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SpinnerProps extends React.ComponentProps<'span'> {
  size?: 'small' | 'default' | 'large';
  spinning?: boolean;
  children?: React.ReactNode;
}

export function Spinner({
  size = 'default',
  spinning = true,
  className,
  children,
  ...props
}: SpinnerProps) {
  const iconSize = size === 'small' ? 'size-3.5' : size === 'large' ? 'size-6' : 'size-4';
  if (children !== undefined) {
    return (
      <div className={cn('relative', className)}>
        {spinning ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/55">
            <Loader2 className={cn('animate-spin text-muted-foreground', iconSize)} />
          </div>
        ) : null}
        <div className={cn(spinning && 'opacity-50 transition-opacity')}>{children}</div>
      </div>
    );
  }
  if (!spinning) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      data-slot="spinner"
      className={cn('inline-flex items-center justify-center text-muted-foreground', className)}
      {...props}
    >
      <Loader2 className={cn('animate-spin', iconSize)} />
    </span>
  );
}
