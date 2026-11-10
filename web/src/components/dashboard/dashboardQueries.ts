import { api } from '../../api/client';
import { defineSwrQuery } from '../../performance/swrContract';
import type { DashboardResponse, DashboardTailResponse } from '../../types/dashboard';
import {
  DASHBOARD_MODELS_QUERY_KEY,
  DASHBOARD_MODELS_REFRESH_MS,
  type DashboardModelsResponse,
} from '../../types/dashboardModels';
import type { DashboardTokenHeatmap } from '../../types/tokenHeatmap';
import type { ManagementOverview } from '../../types/management';

export const TOKEN_HEATMAP_QUERY_KEY = 'dashboard-token-heatmap';
export const TOKEN_HEATMAP_REFRESH_MS = 5 * 60_000;

export const dashboardWindowSwr = defineSwrQuery<string, DashboardResponse>({
  scope: 'dashboard',
  tags: ['usage', 'dashboard'],
  staleTime: 15_000,
  gcTime: 5 * 60_000,
  placeholderStrategy: 'keepPrevious',
  key: (query) => ['dashboard', query] as const,
  fetcher: (query) => api.getDashboard(query),
});

/**
 * Keyed strictly by `['dashboard-tail', query]` (never by ephemeral component `revision`),
 * so live SSE updates patch in place without proliferating QueryCache entries and route
 * remounts retain the freshest tail snapshot instead of rolling figures back to the base read.
 */
export const dashboardTailSwr = defineSwrQuery<string, DashboardTailResponse>({
  scope: 'dashboard-tail',
  tags: ['usage', 'dashboard'],
  staleTime: 5_000,
  gcTime: 5 * 60_000,
  placeholderStrategy: 'sameScope',
  silent: true,
  key: (query) => ['dashboard-tail', query] as const,
  fetcher: (query) => api.getDashboardTail(query),
});

export const dashboardModelsSwr = defineSwrQuery<string, DashboardModelsResponse>({
  scope: DASHBOARD_MODELS_QUERY_KEY,
  tags: ['usage', 'dashboard'],
  staleTime: DASHBOARD_MODELS_REFRESH_MS / 2,
  gcTime: 5 * 60_000,
  placeholderStrategy: 'keepPrevious',
  silent: true,
  key: (modelsQuery) => [DASHBOARD_MODELS_QUERY_KEY, modelsQuery] as const,
  fetcher: (modelsQuery) => api.getDashboardModels(modelsQuery),
});

export const dashboardHeatmapSwr = defineSwrQuery<string, DashboardTokenHeatmap>({
  scope: TOKEN_HEATMAP_QUERY_KEY,
  tags: ['usage', 'dashboard'],
  staleTime: TOKEN_HEATMAP_REFRESH_MS / 2,
  gcTime: 10 * 60_000,
  placeholderStrategy: 'keepPrevious',
  silent: true,
  key: (timezone) => [TOKEN_HEATMAP_QUERY_KEY, timezone] as const,
  fetcher: (timezone) => api.getTokenHeatmap(timezone),
});

export const managementOverviewSwr = defineSwrQuery<void, ManagementOverview>({
  scope: 'management-overview',
  tags: ['dashboard'],
  staleTime: 15_000,
  gcTime: 5 * 60_000,
  placeholderStrategy: 'keepPrevious',
  silent: true,
  key: () => ['management-overview'] as const,
  fetcher: () => api.getManagementOverview(),
});
