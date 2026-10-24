import React from 'react';
import clsx from 'clsx';
import { KeyOutlined } from '../../../components/icons';
import type { InsightsDimension } from '../insightsCube';
import type { InsightsLabels } from '../useInsightsLabels';
import styles from '../insights.module.css';

interface InsightsValueProps {
  dimension: InsightsDimension;
  id: string;
  labels: InsightsLabels;
  /** Prints the secondary line (a key's mask, a credential's provider) beside the name. */
  hasDetail?: boolean;
  className?: string;
}

/**
 * One value as the page names it everywhere: its mark, then its name. A model shows its maker, a
 * provider and a credential their brand, and a key the key glyph, so a row is recognised before it
 * is read and the same value looks the same in a ranking, a chip, a table and the drawer.
 */
export const InsightsValue: React.FC<InsightsValueProps> = ({ dimension, id, labels, hasDetail = false, className }) => {
  const isNonKey = dimension === 'key' && labels.isNonKey(id);
  const mark = dimension === 'key' ? <KeyOutlined aria-hidden="true" /> : labels.mark(dimension, id);
  const detail = hasDetail ? labels.detail(dimension, id) : undefined;
  return (
    <span className={clsx(styles['value'], className)} title={id}>
      <span className={clsx(styles['value-mark'], dimension === 'key' && styles['value-mark-glyph'])} aria-hidden="true">{mark}</span>
      <span className={clsx(styles['value-name'], isNonKey && styles['is-muted'])}>{labels.label(dimension, id)}</span>
      {detail && <span className={styles['value-detail']}>{detail}</span>}
    </span>
  );
};
