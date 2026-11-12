import React from 'react';
import clsx from 'clsx';

export interface MetaLineProps {
  children: React.ReactNode;
  className?: string;
  /** `quiet` sets the line in the footnote ink; the default is the hint ink. */
  tone?: 'default' | 'quiet';
  testId?: string;
}

/**
 * A row of short facts about one thing: a size and a line count, a provider and its priority, a
 * request count and its failures. Facts sit apart by space, not by a glyph between them, and wrap as
 * whole units, so a narrow column breaks between facts rather than inside one. A fact that needs
 * emphasis carries it itself (`<b>` for the figure, a tone class for a failure) instead of leaning
 * on a separator for structure. Empty children (`false`, `null`, `''`) are dropped, so callers pass
 * conditional facts inline.
 */
export function MetaLine({ children, className, tone = 'default', testId }: MetaLineProps) {
  const items = React.Children.toArray(children).filter((child) => child !== '');
  if (items.length === 0) return null;
  return (
    <span className={clsx('meta-line', tone === 'quiet' && 'is-quiet', className)} data-testid={testId}>
      {items.map((item, index) => (
        <span className="meta-line-item" key={React.isValidElement(item) && item.key !== null ? item.key : index}>
          {item}
        </span>
      ))}
    </span>
  );
}
