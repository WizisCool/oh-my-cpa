import type { DashboardModelUsage } from '../types/dashboardModels';
import { seriesDomainKey } from './chartTheme';

/** Draw the highest-ranked model last while preserving every measured zero bucket. */
export function buildModelTrendData(groups: DashboardModelUsage[]) {
  return [...groups].reverse().flatMap((group) => group.series.map((point) => ({
    series: seriesDomainKey(group), bucket: String(point.t), at: point.t, tokens: point.tokens,
  })));
}
