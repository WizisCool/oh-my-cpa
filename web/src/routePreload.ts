import type { QueryClient } from '@tanstack/react-query';
import { api } from './api/client';
import { preloadDashboardCharts, preloadInsightsCharts, preloadTrendsCharts } from './charts/lazyCharts';
import {
  dashboardHeatmapSwr,
  dashboardModelsSwr,
  dashboardWindowSwr,
  managementOverviewSwr,
} from './components/dashboard/dashboardQueries';
import { PRICING_QUERY_KEYS } from './components/pricing/pricingQueries';
import {
  bindActiveRouteRegistry,
  createRouteRegistry,
  type RouteDescriptor,
  type RoutePrefetchContext,
} from './performance/routeContract';
import {
  loadAppLayout,
  loadUsageEventsPage,
  loadPricingPage,
  loadProvidersPage,
  loadApiKeysPage,
  loadRoutingPage,
  loadDashboardPage,
  loadInsightsPage,
  loadTrendsPage,
  loadAgentPage,
  loadAuthorizePage,
  loadPlaygroundPage,
  loadModelSquarePage,
  loadLogsPage,
  loadAuditPage,
  loadConfigPage,
  loadOAuthManagementPage,
  loadLegacyOAuthManagementRedirect,
  loadSystemPage,
  loadPluginsPage,
  loadPluginPageHost,
  loadOmcSettingsPage,
} from './routePages';
import {
  DASHBOARD_RANGE_PREFERENCE,
  dashboardRangeParams,
  DEFAULT_DASHBOARD_RANGE,
  parseDashboardRange,
} from './types/dashboard';
import { withGroupBy } from './types/dashboardModels';
import {
  DEFAULT_INSIGHTS_RANGE,
  INSIGHTS_RANGE_PREFERENCE,
  insightsRangeParams,
  parseInsightsRange,
} from './types/insights';
import {
  DEFAULT_MODEL_CHART_VIEW,
  parseModelChartView,
} from './types/tokenDisplay';
import { MODEL_VIEW_PREFERENCE } from './types/tokenDisplayContext';
import { getAppConfig } from './types/config';

function readCachedPreferences(ctx: RoutePrefetchContext): Record<string, unknown> | undefined {
  return ctx.queryClient.getQueryData<Record<string, unknown>>(['preferences']);
}

async function prefetchDashboardData(ctx: RoutePrefetchContext): Promise<void> {
  const prefs = readCachedPreferences(ctx);
  if (!prefs) return;
  const range = parseDashboardRange(prefs[DASHBOARD_RANGE_PREFERENCE]) ?? DEFAULT_DASHBOARD_RANGE;
  const modelView = parseModelChartView(prefs[MODEL_VIEW_PREFERENCE]) ?? DEFAULT_MODEL_CHART_VIEW;
  const query = dashboardRangeParams(range);
  await Promise.allSettled([
    dashboardWindowSwr.prefetch(ctx.queryClient, query),
    dashboardModelsSwr.prefetch(ctx.queryClient, withGroupBy(query, modelView)),
    dashboardHeatmapSwr.prefetch(ctx.queryClient, ctx.timeZone),
    managementOverviewSwr.prefetch(ctx.queryClient),
  ]);
}

async function prefetchInsightsData(ctx: RoutePrefetchContext): Promise<void> {
  const prefs = readCachedPreferences(ctx);
  if (!prefs) return;
  const range = parseInsightsRange(prefs[INSIGHTS_RANGE_PREFERENCE]) ?? DEFAULT_INSIGHTS_RANGE;
  const params = insightsRangeParams(range, 'auto');
  await ctx.queryClient.prefetchQuery({
    queryKey: ['insights-cube', params],
    queryFn: () => api.getInsightsCube(params),
    staleTime: 15_000,
    meta: { silent: true },
  });
}

async function prefetchPricingData(ctx: RoutePrefetchContext): Promise<void> {
  await ctx.queryClient.prefetchQuery({
    queryKey: PRICING_QUERY_KEYS.book,
    queryFn: api.getPricing,
    staleTime: 15_000,
    meta: { silent: true },
  });
}

/**
 * Declarative route registry for the console's views.
 *
 * `prefetchData` is intentionally restricted to read-only, secret-free, non-audited local SQLite
 * telemetry queries so navigation hover intent never touches upstream CPA endpoints or audit logs.
 */
export const ROUTE_DESCRIPTORS: readonly RouteDescriptor[] = [
  {
    path: '/dashboard',
    priority: 'critical',
    loadingBody: 'dashboard',
    preloadChunk: () => Promise.all([loadDashboardPage(), preloadDashboardCharts()]),
    prefetchData: prefetchDashboardData,
  },
  {
    path: '/usage/events',
    priority: 'high',
    loadingBody: 'table',
    preloadChunk: loadUsageEventsPage,
  },
  {
    path: '/insights',
    priority: 'high',
    loadingBody: 'insights',
    preloadChunk: () => Promise.all([loadInsightsPage(), preloadInsightsCharts()]),
    prefetchData: prefetchInsightsData,
  },
  {
    path: '/trends',
    priority: 'high',
    loadingBody: 'trends',
    preloadChunk: () => Promise.all([loadTrendsPage(), preloadTrendsCharts()]),
  },
  {
    path: '/pricing',
    priority: 'high',
    loadingBody: 'table',
    preloadChunk: loadPricingPage,
    prefetchData: prefetchPricingData,
  },
  {
    path: '/logs',
    priority: 'high',
    loadingBody: 'logs',
    preloadChunk: loadLogsPage,
  },
  { path: '/ai-providers', priority: 'normal', loadingBody: 'directory', preloadChunk: loadProvidersPage },
  { path: '/api-keys', priority: 'normal', loadingBody: 'directory', preloadChunk: loadApiKeysPage },
  { path: '/routing', priority: 'normal', loadingBody: 'routing', preloadChunk: loadRoutingPage },
  { path: '/oauth-management', priority: 'normal', loadingBody: 'fleet', preloadChunk: loadOAuthManagementPage },
  { path: '/auth-files', priority: 'normal', loadingBody: 'fleet', preloadChunk: loadLegacyOAuthManagementRedirect },
  { path: '/oauth', priority: 'normal', loadingBody: 'fleet', preloadChunk: loadLegacyOAuthManagementRedirect },
  { path: '/quota', priority: 'normal', loadingBody: 'fleet', preloadChunk: loadLegacyOAuthManagementRedirect },
  { path: '/model-square', priority: 'normal', loadingBody: 'catalog', preloadChunk: loadModelSquarePage },
  { path: '/agent', priority: 'normal', loadingBody: 'workspace', preloadChunk: loadAgentPage },
  { path: '/playground', priority: 'normal', loadingBody: 'workspace', preloadChunk: loadPlaygroundPage },
  { path: '/audit', priority: 'normal', loadingBody: 'directory', preloadChunk: loadAuditPage },
  { path: '/config', priority: 'normal', loadingBody: 'workbench', preloadChunk: loadConfigPage },
  { path: '/omc-settings', priority: 'normal', loadingBody: 'settings', preloadChunk: loadOmcSettingsPage },
  { path: '/system', priority: 'normal', loadingBody: 'system', preloadChunk: loadSystemPage },
  { path: '/plugins', priority: 'normal', loadingBody: 'plugins', preloadChunk: loadPluginsPage },
  { path: '/plugins/store', priority: 'normal', loadingBody: 'plugins-store', preloadChunk: loadPluginsPage },
  { path: '/plugins/settings', priority: 'normal', loadingBody: 'plugins-settings', preloadChunk: loadPluginsPage },
  { path: '/plugin-pages/', matchPrefix: true, priority: 'normal', loadingBody: 'frame', preloadChunk: loadPluginPageHost },
  { path: '/authorize/', matchPrefix: true, priority: 'normal', loadingBody: 'authorize', preloadChunk: loadAuthorizePage },
];

export const consoleRouteRegistry = createRouteRegistry(ROUTE_DESCRIPTORS);
bindActiveRouteRegistry(consoleRouteRegistry);

/** Preloads route and sub-panel code chunks without issuing API requests. */
export function preloadRoute(path: string): void {
  void consoleRouteRegistry.preloadChunk(path);
}

/** Preloads route chunks and optional silent SWR telemetry queries on navigation intent. */
export function warmRouteIntent(path: string, context?: RoutePrefetchContext): void {
  consoleRouteRegistry.warmIntent(path, context);
}

/** Resolves the app-internal route path from `window.location.pathname` respecting `basePath`. */
export function currentConsolePathname(): string {
  if (typeof window === 'undefined') return '/dashboard';
  const basePath = (getAppConfig().basePath || '').replace(/\/+$/, '');
  const raw = window.location.pathname || '/';
  if (basePath && (raw === basePath || raw.startsWith(`${basePath}/`))) {
    return raw.slice(basePath.length) || '/';
  }
  return raw;
}

/** Extracts the `/management/trends/quota` filter query string from a `/trends` URL search string. */
export function trendsQuotaParamsFromSearch(search: string): string {
  if (!search) return '';
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const key of ['provider', 'auth_index'] as const) {
    const seen = new Set<string>();
    for (const raw of source.getAll(key)) {
      const value = raw.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      params.append(key, value);
    }
  }
  return params.toString();
}

/**
 * Prefetches preference-independent landing-route data on authenticated cold boot so requests
 * start in parallel with `/preferences` instead of waiting for `TimeZoneProvider`, `AppLayout`,
 * and page mount (and before competing analytics queries contend for the single SQLite connection).
 *
 * Intentionally separate from `ROUTE_DESCRIPTORS.prefetchData`, which runs on sidebar hover intent
 * and must never touch upstream CPA endpoints.
 */
export function prefetchLandingRouteData(
  queryClient: QueryClient,
  pathname = currentConsolePathname(),
  search = typeof window !== 'undefined' ? window.location.search : '',
): void {
  if (pathname === '/trends') {
    const quotaQuery = trendsQuotaParamsFromSearch(search);
    void queryClient.prefetchQuery({
      queryKey: ['trends-quota', quotaQuery],
      queryFn: ({ signal }) => api.getTrendsQuota(quotaQuery, signal),
      staleTime: 30_000,
      retry: false,
      meta: { silent: true },
    }).catch(() => undefined);
  }
}

/**
 * Starts downloading `AppLayout` and the landing route's code chunks in parallel with session
 * verification so cold boots eliminate the serial `session -> preferences -> AppLayout -> page -> charts`
 * waterfall without adding static imports to `index.html`.
 */
export function preloadBootChunks(pathname = currentConsolePathname()): void {
  if (pathname.startsWith('/authorize/')) return;
  void loadAppLayout().catch(() => undefined);
  void consoleRouteRegistry.preloadChunk(pathname);
}
