import React from 'react';
import { useDisplayCurrency } from '../../types/CurrencyDisplayContext';
import type { TokenNumberStyle } from '../../types/tokenDisplay';
import type { InsightsMetric } from './insightsCube';
import { formatMetric as formatValue, formatMetricExact as formatExact } from './insightsFormat';

export function useInsightsFormat() {
  const { currency } = useDisplayCurrency();
  const formatMetric = React.useCallback((metric: InsightsMetric, value: number | null, style: TokenNumberStyle) => formatValue(metric, value, style, currency), [currency]);
  return { formatMetric, formatMetricExact: formatExact };
}
