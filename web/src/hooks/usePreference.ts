import React from 'react';
import { App as AntdApp } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';

export interface Preference<T> {
  value: T;
  /** False until the stored value has been read, so a page can wait instead of painting a default and correcting it. */
  ready: boolean;
  set: (next: T) => Promise<PreferenceWrite>;
}

/**
 * The outcome of one write, so a caller can tell a saved value from an optimistically shown one.
 *
 * A rejection would be the tidier shape, but this hook is used by callers that have nothing to do with
 * the result, and a rejected promise nobody handles is a console error rather than a signal. Reporting
 * it instead means the callers that care can wait, and the ones that do not are unchanged.
 */
export interface PreferenceWrite {
  ok: boolean;
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

  // The parsed value must be reference-stable across renders. Callers feed it
  // straight into effect deps (e.g. the request-events column widths sync
  // `setColWidths(pref)` on change); a fresh object per render there turned
  // every render into the next effect run — an idle render loop that
  // re-reconciles the whole page (list, toolbar and the detail drawer)
  // hundreds of times per second without ever writing to the DOM. This
  // requires object-valued fallbacks and catch-free parsers to live at module
  // scope (see call sites); inline closures would defeat the memo.
  const raw = data?.[key];
  const stored = React.useMemo(() => parse(raw), [key, raw, parse]);
  const value = stored ?? fallback;

  const set = React.useCallback((next: T) => {
    // The optimistic value, captured *before* the cache write so a failed save
    // can be undone. It is the newest local opinion at this moment - either the
    // server's last known value or an earlier write that has not settled yet -
    // which is exactly what the control must fall back to when the server
    // refuses this one.
    const previous = queryClient.getQueryData<Record<string, unknown>>(['preferences'])?.[key];
    queryClient.setQueryData<Record<string, unknown>>(['preferences'], (cached) => ({
      ...(cached ?? {}),
      [key]: next,
    }));
    const previousPromise = writeQueues.get(key) ?? Promise.resolve();
    let ok = true;
    const nextPromise = previousPromise
      .catch(() => {})
      .then(() => api.putPreference(key, next))
      .catch((err: unknown) => {
        ok = false;
        message.error(err instanceof ApiError ? err.message : String(err));
        // Put the control back where it was. Without this the optimistic value
        // stays in the cache while the server still holds the old one, and
        // because these preferences never auto-refetch (`staleTime: Infinity`)
        // the console would keep showing a setting that was never saved - a
        // failure reported in a toast and contradicted by the control itself.
        //
        // Only when no newer write has been queued behind this one: that write
        // has already replaced the cache with its own optimistic value, and
        // rolling back to *our* snapshot would erase the operator's latest
        // intent - the failure it may also report is the one that decides.
        //
        // And deliberately not by invalidating `['preferences']` instead: the
        // whole preference document is one cache entry, so a refetch would also
        // overwrite every *other* key's in-flight optimistic write with the
        // server's older value - trading this control's honesty for a flicker in
        // controls this write never touched.
        if (writeQueues.get(key) === nextPromise) {
          queryClient.setQueryData<Record<string, unknown>>(['preferences'], (cached) => ({
            ...(cached ?? {}),
            [key]: previous,
          }));
        }
      });
    writeQueues.set(key, nextPromise);
    // The queue holds the write itself; the caller gets the outcome of it. Reading `ok` when this
    // resolves is safe because the flag is set by the catch that has to have run first.
    return nextPromise.then(() => ({ ok }));
  }, [key, message, queryClient]);

  return { value, ready: !isPending || isError, set };
}
