import type { DashboardModelUsage } from '../types/dashboardModels';
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
