import { useT } from '../i18n';
import React from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, apiErrorCode, describeError } from '../api/client';
import { QUERY_KEYS } from '../api/queryKeys';
import { useToast } from '../components/feedback';

export interface Preference<T> {
  value: T;
  /** False until the stored value has been read, so a page can wait instead of painting a default and correcting it. */
  ready: boolean;
  /**
   * True once the stored document has been read. Unlike `ready`, a failed read leaves it false:
   * a caller whose write is derived from the stored value must not build one on the fallback.
   */
  loaded: boolean;
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
const writeSeq = new Map<string, number>();
const deferredReconcileKeys = new WeakMap<QueryClient, Set<string>>();
const pendingReconcileKeys = new WeakMap<QueryClient, Set<string>>();
const reconcileGeneration = new WeakMap<QueryClient, number>();

function queueDeferredReconcile(queryClient: QueryClient, key: string): void {
  let keys = deferredReconcileKeys.get(queryClient);
  if (!keys) {
    keys = new Set<string>();
    deferredReconcileKeys.set(queryClient, keys);
  }
  keys.add(key);
}

function arePreferenceValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => arePreferenceValuesEqual(item, right[index]));
  }
  const leftObj = left as Record<string, unknown>;
  const rightObj = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObj);
  const rightKeys = Object.keys(rightObj);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (prop) => Object.prototype.hasOwnProperty.call(rightObj, prop) && arePreferenceValuesEqual(leftObj[prop], rightObj[prop]),
  );
}

/**
 * Reconciles selected server-side preference keys into an already-loaded preferences cache
 * without overwriting unrelated keys or any key whose local write is currently in flight.
 */
export async function reconcilePreferenceKeys(
  queryClient: QueryClient,
  keys: readonly string[],
  depth = 0,
): Promise<void> {
  if (keys.length === 0) return;
  const initialCached = queryClient.getQueryData<Record<string, unknown>>(QUERY_KEYS.preferences);
  if (!initialCached) return;

  let activeSet = pendingReconcileKeys.get(queryClient);
  if (!activeSet) {
    activeSet = new Set<string>();
    pendingReconcileKeys.set(queryClient, activeSet);
  }
  for (const key of keys) activeSet.add(key);

  const idleKeys: string[] = [];
  for (const key of activeSet) {
    if (writeQueues.has(key)) {
      queueDeferredReconcile(queryClient, key);
    } else {
      idleKeys.push(key);
    }
  }
  if (idleKeys.length === 0) {
    activeSet.clear();
    return;
  }

  const generation = (reconcileGeneration.get(queryClient) ?? 0) + 1;
  reconcileGeneration.set(queryClient, generation);

  const seqBefore = new Map<string, number>();
  const snapshotBefore = new Map<string, unknown>();
  for (const key of idleKeys) {
    seqBefore.set(key, writeSeq.get(key) ?? 0);
    snapshotBefore.set(key, initialCached[key]);
  }

  let fresh: Record<string, unknown>;
  try {
    fresh = await api.getPreferences();
  } catch {
    if (reconcileGeneration.get(queryClient) === generation) {
      activeSet.clear();
    }
    return;
  }

  if (reconcileGeneration.get(queryClient) !== generation) {
    return;
  }
  activeSet.clear();

  const retryLater: string[] = [];
  queryClient.setQueryData<Record<string, unknown>>(QUERY_KEYS.preferences, (cached) => {
    if (!cached) return cached;
    let next: Record<string, unknown> | undefined;
    for (const key of idleKeys) {
      const localWriteStarted =
        writeQueues.has(key) ||
        (writeSeq.get(key) ?? 0) !== seqBefore.get(key) ||
        !arePreferenceValuesEqual(cached[key], snapshotBefore.get(key));
      if (localWriteStarted) {
        if (writeQueues.has(key)) {
          queueDeferredReconcile(queryClient, key);
        } else {
          retryLater.push(key);
        }
        continue;
      }
      const freshValue = fresh[key];
      if (!arePreferenceValuesEqual(cached[key], freshValue)) {
        next ??= { ...cached };
        if (freshValue === undefined) {
          delete next[key];
        } else {
          next[key] = freshValue;
        }
      }
    }
    return next ?? cached;
  });

  if (retryLater.length > 0 && depth < 1) {
    await reconcilePreferenceKeys(queryClient, retryLater, depth + 1);
  }
}

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
  const toast = useToast();
  const t = useT();
  const queryClient = useQueryClient();
  const selectPreference = React.useCallback((preferences: Record<string, unknown>) => preferences[key], [key]);
  const { data: raw, isPending, isError, isSuccess } = useQuery({
    queryKey: ['preferences'],
    queryFn: api.getPreferences,
    select: selectPreference,
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
  const stored = React.useMemo(() => parse(raw), [key, raw, parse]);
  const value = stored ?? fallback;

  const set = React.useCallback((next: T) => {
    // The optimistic value, captured *before* the cache write so a failed save
    // can be undone. It is the newest local opinion at this moment - either the
    // server's last known value or an earlier write that has not settled yet -
    // which is exactly what the control must fall back to when the server
    // refuses this one.
    const previous = queryClient.getQueryData<Record<string, unknown>>(QUERY_KEYS.preferences)?.[key];
    queryClient.setQueryData<Record<string, unknown>>(QUERY_KEYS.preferences, (cached) => ({
      ...(cached ?? {}),
      [key]: next,
    }));
    writeSeq.set(key, (writeSeq.get(key) ?? 0) + 1);
    const previousPromise = writeQueues.get(key) ?? Promise.resolve();
    let ok = true;
    const nextPromise = previousPromise
      .catch(() => {})
      .then(() => api.putPreference(key, next))
      .catch((err: unknown) => {
        ok = false;
        const code = apiErrorCode(err) || describeError(err);
        const iconErrorKey = code === 'custom_icon_not_found' ? 'icons.error_missing' : code === 'custom_icon_invalid_name' ? 'icons.error_name' : undefined;
        const fontErrorKey = code === 'font_not_found' || code === 'font_invalid_reference' ? 'omc.font_error_missing' : undefined;
        const settingErrorKey = code === 'invalid_timezone'
          ? 'omc.timezone_invalid'
          : code === 'display_currency_unavailable'
            ? 'omc.exchange_missing'
            : code === 'invalid_quota_auto_refresh'
              ? 'omc.quota_auto_refresh_invalid'
              : code === 'invalid_update_check'
                ? 'omc.update_check_invalid'
                : code === 'invalid_exchange_rate_refresh'
                  ? 'omc.exchange_rate_refresh_invalid'
                  : iconErrorKey ?? fontErrorKey;
        toast.error(settingErrorKey ? t(settingErrorKey) : describeError(err));
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
          queryClient.setQueryData<Record<string, unknown>>(QUERY_KEYS.preferences, (cached) => ({
            ...(cached ?? {}),
            [key]: previous,
          }));
        }
      })
      .finally(() => {
        if (writeQueues.get(key) === nextPromise) {
          writeQueues.delete(key);
          const deferred = deferredReconcileKeys.get(queryClient);
          if (deferred?.delete(key)) {
            void reconcilePreferenceKeys(queryClient, [key]);
          }
        }
      });
    writeQueues.set(key, nextPromise);
    // The queue holds the write itself; the caller gets the outcome of it. Reading `ok` when this
    // resolves is safe because the flag is set by the catch that has to have run first.
    return nextPromise.then(() => ({ ok }));
  }, [key, toast, queryClient, t]);

  return { value, ready: !isPending || isError, loaded: isSuccess, set };
}
