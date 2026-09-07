import React from 'react';
import { App as AntdApp } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';

export interface Preference<T> {
  value: T;
  /** False until the stored value has been read, so a page can wait instead of painting a default and correcting it. */
  ready: boolean;
  set: (next: T) => void;
}

const writeQueues = new Map<string, Promise<void>>();

/**
 * usePreference reads and writes one server-stored console preference.
 *
 * These live in the database rather than in browser storage on purpose: an
 * incognito window, a browser data reset, a service restart and a container
 * rebuild all drop local browser storage, and an operator's chosen view should
 * survive them all. The write is optimistic into the shared query cache, so the
 * control answers on the frame it was used; writes are serialized per key so
 * rapid concurrent updates never arrive out of order at the server.
 */
export function usePreference<T>(
  key: string,
  fallback: T,
  parse: (raw: unknown) => T | undefined,
): Preference<T> {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const { data, isPending, isError } = useQuery({
    queryKey: ['preferences'],
    queryFn: api.getPreferences,
    staleTime: Infinity,
    meta: { silent: true },
  });

  const stored = parse(data?.[key]);
  const value = stored ?? fallback;

  const set = React.useCallback((next: T) => {
    queryClient.setQueryData<Record<string, unknown>>(['preferences'], (previous) => ({
      ...(previous ?? {}),
      [key]: next,
    }));
    const previousPromise = writeQueues.get(key) ?? Promise.resolve();
    const nextPromise = previousPromise
      .catch(() => {})
      .then(() => api.putPreference(key, next))
      .catch((err: unknown) => {
        message.error(err instanceof ApiError ? err.message : String(err));
      });
    writeQueues.set(key, nextPromise);
  }, [key, message, queryClient]);

  return { value, ready: !isPending || isError, set };
}
