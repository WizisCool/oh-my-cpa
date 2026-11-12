import { formatModelShare, type DashboardModelUsage } from '../types/dashboardModels';
import { formatTokens, type TokenNumberStyle } from '../types/tokenDisplay';
import { seriesDomainKey } from './chartTheme';

/** A shared bucket grid keeps quiet series visible; rank one is painted last at crossings. */
export function buildModelTrendSeries(groups: DashboardModelUsage[]) {
  const categories = [...new Set(groups.flatMap((group) => group.series.map((point) => point.t)))].sort((left, right) => left - right);
  return {
    categories: categories.map(String),
    series: [...groups].reverse().map((group) => {
      const byBucket = new Map(group.series.map((point) => [point.t, point.tokens]));
      return { id: seriesDomainKey(group), values: categories.map((at) => byBucket.get(at) ?? 0) };
    }),
  };
}

export interface ModelTrendTooltipRow {
  key: string;
  name: string;
  color?: string;
  value: string;
  share?: string;
  isTotal?: boolean;
}

/**
 * Formats one bucket's breakdown for the ModelTokenTrend tooltip, honoring the console's
 * configured token unit style (`omc_token_style`) for both per-model rows and the bucket total.
 */
export function buildModelTrendTooltipRows({
  row,
  domain,
  range,
  labelOf,
  totalLabel,
  tokenUnitLabel = '',
  tokenStyle,
}: {
  row: { total: number; [series: string]: string | number };
  domain: readonly string[];
  range: readonly string[];
  labelOf: (key: string) => string;
  totalLabel: string;
  tokenUnitLabel?: string;
  tokenStyle: TokenNumberStyle;
}): ModelTrendTooltipRow[] {
  const suffix = tokenUnitLabel ? ` ${tokenUnitLabel}` : '';
  // Only the models that moved in this bucket, largest first: a column of zeros
  // buried the one or two rows the reader was hovering for.
  const moved = domain
    .map((key, idx) => ({ key, idx, value: Number(row[key] ?? 0) }))
    .filter((entry) => entry.value > 0)
    .sort((left, right) => right.value - left.value);

  return [
    ...moved.map(({ key, idx, value }) => ({
      key,
      name: labelOf(key),
      color: range[idx],
      value: formatTokens(value, tokenStyle),
      share: moved.length > 1 ? formatModelShare(value, row.total) : undefined,
    })),
    {
      key: 'total',
      name: totalLabel,
      value: `${formatTokens(row.total, tokenStyle)}${suffix}`,
      isTotal: true,
    },
  ];
}
