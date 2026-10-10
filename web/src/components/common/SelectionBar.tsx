import React from 'react';
import clsx from 'clsx';

export interface SelectionBarProps {
  /** Names the region for assistive technology: "Selected requests". */
  label: string;
  /** How much is selected, announced as it changes: "3 selected". */
  summary: React.ReactNode;
  /** A qualification of the count, such as rows that are selected but filtered out of view. */
  note?: React.ReactNode;
  /** Controls that change the selection itself: select the page, clear. */
  selection?: React.ReactNode;
  /** What can be done with the selected rows, at the trailing edge. */
  children: React.ReactNode;
  /** `framed` stands above a list as its own strip; `inline` is a row inside the list's frame. */
  variant?: 'framed' | 'inline';
  className?: string;
}

/**
 * What the operator can do with the rows they ticked.
 *
 * It exists only while something is selected, so a list nobody is selecting from carries no extra
 * chrome; the caller renders it conditionally. The count is a live region because ticking a row
 * elsewhere on the page is the only other feedback that the selection changed.
 */
export function SelectionBar({ label, summary, note, selection, children, variant = 'framed', className }: SelectionBarProps) {
  return (
    <div className={clsx('selection-bar', `is-${variant}`, className)} role="region" aria-label={label}>
      <div className="selection-bar-start">
        <span className="selection-bar-count" role="status">{summary}</span>
        {note !== undefined && note !== null && note !== false && <span className="selection-bar-note">{note}</span>}
        {selection}
      </div>
      <div className="selection-bar-actions">{children}</div>
    </div>
  );
}
