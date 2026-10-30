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
 * The mark is a sheet carrying three shortening rules - the rows that are not there - with a second
 * sheet fanned behind it, drawn in CSS from the page's own layers in place of Ant Design's
 * illustrated tray. Reusing the page's shapes keeps the mark at home in either theme.
 * Loading and failure are not empty states; they belong to the placeholders in `PageLoading` and to `LoadFailure`.
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
