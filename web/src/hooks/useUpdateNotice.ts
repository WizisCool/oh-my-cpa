import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { systemLiveChannel } from '../api/systemLive';
import { isDemoMode } from '../types/demoMode';
import type { ReleaseProduct } from '../types/system';
import {
  NO_UPDATE_DISMISSALS,
  UPDATE_DISMISSALS_PREFERENCE,
  listPendingUpdates,
  parseUpdateDismissals,
  withDismissal,
} from '../utils/updateDismissals';
import { usePreference } from './usePreference';

export const UPDATE_STATUS_QUERY_KEY = ['system-updates'] as const;

/**
 * How often an open console re-reads the stored version answers.
 *
 * The server sweeps for releases on the configured interval (hourly by default); this only
 * decides how soon a tab that stays open learns what that sweep found when the live stream is
 * not open. The read costs no feed
 * request, so re-reading on the same period keeps an open tab from trailing the sweep by a
 * second interval.
 */
export const UPDATE_STATUS_REFRESH_MS = 60 * 60 * 1000;

/**
 * The stored dismissals and the two writes the System Information page offers.
 *
 * Both products share one document and each write replaces it whole, so a write is only
 * sound once the stored document is known: built on the empty fallback it would erase the
 * other product's dismissal. `isLoaded` is what a caller gates its controls on.
 */
export function useUpdateDismissals() {
  const { value: dismissals, loaded: isLoaded, set } = usePreference(
    UPDATE_DISMISSALS_PREFERENCE,
    NO_UPDATE_DISMISSALS,
    parseUpdateDismissals,
  );
  const dismiss = React.useCallback(
    (product: ReleaseProduct, tag: string) => set(withDismissal(dismissals, product, tag)),
    [dismissals, set],
  );
  const restore = React.useCallback(
    (product: ReleaseProduct) => set(withDismissal(dismissals, product, null)),
    [dismissals, set],
  );
  return { dismissals, isLoaded, dismiss, restore };
}

/**
 * The system products and installed plugins the shell should flag as having updates.
 *
 * System notices wait until both the version answers and the dismissals have been read: drawing the
 * indicator first and withdrawing it once a dismissal loads would flash a reminder the
 * operator already declined.
 */
export function usePendingUpdates(): { products: ReleaseProduct[]; hasPluginUpdate: boolean } {
  // A failed read is not retried or reported: the indicator is a hint on a page that
  // states the same thing in full.
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: UPDATE_STATUS_QUERY_KEY,
    queryFn: api.getSystemUpdates,
    staleTime: UPDATE_STATUS_REFRESH_MS,
    refetchInterval: UPDATE_STATUS_REFRESH_MS,
    retry: false,
    meta: { silent: true },
  });
  // The sweep writes the observations with no browser waiting on it, so the stream is what
  // keeps the indicator current. The interval above stays as the fallback for a deployment that
  // answers 204 (a demonstration) or while the stream is down. `ready` is a signal too: a tab
  // returning from the background or reconnecting after the stream's own lifetime re-reads once,
  // so an open console reads the stored answer a few times an hour rather than once.
  // The public demonstration serves no stream at all, so it does not ask for one.
  const isDemo = isDemoMode();
  React.useEffect(() => {
    if (isDemo) return undefined;
    return systemLiveChannel().subscribe({
      onSignal: () => { void queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_QUERY_KEY }); },
    });
  }, [isDemo, queryClient]);
  const { dismissals, isLoaded } = useUpdateDismissals();
  return React.useMemo(
    () => ({
      products: data && isLoaded ? listPendingUpdates([data.omc_version, data.cpa_version], dismissals) : [],
      hasPluginUpdate: data?.plugin_update_available === true,
    }),
    [data, dismissals, isLoaded],
  );
}
