import React from 'react';
import clsx from 'clsx';

export interface CountProps {
  children: React.ReactNode;
  /** `small` is for a count inside a control - a filter segment, a chip - where it must not widen the label. */
  size?: 'default' | 'small';
  className?: string;
}

/**
 * How many rows a label stands for, set beside it in the quiet ink.
 *
 * Tabular numerals keep a row of them from shifting as the figures change. The gap to the label
 * belongs to the row it sits in; this draws the figure only.
 */
export function Count({ children, size = 'default', className }: CountProps) {
  return <span className={clsx('count', size === 'small' && 'is-small', className)}>{children}</span>;
}
