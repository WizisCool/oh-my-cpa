import { createNamedLoader, createRouteLoader, lazyRoute } from '../utils/routeLoader';
import type { DashboardTrendChartProps } from './DashboardTrendChart';
import type { ModelTokenTrendProps } from './ModelTokenTrend';
import type { InsightsTrendChartProps } from '../pages/insights/charts/InsightsTrendChart';
import type { InsightsFlowChartProps } from '../pages/insights/charts/InsightsFlowChart';
import type { InsightsCompositionChartProps } from '../pages/insights/charts/InsightsCompositionChart';
import type { InsightsHourChartProps } from '../pages/insights/charts/InsightsHourChart';
import type { QuotaBurnChartProps } from '../pages/trends/charts/QuotaBurnChart';
import type { QuotaCyclesChartProps } from '../pages/trends/charts/QuotaCyclesChart';
import type { PerformanceChartProps } from '../pages/trends/charts/PerformanceChart';

/**
 * Shared preloadable loaders for lazy chart modules across Dashboard, Insights and Trends.
 *
 * Centralizing these loaders lets `routePreload` settle both the route module and its nested
 * chart modules in parallel, so `lazyRoute` renders charts synchronously on first mount without
 * triggering nested `React.lazy` Suspense fallbacks.
 */

export const loadDashboardTrendChart = createNamedLoader(
  () => import('./DashboardTrendChart'),
  'DashboardTrendChart',
);
export const LazyDashboardTrendChart = lazyRoute<DashboardTrendChartProps>(loadDashboardTrendChart);

export const loadModelTokenTrend = createNamedLoader(
  () => import('./ModelTokenTrend'),
  'ModelTokenTrend',
);
export const LazyModelTokenTrend = lazyRoute<ModelTokenTrendProps>(loadModelTokenTrend);

export const loadInsightsTrendChart = createRouteLoader(
  () => import('../pages/insights/charts/InsightsTrendChart'),
);
export const LazyInsightsTrendChart = lazyRoute<InsightsTrendChartProps>(loadInsightsTrendChart);

export const loadInsightsFlowChart = createRouteLoader(
  () => import('../pages/insights/charts/InsightsFlowChart'),
);
export const LazyInsightsFlowChart = lazyRoute<InsightsFlowChartProps>(loadInsightsFlowChart);

export const loadInsightsCompositionChart = createRouteLoader(
  () => import('../pages/insights/charts/InsightsCompositionChart'),
);
export const LazyInsightsCompositionChart = lazyRoute<InsightsCompositionChartProps>(loadInsightsCompositionChart);

export const loadInsightsHourChart = createRouteLoader(
  () => import('../pages/insights/charts/InsightsHourChart'),
);
export const LazyInsightsHourChart = lazyRoute<InsightsHourChartProps>(loadInsightsHourChart);

export const loadQuotaBurnChart = createRouteLoader(() => import('../pages/trends/charts/QuotaBurnChart'));
export const LazyQuotaBurnChart = lazyRoute<QuotaBurnChartProps>(loadQuotaBurnChart);

export const loadQuotaCyclesChart = createRouteLoader(() => import('../pages/trends/charts/QuotaCyclesChart'));
export const LazyQuotaCyclesChart = lazyRoute<QuotaCyclesChartProps>(loadQuotaCyclesChart);


export const loadPerformanceChart = createRouteLoader(() => import('../pages/trends/charts/PerformanceChart'));
export const LazyPerformanceChart = lazyRoute<PerformanceChartProps>(loadPerformanceChart);

export function preloadDashboardCharts(): Promise<unknown> {
  return loadModelTokenTrend();
}

export function preloadInsightsCharts(): Promise<unknown> {
  return Promise.all([
    loadInsightsTrendChart(),
    loadInsightsFlowChart(),
    loadInsightsCompositionChart(),
    loadInsightsHourChart(),
  ]);
}

export function preloadTrendsCharts(): Promise<unknown> {
  return Promise.all([
    loadQuotaBurnChart(),
    loadQuotaCyclesChart(),
    loadPerformanceChart(),
  ]);
}
