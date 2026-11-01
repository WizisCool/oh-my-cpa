import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { EMPTY_PROVIDER_ICONS, PROVIDER_ICONS_PREFERENCE, parseProviderIcons } from '../types/providerIcons';
import { usePluginOAuthLogos } from './usePluginOAuthLogos';

const selectIcons = (preferences: Record<string, unknown>) => parseProviderIcons(preferences[PROVIDER_ICONS_PREFERENCE]);

/**
 * The collection-level brand sources: artwork preferences, plugin logos and the sanitized
 * provider catalog.
 *
 * The catalog reports two different uncertainties, because they are not the same question.
 * `isProviderCatalogUnknown` covers a refetch in flight as well, and is what a projected connection
 * consults before borrowing a positional id: a refetch may have moved that id to another provider.
 * `isProviderCatalogUnproven` is narrower - the last read failed, or none has succeeded - because it
 * answers a different question: whether a name already on screen is worth writing down. A routine
 * refetch of rows read a moment ago does not make a name a placeholder, and treating it as one would
 * put a warning in front of an export on every visit.
 */
export function useProviderBranding() {
  const { data: providerIcons = EMPTY_PROVIDER_ICONS } = useQuery({ queryKey: ['preferences'], queryFn: api.getPreferences, select: selectIcons, staleTime: Infinity, meta: { silent: true } });
  const pluginLogos = usePluginOAuthLogos();
  // Positional ids can have moved in the editor since another route read the catalog.
  const providers = useQuery({ queryKey: ['management-providers-sanitized'], queryFn: () => api.getManagementProviders(false), staleTime: 0 });
  const { data, isFetching, isError, refetch } = providers;
  const providersByID = useMemo(() => new Map((data?.providers ?? []).map((provider) => [provider.id, provider])), [data]);
  const isProviderCatalogUnproven = isError || !data;
  return useMemo(() => ({
    providerIcons,
    pluginLogos,
    providersByID,
    configuredProviders: data?.providers,
    isProviderCatalogUnproven,
    isProviderCatalogUnknown: isProviderCatalogUnproven || isFetching,
    refetchProviders: refetch,
  }), [providerIcons, pluginLogos, providersByID, data, isProviderCatalogUnproven, isFetching, refetch]);
}
