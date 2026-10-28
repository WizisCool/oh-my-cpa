import React from 'react';
import { useT } from '../../../i18n';
import type { InsightsCompareWindow } from '../../../types/insights';
import type { MetricComparison } from '../insightsCube';
import { changeTrend, formatChange } from '../insightsFormat';
import { useCompareWindowLabel } from '../useCompareWindowLabel';

interface ComparisonTextProps {
  comparison: MetricComparison;
  /** The window it is measured against, when the caller knows it: its instants are the title. */
  compare?: InsightsCompareWindow | null;
  className?: string;
}

/** A group's change against the comparison window, as a ranking row or a table cell writes it. */
export const ComparisonText: React.FC<ComparisonTextProps> = ({ comparison, compare, className }) => {
  const t = useT();
  const formatCompareWindow = useCompareWindowLabel();
  const text = comparison.kind === 'new'
    ? t('insights.change_new')
    : comparison.kind === 'change' ? formatChange(comparison.change) ?? '—' : '—';
  const isNoise = comparison.kind === 'change' && comparison.isNoise;
  const title = [
    isNoise ? t('insights.change_noise') : null,
    compare ? formatCompareWindow(compare) : null,
  ].filter(Boolean).join(' · ') || t('insights.col.change');
  return (
    <span className={className} data-trend={changeTrend(comparison)} title={title}>
      {text}
      {isNoise && <span className="sr-only">{t('insights.change_noise')}</span>}
    </span>
  );
};
