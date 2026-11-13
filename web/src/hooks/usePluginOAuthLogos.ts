import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { QUERY_KEYS } from '../api/queryKeys';
import { type PluginOAuthLogos } from '../types/pluginOAuthProviders';
import {
  buildMergedMultiPortalKeys,
  buildMergedPluginLogos,
  buildMergedPluginOAuthIds,
  buildMergedPluginTitles,
  isPluginOwnedInDirectory,
} from './useIdentityDirectory';

/**
 * The logos the installed (and archived) plugins publish for their OAuth providers,
 * read from the shared `management-identity-directory` query.
 */
export function usePluginOAuthLogos(): PluginOAuthLogos {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 30000,
  });

  return useMemo(() => buildMergedPluginLogos(data), [data]);
}

/** The titles the installed (and archived) plugins' login cards give their OAuth providers. */
export function usePluginOAuthTitles(): ReadonlyMap<string, string> {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 30000,
  });

  return useMemo(() => buildMergedPluginTitles(data), [data]);
}

export function usePluginMultiPortalKeys(): ReadonlySet<string> {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 30000,
  });
  return useMemo(() => buildMergedMultiPortalKeys(data), [data]);
}

export function usePluginOAuthIds(): Set<string> {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 30000,
  });
  return useMemo(() => buildMergedPluginOAuthIds(data), [data]);
}

export function usePluginProviderOwnership(providerKeys: readonly (string | undefined)[], isEnabled: boolean) {
  const query = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 30000,
    enabled: isEnabled,
  });
  return {
    isOwned: isPluginOwnedInDirectory(query.data, providerKeys),
    isUnknown: isEnabled && (!query.data || !query.data.catalog_status.plugins_known),
  };
}
