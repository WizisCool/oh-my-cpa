import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { QUERY_KEYS } from '../api/queryKeys';
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

/**
 * Shared consolidated identity directory across all console pages.
 *
 * Unifies live sanitized providers, live OAuth credentials, live plugin metadata,
 * custom icon assignments, and the SQLite historical identity archive behind one
 * query key (`management-identity-directory`) synchronized via SSE `state_sync`.
 */
export function useIdentityDirectory() {
  // Preferences stay subscribed so optimistic local icon edits reflect in 0ms
  // before the directory query round-trip settles.
  const { data: prefIcons } = useQuery({
    queryKey: QUERY_KEYS.preferences,
    queryFn: api.getPreferences,
    select: selectIcons,
    staleTime: Infinity,
    meta: { silent: true },
  });

  const directoryQuery = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 0,
  });

  const { data, isFetching, isError, refetch } = directoryQuery;

  const providerIcons = useMemo(() => {
    if (prefIcons !== undefined) return prefIcons;
    return data?.provider_icons ?? EMPTY_PROVIDER_ICONS;
  }, [data?.provider_icons, prefIcons]);

  const pluginLogos = useMemo(() => buildMergedPluginLogos(data), [data]);
  const pluginTitles = useMemo(() => buildMergedPluginTitles(data), [data]);
  const multiPortalKeys = useMemo(() => buildMergedMultiPortalKeys(data), [data]);
  const pluginOAuthIds = useMemo(() => buildMergedPluginOAuthIds(data), [data]);

  const configuredProviders = useMemo<ProviderItem[] | undefined>(() => {
    if (!data) return undefined;
    return data.providers.map((item) => ({
      ...item,
      disable_cooling: false,
      proxy_configured: false,
    }));
  }, [data]);

  const providersByID = useMemo(
    () => new Map((configuredProviders ?? []).map((provider) => [provider.id, provider])),
    [configuredProviders],
  );

  const credentials = useMemo<CredentialIndex>(
    () => indexCredentialFiles(data?.credentials ?? [], data?.archived_credentials ?? []),
    [data?.credentials, data?.archived_credentials],
  );

  const archivedCredentialsByIndex = useMemo(() => {
    const map = new Map<string, ArchivedCredentialItem>();
    for (const item of data?.archived_credentials ?? []) {
      const idx = item.auth_index?.trim();
      if (idx) map.set(idx, item);
    }
    return map;
  }, [data?.archived_credentials]);

  const archivedProvidersByKey = useMemo(() => {
    const map = new Map<string, ArchivedProviderItem>();
    for (const item of data?.archived_providers ?? []) {
      const key = item.provider_key?.trim().toLowerCase();
      if (key) map.set(key, item);
    }
    return map;
  }, [data?.archived_providers]);

  const archivedProviderIcons = useMemo(() => {
    const map = new Map<string, string>();
    const ambiguousKeys = new Set<string>();
    for (const item of data?.archived_providers ?? []) {
      const key = item.provider_key.trim().toLowerCase();
      if (!key) continue;
      if (item.is_ambiguous) {
        ambiguousKeys.add(key);
      } else if (item.icon_id?.trim()) {
        map.set(key, item.icon_id.trim());
      }
    }
    for (const item of data?.archived_credentials ?? []) {
      if (item.kind === 'apikey' && !item.is_ambiguous && item.icon_id?.trim() && item.provider_key?.trim()) {
        const key = item.provider_key.trim().toLowerCase();
        if (!ambiguousKeys.has(key) && !map.has(key)) {
          map.set(key, item.icon_id.trim());
        }
      }
    }
    return map;
  }, [data?.archived_providers, data?.archived_credentials]);

  const archive = useMemo<ProviderResolutionArchive>(
    () => ({
      archivedCredentials: archivedCredentialsByIndex,
      archivedProviders: archivedProvidersByKey,
      archivedProviderIcons,
    }),
    [archivedCredentialsByIndex, archivedProvidersByKey, archivedProviderIcons],
  );

  const isProviderCatalogUnproven = isError || !data || !data.catalog_status.providers_known;

  const isCredentialsUnavailable = isError || (data !== undefined && !data.catalog_status.credentials_known);

  return useMemo(() => ({
    directory: data,
    providerIcons,
    pluginLogos,
    pluginTitles,
    multiPortalKeys,
    pluginOAuthIds,
    providersByID,
    configuredProviders,
    credentials,
    isCredentialsUnavailable,
    archivedCredentialsByIndex,
    archivedProvidersByKey,
    archivedProviderIcons,
    archive,
    isProviderCatalogUnproven,
    isProviderCatalogUnknown: isProviderCatalogUnproven || isFetching,
    refetchProviders: refetch,
  }), [
    data,
    providerIcons,
    pluginLogos,
    pluginTitles,
    multiPortalKeys,
    pluginOAuthIds,
    providersByID,
    configuredProviders,
    credentials,
    isCredentialsUnavailable,
    archivedCredentialsByIndex,
    archivedProvidersByKey,
    archivedProviderIcons,
    archive,
    isProviderCatalogUnproven,
    isFetching,
    refetch,
  ]);
}
