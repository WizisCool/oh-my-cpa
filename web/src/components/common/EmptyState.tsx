import React from 'react';
import clsx from 'clsx';

export interface EmptyStateProps {
  /** The state in one line: what is absent ("No keys match"), not what to do about it. */
  title: React.ReactNode;
  /** One further line when the reason or the way out is not obvious from the title. */
  description?: React.ReactNode;
  /** The one action that fills the region - "Browse store", "Clear filters". */
  children?: React.ReactNode;
  /**
   * `block` stands in for a list or a page section and draws the mark; `compact` sits inside a
   * panel, a picker or a drawer section, where the surrounding frame already says "this is a list".
   */
  size?: 'block' | 'compact';
  className?: string;
  testId?: string;
}

/**
 * What a region shows when it holds nothing.
 *
 * The mark is three shortening rules - the rows that are not there - drawn from the border ink, in
 * place of Ant Design's illustrated tray: the console has no illustration language (design.md §1),
 * and a picture of a box was the only one on most pages. Loading and failure are not empty states;
 * they belong to `PageLoading` and `LoadFailure`.
 */
export function EmptyState({ title, description, children, size = 'block', className, testId }: EmptyStateProps) {
  return (
    <div className={clsx('empty-state', `is-${size}`, className)} data-testid={testId}>
      {size === 'block' && (
        <span className="empty-state-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      )}
      <p className="empty-state-title">{title}</p>
      {description !== undefined && description !== null && (
        <p className="empty-state-description">{description}</p>
      )}
      {children !== undefined && children !== null && children !== false && (
        <div className="empty-state-action">{children}</div>
      )}
    </div>
  );
}
