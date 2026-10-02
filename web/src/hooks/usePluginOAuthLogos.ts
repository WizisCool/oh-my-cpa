import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  pluginOAuthProviderLogos,
  pluginOwnsProvider,
  type PluginOAuthLogos,
} from '../types/pluginOAuthProviders';

/**
 * The logos the installed plugins publish for their OAuth providers.
 *
 * Every provider surface needs the same answer, and the plugin list is the same
 * query the OAuth page and the dashboard already read, so it is fetched under one
 * query key and shared rather than asking CPA once per page.
 */
export function usePluginOAuthLogos(): PluginOAuthLogos {
  const { data } = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 30000,
  });

  return useMemo(() => pluginOAuthProviderLogos(data?.plugins), [data]);
}

export function usePluginProviderOwnership(providerKeys: (string | undefined)[], isEnabled: boolean) {
  const query = useQuery({ queryKey: ['management-plugins'], queryFn: api.getPlugins, staleTime: 30000, enabled: isEnabled });
  return { isOwned: pluginOwnsProvider(query.data?.plugins, providerKeys), isUnknown: isEnabled && !query.data };
}
