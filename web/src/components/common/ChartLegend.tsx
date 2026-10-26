import React from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';
import selectionStyles from './selection.module.css';
import styles from './ChartLegend.module.css';

export interface ChartLegendItem {
  id: string;
  /** The swatch; omitted for a reference line, which draws `isDashed` instead. */
  color?: string;
  isDashed?: boolean;
  content: React.ReactNode;
  /** A toggle when present; without it the entry is a plain key to the figure. */
  onToggle?: () => void;
  isPressed?: boolean;
  isDimmed?: boolean;
  /** Overrides the toggle's tooltip, for an entry that toggles something other than a filter. */
  title?: string;
  testId?: string;
}

interface ChartLegendProps {
  items: readonly ChartLegendItem[];
  label: string;
  className?: string;
  testId?: string;
}

/**
 * A figure's legend: one bounded entry per series, so a swatch can only belong to the name inside its
 * own hairline box. An entry that can be toggled is a button in the console's selection style; the
 * rest - a remainder, a reference line - are plain keys.
 */
export const ChartLegend: React.FC<ChartLegendProps> = ({ items, label, className, testId }) => {
  const t = useT();
  return (
    <ul className={clsx(styles['legend'], className)} aria-label={label} data-testid={testId}>
      {items.map((item) => {
        const mark = item.isDashed
          ? <i className={clsx(styles['swatch'], styles['swatch-dashed'])} aria-hidden="true" />
          : <i className={styles['swatch']} style={{ background: item.color }} aria-hidden="true" />;
        return (
          <li key={item.id} data-testid={item.testId}>
            {item.onToggle ? (
              <button
                type="button"
                className={clsx(styles['button'], selectionStyles['selection-control'])}
                aria-pressed={Boolean(item.isPressed)}
                data-dimmed={Boolean(item.isDimmed)}
                title={item.title ?? t(item.isPressed ? 'insights.click_to_unfilter' : 'insights.click_to_filter')}
                onClick={item.onToggle}
              >
                {mark}
                {item.content}
              </button>
            ) : (
              <>
                {mark}
                {item.content}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
};
