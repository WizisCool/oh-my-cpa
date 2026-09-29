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
export const TimeZoneProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { value, server, ready } = useTimeZoneSetting();
  const [isConfigured, setIsConfigured] = React.useState(false);
  React.useLayoutEffect(() => {
    if (!ready) return;
    configureTimeZone(value, server);
    setIsConfigured(true);
  }, [value, server, ready]);
  return ready && isConfigured ? <>{children}</> : null;
};
