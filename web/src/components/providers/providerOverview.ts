import type { ProviderItem } from '../../types/providers';
import { matchProviderFamily } from '../../types/providerFamilies';
import { successRateTone } from '../../types/usageEventMetrics';
import { aggregateProviders, type WindowProviderTraffic } from '../dashboard/dashboardProvidersLogic';

/** The status tiles, in reading order; each one is also the list's status filter. */
export const PROVIDER_STATUS_FILTERS = ['all', 'active', 'disabled', 'attention'] as const;
export type ProviderStatusFilter = (typeof PROVIDER_STATUS_FILTERS)[number];

/** One provider's traffic over the page's window. */
export interface ProviderTraffic {
  total: number;
  success: number;
  failure: number;
  /** 0-100, or null when the window served nothing. */
  successRate: number | null;
}

export interface ProviderListFilters {
  status: ProviderStatusFilter;
  /** A family id from `PROVIDER_FAMILIES`, the row's raw family otherwise, or `all`. */
  family: string;
  search: string;
}

export const DEFAULT_PROVIDER_FILTERS: ProviderListFilters = { status: 'all', family: 'all', search: '' };

export function providerModelCount(provider: ProviderItem): number {
  return provider.model_entries?.length || provider.models?.length || 0;
}

export function providerKeyCount(provider: ProviderItem): number {
  return provider.key_entries?.length || (provider.key_configured ? 1 : 0);
}

export function providerHeaderCount(provider: ProviderItem): number {
  return provider.headers ? Object.keys(provider.headers).length : 0;
}

/** The family the protocol filter groups a row under: the registry's id when it resolves. */
export function providerFamilyKey(provider: ProviderItem): string {
  return matchProviderFamily(provider.family, provider.protocol)?.id ?? (provider.family || provider.protocol || '');
}

/**
 * providerTrafficById joins the window's per-provider traffic onto the configured rows.
 *
 * CPA labels its usage queue by upstream name, family or a prefixed spelling of either, so the
 * join is the dashboard's own (`aggregateProviders`) rather than a second matcher: the providers
 * page and the dashboard's provider panel therefore always credit a request to the same row.
 * `undefined` means the window could not be read, which the page shows as unknown rather than
 * as zero traffic.
 */
export function providerTrafficById(
  providers: readonly ProviderItem[],
  windowProviders: readonly WindowProviderTraffic[] | undefined,
): Map<string, ProviderTraffic> | undefined {
  if (!windowProviders) return undefined;
  const joined = aggregateProviders({ configuredProviders: [...providers], windowProviders: [...windowProviders] });
  const traffic = new Map<string, ProviderTraffic>();
  for (const row of joined) {
    if (!row.providerId) continue;
    traffic.set(row.providerId, {
      total: row.total,
      success: row.success,
      failure: row.failure,
      successRate: row.successRate,
    });
  }
  return traffic;
}

/**
 * needsAttention answers "is this provider switched on but unable to serve well?".
 *
 * A switched-off provider is the operator's decision, not a fault, so it never counts. A
 * switched-on one counts when it holds no key - CPA has nothing to authenticate with - or when
 * its window's success rate falls below the console's healthy band (`successRateTone`), the
 * same band that colours the rate everywhere else.
 */
export function needsAttention(provider: ProviderItem, isEnabled: boolean, traffic: ProviderTraffic | undefined): boolean {
  if (!isEnabled) return false;
  if (providerKeyCount(provider) === 0) return true;
  const tone = successRateTone(traffic?.successRate);
  return tone === 'warn' || tone === 'danger';
}

/** Whether the search text names the row: its name, endpoint, prefix, id or one of its models. */
export function matchesProviderSearch(provider: ProviderItem, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    provider.name,
    provider.upstream_name,
    provider.id,
    provider.base_url,
    provider.prefix,
    ...(provider.model_entries?.flatMap((model) => [model.name, model.alias]) ?? []),
    ...(provider.models ?? []),
  ];
  return haystack.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

export interface ProviderOverview {
  /** Rows per status tile, counted under the family and search filters. */
  statusCounts: Record<ProviderStatusFilter, number>;
  /** Rows per family, counted under the status and search filters. */
  familyCounts: Record<string, number>;
  visible: ProviderItem[];
}

/**
 * summarizeProviders filters the list and counts each facet under the other facets' selection,
 * so a tile or an option reports how many rows choosing it would show.
 */
export function summarizeProviders(
  providers: readonly ProviderItem[],
  filters: ProviderListFilters,
  isEnabled: (provider: ProviderItem) => boolean,
  traffic: Map<string, ProviderTraffic> | undefined,
): ProviderOverview {
  const statusCounts: Record<ProviderStatusFilter, number> = { all: 0, active: 0, disabled: 0, attention: 0 };
  const familyCounts: Record<string, number> = {};
  const visible: ProviderItem[] = [];

  for (const provider of providers) {
    if (!matchesProviderSearch(provider, filters.search)) continue;
    const enabled = isEnabled(provider);
    const statuses: ProviderStatusFilter[] = ['all', enabled ? 'active' : 'disabled'];
    if (needsAttention(provider, enabled, traffic?.get(provider.id))) statuses.push('attention');
    const family = providerFamilyKey(provider);
    const isFamilyMatch = filters.family === 'all' || filters.family === family;
    const isStatusMatch = statuses.includes(filters.status);

    if (isFamilyMatch) {
      for (const status of statuses) statusCounts[status] += 1;
    }
    if (isStatusMatch) familyCounts[family] = (familyCounts[family] ?? 0) + 1;
    if (isFamilyMatch && isStatusMatch) visible.push(provider);
  }

  return { statusCounts, familyCounts, visible };
}

/** The whole list's traffic over the window, or undefined when the window is unknown. */
export function totalProviderTraffic(
  providers: readonly ProviderItem[],
  traffic: Map<string, ProviderTraffic> | undefined,
): ProviderTraffic | undefined {
  if (!traffic) return undefined;
  let total = 0;
  let success = 0;
  let failure = 0;
  for (const provider of providers) {
    const row = traffic.get(provider.id);
    if (!row) continue;
    total += row.total;
    success += row.success;
    failure += row.failure;
  }
  return { total, success, failure, successRate: total > 0 ? (success / total) * 100 : null };
}
