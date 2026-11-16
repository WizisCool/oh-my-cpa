import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { QUERY_KEYS } from '../api/queryKeys';
import { useIsRouteActive } from '../performance/routeContract';
import type {
  ArchivedCredentialItem,
  ArchivedProviderItem,
  IdentityDirectoryResponse,
} from '../types/identityDirectory';
import {
  pluginMultiPortalKeys,
  pluginOAuthProviderKeys,
  pluginOAuthProviderLogos,
  pluginOAuthProviderTitles,
  pluginOwnsProvider,
  type PluginOAuthLogos,
} from '../types/pluginOAuthProviders';
import { EMPTY_PROVIDER_ICONS, PROVIDER_ICONS_PREFERENCE, parseProviderIcons } from '../types/providerIcons';
import { EMPTY_MODEL_ICONS, selectModelIcons } from '../types/modelIcons';
import type { ProviderItem } from '../types/providers';
import { indexCredentialFiles, type CredentialIndex, type ProviderResolutionArchive } from '../types/usageEventIdentity';

const selectIcons = (preferences: Record<string, unknown>) => parseProviderIcons(preferences[PROVIDER_ICONS_PREFERENCE]);

export function buildMergedPluginLogos(
  data: IdentityDirectoryResponse | undefined,
): PluginOAuthLogos {
  const liveLogos = pluginOAuthProviderLogos(data?.plugins);
  const archived = data?.archived_providers;
  if (!archived?.length) return liveLogos;
  const merged = Object.assign(Object.create(null) as PluginOAuthLogos, liveLogos);
  for (const item of archived) {
    if (item.kind !== 'oauth_plugin' || item.is_ambiguous || !item.logo?.trim()) continue;
    const key = item.provider_key.trim().toLowerCase();
    if (key && !merged[key]) {
      merged[key] = item.logo.trim();
    }
  }
  return merged;
}

export function buildMergedPluginTitles(
  data: IdentityDirectoryResponse | undefined,
): ReadonlyMap<string, string> {
  const liveTitles = pluginOAuthProviderTitles(data?.plugins);
  const archived = data?.archived_providers;
  if (!archived?.length) return liveTitles;
  const merged = new Map(liveTitles);
  for (const item of archived) {
    if (item.kind !== 'oauth_plugin' || item.is_ambiguous || !item.name?.trim()) continue;
    const key = item.provider_key.trim().toLowerCase();
    if (key && !merged.has(key)) {
      merged.set(key, item.name.trim());
    }
  }
  return merged;
}

export function buildMergedMultiPortalKeys(
  data: IdentityDirectoryResponse | undefined,
): ReadonlySet<string> {
  const liveKeys = pluginMultiPortalKeys(data?.plugins);
  const archived = data?.archived_providers;
  if (!archived?.length) return liveKeys;
  const merged = new Set(liveKeys);
  for (const item of archived) {
    if (item.kind === 'oauth_plugin' && item.is_multi_portal && !item.is_ambiguous) {
      const key = item.provider_key.trim().toLowerCase();
      if (key) merged.add(key);
    }
  }
  return merged;
}

export function buildMergedPluginOAuthIds(
  data: IdentityDirectoryResponse | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const plugin of data?.plugins ?? []) {
    const keys = pluginOAuthProviderKeys(plugin);
    for (const key of keys) ids.add(key);
    if (keys.length && plugin.metadata?.name) {
      ids.add(plugin.metadata.name.toLowerCase().trim());
    }
  }
  for (const item of data?.archived_providers ?? []) {
    if (item.kind === 'oauth_plugin' && !item.is_ambiguous) {
      const key = item.provider_key.trim().toLowerCase();
      if (key) ids.add(key);
    }
  }
  return ids;
}

export function isPluginOwnedInDirectory(
  data: IdentityDirectoryResponse | undefined,
  providerKeys: readonly (string | undefined)[],
): boolean {
  if (pluginOwnsProvider(data?.plugins, providerKeys)) return true;
  if (!data?.archived_providers?.length) return false;
  const archivedOwned = new Set(
    data.archived_providers
      .filter((item) => item.kind === 'oauth_plugin' && item.is_plugin_owned && !item.is_ambiguous)
      .map((item) => item.provider_key.trim().toLowerCase()),
  );
  for (const rawKey of providerKeys) {
    const key = rawKey?.trim().toLowerCase();
    if (key && archivedOwned.has(key)) return true;
  }
  return false;
}

export interface IdentityDirectoryProjection {
  readonly pluginLogos: PluginOAuthLogos;
  readonly pluginTitles: ReadonlyMap<string, string>;
  readonly multiPortalKeys: ReadonlySet<string>;
  readonly pluginOAuthIds: Set<string>;
  readonly configuredProviders: ProviderItem[] | undefined;
  readonly providersByID: Map<string, ProviderItem>;
  readonly credentials: CredentialIndex;
  readonly archivedCredentialsByIndex: Map<string, ArchivedCredentialItem>;
  readonly archivedProvidersByKey: Map<string, ArchivedProviderItem>;
  readonly archivedProviderIcons: Map<string, string>;
  readonly archive: ProviderResolutionArchive;
}

const EMPTY_IDENTITY_PROJECTION: IdentityDirectoryProjection = (() => {
  const archivedCredentialsByIndex = new Map<string, ArchivedCredentialItem>();
  const archivedProvidersByKey = new Map<string, ArchivedProviderItem>();
  const archivedProviderIcons = new Map<string, string>();
  return {
    pluginLogos: buildMergedPluginLogos(undefined),
    pluginTitles: buildMergedPluginTitles(undefined),
    multiPortalKeys: buildMergedMultiPortalKeys(undefined),
    pluginOAuthIds: buildMergedPluginOAuthIds(undefined),
    configuredProviders: undefined,
    providersByID: new Map<string, ProviderItem>(),
    credentials: indexCredentialFiles([], []),
    archivedCredentialsByIndex,
    archivedProvidersByKey,
    archivedProviderIcons,
    archive: {
      archivedCredentials: archivedCredentialsByIndex,
      archivedProviders: archivedProvidersByKey,
      archivedProviderIcons,
    },
  };
})();

const PROJECTION_CACHE = new WeakMap<IdentityDirectoryResponse, IdentityDirectoryProjection>();

function computeIdentityProjection(data: IdentityDirectoryResponse): IdentityDirectoryProjection {
  const pluginLogos = buildMergedPluginLogos(data);
  const pluginTitles = buildMergedPluginTitles(data);
  const multiPortalKeys = buildMergedMultiPortalKeys(data);
  const pluginOAuthIds = buildMergedPluginOAuthIds(data);
  const configuredProviders: ProviderItem[] = data.providers.map((item) => ({
    ...item,
    disable_cooling: false,
    proxy_configured: false,
  }));
  const providersByID = new Map(configuredProviders.map((provider) => [provider.id, provider]));
  const credentials = indexCredentialFiles(data.credentials ?? [], data.archived_credentials ?? []);

  const archivedCredentialsByIndex = new Map<string, ArchivedCredentialItem>();
  for (const item of data.archived_credentials ?? []) {
    const idx = item.auth_index?.trim();
    if (idx) archivedCredentialsByIndex.set(idx, item);
  }

  const archivedProvidersByKey = new Map<string, ArchivedProviderItem>();
  const archivedProviderIcons = new Map<string, string>();
  const ambiguousKeys = new Set<string>();
  for (const item of data.archived_providers ?? []) {
    const key = item.provider_key?.trim().toLowerCase();
    if (!key) continue;
    archivedProvidersByKey.set(key, item);
    if (item.is_ambiguous) {
      ambiguousKeys.add(key);
    } else if (item.icon_id?.trim()) {
      archivedProviderIcons.set(key, item.icon_id.trim());
    }
  }
  for (const item of data.archived_credentials ?? []) {
    if (item.kind === 'apikey' && !item.is_ambiguous && item.icon_id?.trim() && item.provider_key?.trim()) {
      const key = item.provider_key.trim().toLowerCase();
      if (!ambiguousKeys.has(key) && !archivedProviderIcons.has(key)) {
        archivedProviderIcons.set(key, item.icon_id.trim());
      }
    }
  }

  const archive: ProviderResolutionArchive = {
    archivedCredentials: archivedCredentialsByIndex,
    archivedProviders: archivedProvidersByKey,
    archivedProviderIcons,
  };

  return {
    pluginLogos,
    pluginTitles,
    multiPortalKeys,
    pluginOAuthIds,
    configuredProviders,
    providersByID,
    credentials,
    archivedCredentialsByIndex,
    archivedProvidersByKey,
    archivedProviderIcons,
    archive,
  };
}

/**
 * Memoizes all derived Maps/Sets per `IdentityDirectoryResponse` instance so multiple panels
 * mounting on the same page share one O(1) lookup instead of repeating 10 collection scans each.
 */
export function getIdentityDirectoryProjection(
  data: IdentityDirectoryResponse | undefined,
): IdentityDirectoryProjection {
  if (!data) return EMPTY_IDENTITY_PROJECTION;
  let cached = PROJECTION_CACHE.get(data);
  if (!cached) {
    cached = computeIdentityProjection(data);
    PROJECTION_CACHE.set(data, cached);
  }
  return cached;
}

/**
 * Shared consolidated identity directory across all console pages.
 *
 * Unifies live sanitized providers, live OAuth credentials, live plugin metadata,
 * custom icon assignments, and the SQLite historical identity archive behind one
 * query key (`management-identity-directory`) synchronized via SSE `state_sync`.
 */
export function useIdentityDirectory() {
  const isRouteActive = useIsRouteActive();
  // Preferences stay subscribed so optimistic local icon edits reflect in 0ms
  // before the directory query round-trip settles.
  const { data: prefIcons } = useQuery({
    queryKey: QUERY_KEYS.preferences,
    queryFn: api.getPreferences,
    select: selectIcons,
    staleTime: Infinity,
    meta: { silent: true },
  });

  const { data: prefModelIcons } = useQuery({
    queryKey: QUERY_KEYS.preferences,
    queryFn: api.getPreferences,
    select: selectModelIcons,
    staleTime: Infinity,
    meta: { silent: true },
  });

  const directoryQuery = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 0,
    refetchOnWindowFocus: isRouteActive,
    meta: { silent: true },
  });

  const { data, isError, refetch } = directoryQuery;

  const providerIcons = useMemo(() => {
    if (prefIcons !== undefined) return prefIcons;
    return data?.provider_icons ?? EMPTY_PROVIDER_ICONS;
  }, [data?.provider_icons, prefIcons]);

  const modelIcons = prefModelIcons ?? data?.model_icons ?? EMPTY_MODEL_ICONS;

  const projection = getIdentityDirectoryProjection(data);

  const isProviderCatalogUnproven = isError || !data || !data.catalog_status.providers_known;

  const isCredentialsUnavailable = isError || (data !== undefined && !data.catalog_status.credentials_known);

  // While a cached snapshot already proves the provider catalog (`!isProviderCatalogUnproven`),
  // background revalidation (`isFetching`) keeps using the proven identities instead of flashing
  // every badge back to `unresolved` and re-rendering dependent panels twice on navigation.
  return useMemo(() => ({
    directory: data,
    providerIcons,
    modelIcons,
    pluginLogos: projection.pluginLogos,
    pluginTitles: projection.pluginTitles,
    multiPortalKeys: projection.multiPortalKeys,
    pluginOAuthIds: projection.pluginOAuthIds,
    providersByID: projection.providersByID,
    configuredProviders: projection.configuredProviders,
    credentials: projection.credentials,
    isCredentialsUnavailable,
    archivedCredentialsByIndex: projection.archivedCredentialsByIndex,
    archivedProvidersByKey: projection.archivedProvidersByKey,
    archivedProviderIcons: projection.archivedProviderIcons,
    archive: projection.archive,
    isProviderCatalogUnproven,
    isProviderCatalogUnknown: isProviderCatalogUnproven,
    refetchProviders: refetch,
  }), [
    data,
    providerIcons,
    modelIcons,
    projection,
    isCredentialsUnavailable,
    isProviderCatalogUnproven,
    refetch,
  ]);
}
