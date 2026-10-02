import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { usePreference } from '../hooks/usePreference';
import { configureTimeZone, getTimeZone, parseTimeZone, subscribeTimeZone } from './time';

export function useTimeZone(): string {
  return React.useSyncExternalStore(subscribeTimeZone, getTimeZone, getTimeZone);
}
export function useTimeZoneSetting() {
  const preference = usePreference<string>('omc_timezone', '', parseTimeZone);
  const { data } = useQuery({ queryKey: ['preferences'], queryFn: api.getPreferences, staleTime: Infinity, meta: { silent: true } });
  const server = parseTimeZone(data?.omc_server_timezone) || 'UTC';
  return { ...preference, server };
}
/**
 * Holds its children until the console's time zone is configured, so no timestamp is ever painted in
 * the wrong zone and then corrected. `fallback` is what stands in meanwhile: the wait is a read of
 * the stored preferences, which a slow deployment can stretch past a frame or two.
 */
export const TimeZoneProvider: React.FC<{ children: React.ReactNode; fallback?: React.ReactNode }> = ({ children, fallback = null }) => {
  const { value, server, ready } = useTimeZoneSetting();
  const [isConfigured, setIsConfigured] = React.useState(false);
  React.useLayoutEffect(() => {
    if (!ready) return;
    configureTimeZone(value, server);
    setIsConfigured(true);
  }, [value, server, ready]);
  return ready && isConfigured ? <>{children}</> : <>{fallback}</>;
};
