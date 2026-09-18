import React, { useRef } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api/client';
import type { ManagementProvidersData } from './managementProviders';

/**
 * The provider list and the revision of its confirmed state.
 *
 * A read records the revision before it starts and compares it afterwards. The
 * revision advances when a write confirms a new state, so a read that began
 * before that confirmation can tell that the data it just received describes a
 * state which has since been replaced - otherwise such a read would resolve
 * afterwards and put the pre-write value back on screen.
 */
export function useProviderList() {
  const queryClient = useQueryClient();

  /**
   * providersListReads is the revision of the provider list's confirmed state.
   *
   * A read records this before it starts and compares it afterwards. It advances
   * when a write confirms a new state, so a read that began before that
   * confirmation can tell that the data it just received describes a state which
   * has since been replaced. Without it, such a read would resolve afterwards and
   * put the pre-write value back on screen.
   */
  const providersListReadsRef = useRef(0);

  /**
   * settleProviderRow writes one confirmed provider state into the cached list.
   *
   * The read generation is advanced first: any list read already in flight was
   * issued before this confirmation, so its data describes a state that has since
   * been superseded. Re-reading on every toggle was the other way a stale
   * response could win, so it is avoided rather than reconciled.
   */
  const settleProviderRow = React.useCallback(
    (id: string, isEnabled: boolean) => {
      providersListReadsRef.current += 1;
      queryClient.setQueryData<ManagementProvidersData>(
        ['management-providers', true],
        (previous) => {
          if (!previous) return previous;
          let didChange = false;
          const providers = previous.providers.map((provider) => {
            if (provider.id !== id || provider.disabled === !isEnabled) return provider;
            didChange = true;
            return { ...provider, disabled: !isEnabled };
          });
          // A new object only when a row really changed: an identical list would
          // still re-render every row while a burst is in flight.
          return didChange ? { ...previous, providers } : previous;
        },
      );
    },
    [queryClient],
  );

  const {
    data: providersData,
    isLoading: providersLoading,
    isFetching: providersFetching,
    isError: providersError,
    error: providersErr,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['management-providers', true],
    // The providers page owns key management, so it is the one consumer that
    // opts back into plaintext key material (display is masked client-side).
    queryFn: async () => {
      const generation = providersListReadsRef.current;
      const data = await api.getManagementProviders(true);
      // A confirmation that landed while this read was in flight has already
      // written the newer state into the cache. Publishing this read's older data
      // would undo that confirmation, so the cache is returned as it stands. It is
      // returned rather than thrown so the read does not put the page into an
      // error state over data that is merely superseded.
      if (generation !== providersListReadsRef.current) {
        return queryClient.getQueryData<ManagementProvidersData>(['management-providers', true]) ?? data;
      }
      return data;
    },
    staleTime: 30000,
  });

  const providers = providersData?.providers || [];

  return {
    providers,
    providersLoading,
    providersFetching,
    providersError,
    providersErr,
    refetchProviders,
    settleProviderRow,
  };
}
