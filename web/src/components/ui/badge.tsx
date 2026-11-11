import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium leading-tight whitespace-nowrap select-none',
  {
    variants: {
      tone: {
        neutral: 'bg-field text-fg-2',
        accent: 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-brand',
        success: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-success',
        warn: 'bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] text-warn',
        danger: 'bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-danger',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export type StatusDotTone = 'default' | 'processing' | 'success' | 'warning' | 'error';

const DOT_TONES: Record<StatusDotTone, string> = {
  default: 'bg-meta',
  processing: 'bg-brand animate-pulse',
  success: 'bg-success',
  warning: 'bg-warn',
  error: 'bg-danger',
};

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: StatusDotTone;
  text?: React.ReactNode;
}

export function StatusDot({ status = 'default', text, className, ...props }: StatusDotProps) {
  return (
    <span data-slot="status-dot" className={cn('inline-flex items-center gap-1.5 text-md text-foreground', className)} {...props}>
      <span className={cn('size-1.5 shrink-0 rounded-full', DOT_TONES[status])} aria-hidden="true" />
      {text !== undefined && text !== null && <span>{text}</span>}
    </span>
  );
}
