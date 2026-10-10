import React from 'react';
import clsx from 'clsx';

export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * `plain` is a row of controls; `ruled` sets it between two hairlines, for a list whose filters
   * would otherwise run into the rows below.
   */
  variant?: 'plain' | 'ruled';
  /** Controls that act on the whole list - export, refresh, a count - at the trailing edge. */
  end?: React.ReactNode;
}

/**
 * The row above a list: search first, then the filters that narrow it, then what acts on the result.
 *
 * It wraps instead of scrolling, and `end` keeps the trailing edge on whichever line it lands on.
 * Widths belong to the controls themselves; the row owns only the gap between them.
 */
export function Toolbar({ variant = 'plain', end, className, children, ...attributes }: ToolbarProps) {
  return (
    <div {...attributes} className={clsx('toolbar', variant === 'ruled' && 'is-ruled', className)}>
      {children}
      {end !== undefined && end !== null && end !== false && <div className="toolbar-end">{end}</div>}
    </div>
  );
}
