import React from 'react';
import clsx from 'clsx';
import styles from './SummaryStrip.module.css';

export type SummaryTone = 'healthy' | 'attention' | 'disabled' | 'meta' | 'warn' | 'success';

export interface SummaryItemConfig {
  key?: React.Key;
  label: React.ReactNode;
  tone?: SummaryTone;
  dot?: boolean;
  testId?: string;
}

export interface SummaryStripProps {
  total?: React.ReactNode;
  totalTestId?: string;
  items?: readonly (SummaryItemConfig | false | null | undefined)[];
  children?: React.ReactNode;
  className?: string;
  testId?: string;
}

function resolveToneClass(tone?: SummaryTone): string | undefined {
  if (tone === 'healthy' || tone === 'success') return styles['summary-healthy'];
  if (tone === 'attention' || tone === 'warn') return styles['summary-attention'];
  if (tone === 'disabled' || tone === 'meta') return styles['summary-disabled'];
  return undefined;
}

/**
 * Functional subtitle / live summary strip.
 *
 * Drawn below the page title across management workspaces (OAuth management, AI providers,
 * API keys) to give an overview of total entities and their health/status breakdown.
 */
export function SummaryStrip({ total, totalTestId, items, children, className, testId }: SummaryStripProps) {
  if (children) {
    return (
      <div className={clsx(styles['summary-strip'], className)} data-testid={testId}>
        {children}
      </div>
    );
  }

  const validItems = items ? (items.filter(Boolean) as SummaryItemConfig[]) : [];

  return (
    <div className={clsx(styles['summary-strip'], className)} data-testid={testId}>
      {total !== undefined && total !== null && total !== '' && (
        <span className={styles['summary-total']} data-testid={totalTestId}>
          {total}
        </span>
      )}
      {validItems.map((item, index) => {
        const toneClass = resolveToneClass(item.tone);
        const showDot = item.dot ?? Boolean(toneClass);
        const needsDivider = (total !== undefined && total !== null && total !== '') || index > 0;

        return (
          <React.Fragment key={item.key ?? index}>
            {needsDivider && <span className={styles['summary-divider']}>·</span>}
            <span className={clsx(styles['summary-item'], toneClass)} data-testid={item.testId}>
              {showDot && <span className={styles['status-dot']} aria-hidden="true" />}
              {item.label}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

SummaryStrip.Total = function SummaryTotal({
  children,
  className,
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <span className={clsx(styles['summary-total'], className)} data-testid={testId}>
      {children}
    </span>
  );
};

SummaryStrip.Divider = function SummaryDivider({ className }: { className?: string }) {
  return <span className={clsx(styles['summary-divider'], className)}>·</span>;
};

SummaryStrip.Item = function SummaryItem({
  tone,
  dot,
  children,
  className,
  testId,
}: {
  tone?: SummaryTone;
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const toneClass = resolveToneClass(tone);
  const showDot = dot ?? Boolean(toneClass);

  return (
    <span className={clsx(styles['summary-item'], toneClass, className)} data-testid={testId}>
      {showDot && <span className={styles['status-dot']} aria-hidden="true" />}
      {children}
    </span>
  );
};
