import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { usePreference } from '../hooks/usePreference';
import { configureTimeZone, getTimeZone, parseTimeZone, primeTimeZone, subscribeTimeZone } from './time';

export function useTimeZone(): string {
  return React.useSyncExternalStore(subscribeTimeZone, getTimeZone, getTimeZone);
}
const selectServerTimeZone = (preferences: Record<string, unknown>) => preferences.omc_server_timezone;

export function useTimeZoneSetting() {
  const preference = usePreference<string>('omc_timezone', '', parseTimeZone);
  const { data } = useQuery({ queryKey: ['preferences'], queryFn: api.getPreferences, select: selectServerTimeZone, staleTime: Infinity, meta: { silent: true } });
  const server = parseTimeZone(data) || 'UTC';
  return { ...preference, server };
}
/**
 * Holds its children until the console's time zone is configured, so no timestamp is ever painted in
 * the wrong zone and then corrected. Priming before initial child mount avoids an extra `<ShellLoading />`
 * commit pass while `useLayoutEffect` notifies mounted subscribers on subsequent preference changes.
 */
export const TimeZoneProvider: React.FC<{ children: React.ReactNode; fallback?: React.ReactNode }> = ({ children, fallback = null }) => {
  const { value, server, ready } = useTimeZoneSetting();
  const hasMountedChildrenRef = React.useRef(false);
  if (ready && !hasMountedChildrenRef.current) {
    primeTimeZone(value, server);
  }
  React.useLayoutEffect(() => {
    if (!ready) return;
    hasMountedChildrenRef.current = true;
    configureTimeZone(value, server);
  }, [value, server, ready]);
  return ready ? <>{children}</> : <>{fallback}</>;
};
