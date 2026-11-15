import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { QUERY_KEYS } from '../api/queryKeys';
import { useIsRouteActive } from '../performance/routeContract';
import { type PluginOAuthLogos } from '../types/pluginOAuthProviders';
import {
  getIdentityDirectoryProjection,
  isPluginOwnedInDirectory,
} from './useIdentityDirectory';

/**
 * The logos the installed (and archived) plugins publish for their OAuth providers,
 * read from the shared `management-identity-directory` query.
 */
export function usePluginOAuthLogos(): PluginOAuthLogos {
  const isRouteActive = useIsRouteActive();
  const { data } = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 0,
    refetchOnWindowFocus: isRouteActive,
    meta: { silent: true },
  });

  return getIdentityDirectoryProjection(data).pluginLogos;
}

/** The titles the installed (and archived) plugins' login cards give their OAuth providers. */
export function usePluginOAuthTitles(): ReadonlyMap<string, string> {
  const isRouteActive = useIsRouteActive();
  const { data } = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 0,
    refetchOnWindowFocus: isRouteActive,
    meta: { silent: true },
  });

  return getIdentityDirectoryProjection(data).pluginTitles;
}

export function usePluginMultiPortalKeys(): ReadonlySet<string> {
  const isRouteActive = useIsRouteActive();
  const { data } = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 0,
    refetchOnWindowFocus: isRouteActive,
    meta: { silent: true },
  });
  return getIdentityDirectoryProjection(data).multiPortalKeys;
}

export function usePluginOAuthIds(): Set<string> {
  const isRouteActive = useIsRouteActive();
  const { data } = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 0,
    refetchOnWindowFocus: isRouteActive,
    meta: { silent: true },
  });
  return getIdentityDirectoryProjection(data).pluginOAuthIds;
}

export function usePluginProviderOwnership(providerKeys: readonly (string | undefined)[], isEnabled: boolean) {
  const isRouteActive = useIsRouteActive();
  const query = useQuery({
    queryKey: QUERY_KEYS.identityDirectory,
    queryFn: ({ signal }) => api.getIdentityDirectory({ signal }),
    staleTime: 0,
    refetchOnWindowFocus: isRouteActive,
    enabled: isEnabled,
    meta: { silent: true },
  });
  return {
    isOwned: isPluginOwnedInDirectory(query.data, providerKeys),
    isUnknown: isEnabled && (!query.data || !query.data.catalog_status.plugins_known),
  };
}
