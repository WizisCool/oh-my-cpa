import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { EMPTY_PROVIDER_ICONS, PROVIDER_ICONS_PREFERENCE, parseProviderIcons } from '../types/providerIcons';
import { usePluginOAuthLogos } from './usePluginOAuthLogos';

const selectIcons = (preferences: Record<string, unknown>) => parseProviderIcons(preferences[PROVIDER_ICONS_PREFERENCE]);

/** Collection-level sources use only sanitized provider metadata, never the editor’s key-bearing cache. */
export function useProviderBranding() {
  const { data: providerIcons = EMPTY_PROVIDER_ICONS } = useQuery({ queryKey: ['preferences'], queryFn: api.getPreferences, select: selectIcons, staleTime: Infinity, meta: { silent: true } });
  const pluginLogos = usePluginOAuthLogos();
  // Positional ids can have moved in the editor since another route read the catalog.
  const providers = useQuery({ queryKey: ['management-providers-sanitized'], queryFn: () => api.getManagementProviders(false), staleTime: 0 });
  const providersByID = useMemo(() => new Map((providers.data?.providers ?? []).map((provider) => [provider.id, provider])), [providers.data]);
  return useMemo(() => ({
    providerIcons,
    pluginLogos,
    providersByID,
    isProviderCatalogUnknown: providers.isFetching || providers.isError || !providers.data,
  }), [providerIcons, pluginLogos, providersByID, providers.data, providers.isFetching, providers.isError]);
}
