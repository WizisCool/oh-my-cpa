import React from 'react';
import clsx from 'clsx';
import { CloseOutlined } from '../icons';
import { ToolButton } from './ToolButton';

export interface SelectionBarProps {
  /** Names the region for assistive technology: "Selected requests". */
  label: string;
  /** How much is selected, announced as it changes: "3 selected". */
  summary: React.ReactNode;
  /** A qualification of the count, such as rows that are selected but filtered out of view. */
  note?: React.ReactNode;
  /** Ends the choice; drawn as the bar's leading glyph so the way out has one place on every list. */
  onClear: () => void;
  /** Names the leading glyph: "Clear selection". */
  clearLabel: string;
  isClearDisabled?: boolean;
  /** Controls that widen the selection itself, as quiet text links: select the page, select all. */
  selection?: React.ReactNode;
  /** What can be done with the selected rows, at the trailing edge. */
  children: React.ReactNode;
  className?: string;
}

/**
 * What the operator can do with the rows they ticked.
 *
 * It exists only while something is selected, so a list nobody is selecting from carries no extra
 * chrome; the caller renders it conditionally, docked over the list's foot, so ticking a row never
 * moves the rows. The bar reads in one order everywhere: the way out, how much is chosen, how to
 * widen it, then what to do with it. The count is a live region because ticking a row elsewhere on
 * the page is the only other feedback that the selection changed.
 */
export function SelectionBar({
  label,
  summary,
  note,
  onClear,
  clearLabel,
  isClearDisabled,
  selection,
  children,
  className,
}: SelectionBarProps) {
  return (
    <div className={clsx('selection-bar', className)} role="region" aria-label={label}>
      <div className="selection-bar-start">
        <ToolButton
          className="selection-bar-clear"
          size="sm"
          variant="ghost"
          icon={<CloseOutlined />}
          label={clearLabel}
          disabled={isClearDisabled}
          onClick={onClear}
        />
        <span className="selection-bar-count" role="status">{summary}</span>
        {note !== undefined && note !== null && note !== false && <span className="selection-bar-note">{note}</span>}
        {selection}
      </div>
      <div className="selection-bar-actions">{children}</div>
    </div>
  );
}
