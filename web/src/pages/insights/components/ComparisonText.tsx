import React from 'react';
import { useT } from '../../../i18n';
import type { InsightsCompareWindow } from '../../../types/insights';
import type { MetricComparison } from '../../../types/insightsCube';
import { changeTrend, formatChange } from '../../../types/insightsFormat';
import { useComparisonTip } from '../../../hooks/useCompareWindowLabel';
import { tipCard } from '../../../components/common/tipCard';

interface ComparisonTextProps {
  comparison: MetricComparison;
  /** The window it is measured against, when the caller knows it: the hint names its instants. */
  compare?: InsightsCompareWindow | null;
  className?: string;
}

/** A group's change against the comparison window, as a ranking row or a table cell writes it. */
export const ComparisonText: React.FC<ComparisonTextProps> = ({ comparison, compare, className }) => {
  const t = useT();
  const comparisonTip = useComparisonTip();
  const text = comparison.kind === 'new'
    ? t('insights.change_new')
    : comparison.kind === 'change' ? formatChange(comparison.change) ?? '—' : '—';
  const isNoise = comparison.kind === 'change' && comparison.isNoise;
  return (
    <span className={className} data-trend={changeTrend(comparison)} {...tipCard(comparisonTip({ comparison, compare }))}>
      {text}
      {isNoise && <span className="sr-only">{t('insights.change_noise')}</span>}
    </span>
  );
};
