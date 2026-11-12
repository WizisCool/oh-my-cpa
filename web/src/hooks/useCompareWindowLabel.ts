import React from 'react';
import { useT } from '../i18n';
import dayjs from '../utils/time';
import type { TipCard } from '../components/common/tipCard';
import type { MetricComparison } from '../types/insightsCube';
import { changeTrend, formatChange, formatCompareWindowBounds, type CompareWindowBounds } from '../types/insightsFormat';

function useCompareBounds() {
  return React.useCallback(
    (compare: CompareWindowBounds) =>
      formatCompareWindowBounds(compare, dayjs().year(), (ms, layout) => dayjs(ms).format(layout), (ms) => dayjs(ms).year()),
    [],
  );
}

/**
 * Names the full previous period a figure's robust average baseline is drawn from. The same
 * sentence is the Insights footnote, so a reader who hovers a change and a reader who scrolls to the
 * bottom are told the same thing.
 */
export function useCompareWindowLabel(): (compare: CompareWindowBounds) => string {
  const t = useT();
  const bounds = useCompareBounds();
  return React.useCallback((compare: CompareWindowBounds) => t('insights.compare_window', bounds(compare)), [t, bounds]);
}

export interface ComparisonTipInput {
  comparison: MetricComparison;
  /** The window the change is measured against, when the caller knows it. */
  compare?: CompareWindowBounds | null;
  /** The previous period's average, already formatted in the figure's own unit. */
  previous?: string | null;
}

/**
 * The card a change badge opens: the change, the average it is measured from and the period that
 * average covers, each on its own row, then how the baseline is derived. Dashboard KPI tiles,
 * Insights tiles and ranking cells all read the same card.
 */
export function useComparisonTip(): (input: ComparisonTipInput) => TipCard | null {
  const t = useT();
  const bounds = useCompareBounds();
  return React.useCallback(({ comparison, compare, previous }: ComparisonTipInput) => {
    const change = comparison.kind === 'new'
      ? t('insights.change_new')
      : comparison.kind === 'change' ? formatChange(comparison.change) : null;
    const isNoise = comparison.kind === 'change' && comparison.isNoise;
    if (!compare && !isNoise) return null;
    const trend = changeTrend(comparison);
    const range = compare ? bounds(compare) : null;
    return {
      heading: t('insights.compare_heading'),
      rows: [
        change ? { label: t('insights.compare_change'), value: change, tone: trend } : null,
        previous ? { label: t('insights.compare_previous'), value: previous } : null,
        range ? { label: t('insights.compare_range'), value: `${range.from} – ${range.to}` } : null,
      ].filter((row) => row !== null),
      notes: [isNoise && t('insights.change_noise'), compare && t('insights.compare_baseline_note')],
    };
  }, [t, bounds]);
}
