import React from 'react';
import clsx from 'clsx';

export interface Fact {
  key: string;
  label: React.ReactNode;
  value: React.ReactNode;
  /** Forwarded as `data-testid` on the row, for a browser check that counts rows. */
  testId?: string;
}

export interface FactListProps {
  facts: readonly Fact[];
  /** `strong` draws the values in the primary ink; `quiet` keeps both columns at reading weight. */
  emphasis?: 'strong' | 'quiet';
  className?: string;
  testId?: string;
}

/**
 * A label/value list: the label on the left in muted ink, the value right-aligned and tabular.
 *
 * It is a description list because that is what the content is - a screen reader then reads
 * each label with its value rather than a column of labels followed by a column of values.
 */
export function FactList({ facts, emphasis = 'strong', className, testId }: FactListProps) {
  return (
    <dl className={clsx('fact-list', `is-${emphasis}`, className)} data-testid={testId}>
      {facts.map((fact) => (
        <div className="fact-list-row" key={fact.key} data-testid={fact.testId}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
