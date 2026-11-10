import { api } from './api/client';
import { preloadDashboardCharts, preloadInsightsCharts } from './charts/lazyCharts';
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
  loadAgentPage,
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
import { getAppConfig } from './types/config';

function readCachedPreferences(ctx: RoutePrefetchContext): Record<string, unknown> | undefined {
  return ctx.queryClient.getQueryData<Record<string, unknown>>(['preferences']);
}

async function prefetchDashboardData(ctx: RoutePrefetchContext): Promise<void> {
  const prefs = readCachedPreferences(ctx);
  if (!prefs) return;
  const range = parseDashboardRange(prefs[DASHBOARD_RANGE_PREFERENCE]) ?? DEFAULT_DASHBOARD_RANGE;
  const modelView = parseModelChartView(prefs.omc_model_chart_view) ?? DEFAULT_MODEL_CHART_VIEW;
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
    loadingBody: 'panels',
    preloadChunk: () => Promise.all([loadInsightsPage(), preloadInsightsCharts()]),
    prefetchData: prefetchInsightsData,
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
    loadingBody: 'table',
    preloadChunk: loadLogsPage,
  },
  { path: '/ai-providers', priority: 'normal', preloadChunk: loadProvidersPage },
  { path: '/api-keys', priority: 'normal', preloadChunk: loadApiKeysPage },
  { path: '/routing', priority: 'normal', loadingBody: 'panels', preloadChunk: loadRoutingPage },
  { path: '/oauth-management', priority: 'normal', preloadChunk: loadOAuthManagementPage },
  { path: '/auth-files', priority: 'normal', preloadChunk: loadLegacyOAuthManagementRedirect },
  { path: '/oauth', priority: 'normal', preloadChunk: loadLegacyOAuthManagementRedirect },
  { path: '/quota', priority: 'normal', preloadChunk: loadLegacyOAuthManagementRedirect },
  { path: '/model-square', priority: 'normal', preloadChunk: loadModelSquarePage },
  { path: '/agent', priority: 'normal', loadingBody: 'workspace', preloadChunk: loadAgentPage },
  { path: '/playground', priority: 'normal', loadingBody: 'workspace', preloadChunk: loadPlaygroundPage },
  { path: '/audit', priority: 'normal', loadingBody: 'table', preloadChunk: loadAuditPage },
  { path: '/config', priority: 'normal', loadingBody: 'panels', preloadChunk: loadConfigPage },
  { path: '/omc-settings', priority: 'normal', loadingBody: 'panels', preloadChunk: loadOmcSettingsPage },
  { path: '/system', priority: 'normal', loadingBody: 'panels', preloadChunk: loadSystemPage },
  { path: '/plugins', priority: 'normal', preloadChunk: loadPluginsPage },
  { path: '/plugins/store', priority: 'normal', preloadChunk: loadPluginsPage },
  { path: '/plugins/settings', priority: 'normal', preloadChunk: loadPluginsPage },
  { path: '/plugin-pages/', matchPrefix: true, priority: 'normal', preloadChunk: loadPluginPageHost },
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
