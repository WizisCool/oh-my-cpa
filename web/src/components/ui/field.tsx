import * as React from 'react';
import { cn } from '@/lib/utils';

export interface FieldProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  label?: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  extra?: React.ReactNode;
  error?: React.ReactNode;
}

export function Field({
  label,
  htmlFor,
  required,
  extra,
  error,
  className,
  children,
  ...props
}: FieldProps) {
  return (
    <div data-slot="field" className={cn('mb-4 flex flex-col gap-1.5', className)} {...props}>
      {label !== undefined && label !== null ? (
        <label
          htmlFor={htmlFor}
          className="inline-flex items-center gap-1 text-xs font-medium text-foreground select-none"
        >
          {required ? (
            <span className="text-[var(--danger)]" aria-hidden="true">
              *
            </span>
          ) : null}
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <div role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </div>
      ) : extra ? (
        <div className="text-xs text-muted-foreground">{extra}</div>
      ) : null}
    </div>
  );
}
