import React from 'react';
import clsx from 'clsx';

export interface PageHeaderProps {
  /** The page's one title: the nav label, or the verdict on the dashboard. */
  title: React.ReactNode;
  /** One line naming the surface's subject or carrying live data - never a restatement of the title. */
  subtitle?: React.ReactNode;
  /** The page-level actions, right-aligned; the primary action goes last so it sits at the edge. */
  actions?: React.ReactNode;
  /** Extra content under the title, such as a live summary strip. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * The head every console page opens with: title block on the left, actions on the right.
 *
 * It is one component rather than markup each page repeats because the pages had drifted into
 * four different action containers, two heading elements and three button sizes - a reader
 * moving between pages saw the refresh control jump and resize. The classes stay global
 * (`terminal-page-head`, `terminal-title`, `terminal-page-actions`) because the browser checks
 * select on them and a page-specific stylesheet may still tune its own head.
 */
export function PageHeader({ title, subtitle, actions, children, className }: PageHeaderProps) {
  return (
    <header className={clsx('terminal-page-head', className)}>
      <div className="terminal-page-heading">
        <h1 className="terminal-title">{title}</h1>
        {subtitle !== undefined && subtitle !== null && subtitle !== '' && (
          <p className="terminal-subtitle">{subtitle}</p>
        )}
        {children}
      </div>
      {actions !== undefined && actions !== null && actions !== false && (
        <div className="terminal-page-actions">{actions}</div>
      )}
    </header>
  );
}
