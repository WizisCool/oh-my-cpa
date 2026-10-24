import React from 'react';
import { Button } from 'antd';
import { useT } from '../../../i18n';
import styles from '../insights.module.css';

interface PanelNarrowingProps {
  /** How many of this panel's values the page is narrowed to. */
  count: number;
  /** What the panel measures, shown while nothing of it is chosen. */
  unit: React.ReactNode;
  onClear: () => void;
}

/**
 * A filtering panel's trailing head: its unit at rest, and "Clear (n)" in the same place once a value
 * of it is chosen - so the panel that made a narrowing is also where it is undone.
 */
export const PanelNarrowing: React.FC<PanelNarrowingProps> = ({ count, unit, onClear }) => {
  const t = useT();
  return count > 0 ? (
    <Button type="link" size="small" className={styles['ranking-clear']} onClick={onClear}>
      {t('insights.filter_clear_one', { n: count })}
    </Button>
  ) : (
    <span className={styles['panel-meta']}>{unit}</span>
  );
};
