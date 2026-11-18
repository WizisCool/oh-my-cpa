import { clsx } from 'clsx';
import React from 'react';

export type AttentionTone = 'warn' | 'danger';

export interface AttentionDotProps {
  tone?: AttentionTone;
  /** What the dot flags, read by assistive technology; without it the dot is decoration. */
  label?: string;
  className?: string;
}

/**
 * A small dot that asks for a look: an update waiting, a quota heading for its limit. `warn` is
 * something coming, `danger` something that has already happened.
 */
export function AttentionDot({ tone = 'warn', label, className }: AttentionDotProps) {
  return (
    <span
      className={clsx('attention-dot', className)}
      data-tone={tone}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export interface FlaggedMarkProps extends AttentionDotProps {
  children: React.ReactNode;
  testId?: string;
}

/**
 * Pins the dot just outside a mark's top corner, where it touches neither the glyph nor a row's
 * hover fill, so a list flags an entry without moving its text.
 */
export function FlaggedMark({ children, testId, ...dot }: FlaggedMarkProps) {
  return (
    <span className="flagged-mark" data-testid={testId}>
      {children}
      <AttentionDot {...dot} />
    </span>
  );
}
