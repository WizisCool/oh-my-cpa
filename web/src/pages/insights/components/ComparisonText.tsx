import React from 'react';
import { useT } from '../../../i18n';
import type { MetricComparison } from '../insightsCube';
import { changeTrend, formatChange } from '../insightsFormat';

interface ComparisonTextProps {
  comparison: MetricComparison;
  className?: string;
}

/** A group's change against the comparison window, as a ranking row or a table cell writes it. */
export const ComparisonText: React.FC<ComparisonTextProps> = ({ comparison, className }) => {
  const t = useT();
  const text = comparison.kind === 'new'
    ? t('insights.change_new')
    : comparison.kind === 'change' ? formatChange(comparison.change) ?? '—' : '—';
  const isNoise = comparison.kind === 'change' && comparison.isNoise;
  return (
    <span className={className} data-trend={changeTrend(comparison)} title={isNoise ? t('insights.change_noise') : t('insights.col.change')}>
      {text}
      {isNoise && <span className="sr-only">{t('insights.change_noise')}</span>}
    </span>
  );
};
