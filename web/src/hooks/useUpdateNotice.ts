import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
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
 * The server looks for releases every six hours; this only decides how soon a tab that stays
 * open learns what that sweep found. The read costs no feed request, so it is hourly rather
 * than matched to the sweep, which would let a tab trail a new release by a second interval.
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
 * The products the shell should flag as having a newer release.
 *
 * Empty until both the version answers and the dismissals have been read: drawing the
 * indicator first and withdrawing it once a dismissal loads would flash a reminder the
 * operator already declined.
 */
export function usePendingUpdates(): ReleaseProduct[] {
  // A failed read is not retried or reported: the indicator is a hint on a page that
  // states the same thing in full.
  const { data } = useQuery({
    queryKey: UPDATE_STATUS_QUERY_KEY,
    queryFn: api.getSystemUpdates,
    staleTime: UPDATE_STATUS_REFRESH_MS,
    refetchInterval: UPDATE_STATUS_REFRESH_MS,
    retry: false,
    meta: { silent: true },
  });
  const { dismissals, isLoaded } = useUpdateDismissals();
  return React.useMemo(
    () => (data && isLoaded ? listPendingUpdates([data.omc_version, data.cpa_version], dismissals) : []),
    [data, dismissals, isLoaded],
  );
}
