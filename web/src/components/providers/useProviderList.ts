import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { QUERY_KEYS } from '../../api/queryKeys';
import type { ManagementProvidersData } from './managementProviders';

/**
 * Reads the provider list for the Providers editor workspace.
 *
 * Optimistic switch toggles write directly into ['management-providers', true]
 * through useOptimisticProviderStatusMutation (cancelling in-flight reads via
 * cancelQueries and revalidating silently only when the final concurrent toggle
 * settles), so no separate generation counter is required.
 */
export function useProviderList() {
  const queryClient = useQueryClient();

  const settleProviderRow = React.useCallback(
    (id: string, isEnabled: boolean) => {
      queryClient.setQueryData<ManagementProvidersData>(
        QUERY_KEYS.providers(true),
        (previous) => {
          if (!previous) return previous;
          let didChange = false;
          const providers = previous.providers.map((provider) => {
            if (provider.id !== id || provider.disabled === !isEnabled) return provider;
            didChange = true;
            return { ...provider, disabled: !isEnabled };
          });
          return didChange ? { ...previous, providers } : previous;
        },
      );
    },
    [queryClient],
  );

  const {
    data: providersData,
    isLoading: providersLoading,
    isError: providersError,
    error: providersErr,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: QUERY_KEYS.providers(true),
    // The providers page owns key management, so it is the one consumer that
    // opts back into plaintext key material (display is masked client-side).
    queryFn: ({ signal }) => api.getManagementProviders(true, { signal }),
    // This query deliberately opts into plaintext key material for the editor.
    // Do not retain it after the page has no observer, and always re-read on a
    // fresh mount rather than serving a cached copy of the credentials.
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });

  const providers = providersData?.providers || [];

  return {
    providers,
    providersLoading,
    providersError,
    providersErr,
    refetchProviders,
    settleProviderRow,
  };
}
