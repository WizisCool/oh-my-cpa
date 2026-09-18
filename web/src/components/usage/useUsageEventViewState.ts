import React from 'react';

import { useSearchParams } from 'react-router-dom';

import { usePreference } from '../../hooks/usePreference';
import {
  activeFilterCount,
  filterParamsToUrl,
  hasExplicitEventQuery,
  readEventQuery,
  readFilterParams,
  rejectedEventParams,
  type EventFilterKey,
} from '../../types/usageEventQuery';
import type { UsageEventsView } from '../../types/usageEventFilters';
import {
  applyTimeWindow,
  clearAllFilters,
  mergeFilters,
  replaceFilters,
  viewPreferenceFromUrl,
} from '../../types/usageEventViewActions';
import {
  DEFAULT_USAGE_EVENTS_VIEW,
  USAGE_EVENTS_VIEW_PREFERENCE,
  parseUsageEventsView,
  type EventGrouping,
  type UsageEventsViewPreference,
} from '../../types/usageEventViewPreference';
import type { UsageResultFilter } from '../../types/usageEvents';
import { useDebouncedSearch } from './useDebouncedSearch';

/**
 * The request console's view state: the URL the filters and the window live in,
 * the filter map derived from it, the saved view the operator's choices are
 * persisted to, and the search box's debounce.
 *
 * They are one hook because every one of them is a rewrite of the same URL: a
 * keystroke, a chip removal, a clear-all, a window change and a page-size change
 * all have to leave the saved view describing the URL that is actually being
 * navigated to, and a queued keystroke has to be discarded by the same events
 * that discard the filter it was typed against.
 *
 * It is a hook rather than a policy module because of the search box's
 * controller: `useDebouncedSearch` needs an effect-scoped lifetime, and the
 * order of its effects relative to the external-URL-change effect is what stops a
 * Back from being overwritten by a keystroke that belonged to the previous view.
 */
export function useUsageEventViewState() {

  const [params, setParams] = useSearchParams();
  const signature = params.toString();
  const query = React.useMemo(() => readEventQuery(new URLSearchParams(signature)), [signature]);

  const { value: viewPref, ready: prefReady, set: setViewPref } = usePreference<UsageEventsViewPreference>(
    USAGE_EVENTS_VIEW_PREFERENCE,
    DEFAULT_USAGE_EVENTS_VIEW,
    parseUsageEventsView,
  );

  // Initial URL check: did the user enter with explicit query params (e.g. from dashboard drill-down)?
  const initialParamsRef = React.useRef(params);
  const hasExplicit = React.useMemo(() => hasExplicitEventQuery(initialParamsRef.current), []);
  const [hydrated, setHydrated] = React.useState(hasExplicit);

  const [isAutoRefresh, setIsAutoRefresh] = React.useState(false);

  // Bumped whenever filters are discarded on the operator's behalf, so a text
  // filter with a queued keystroke cannot commit after the discard.
  const [searchResetToken, setSearchResetToken] = React.useState(0);
  const [grouping, setGrouping] = React.useState<EventGrouping>('time');

  // The flat committed filter map, derived from the URL through the same
  // normalisation the request itself uses. Chips and persistence both read it,
  // so a chip can never describe a filter the query did not apply.
  const committedParams = React.useMemo(() => readFilterParams(params), [signature]);
  const rejectedParams = React.useMemo(() => rejectedEventParams(params), [signature]);
  const committedView = React.useMemo<UsageEventsView>(
    () => ({ result: query.result ?? 'all', params: committedParams }),
    [query.result, committedParams],
  );
  const filterCount = activeFilterCount(committedParams);

  /**
   * Every local URL write records its signature first, so the effect below can tell
   * a change this page made from one that arrived from outside it. Without that
   * distinction a keystroke queued behind the debounce would survive a Back or a
   * drill-down and be written onto the view the operator navigated to.
   */
  const selfWrittenSignatureRef = React.useRef<string | null>(null);
  const writeParams = React.useCallback(
    (next: URLSearchParams) => {
      selfWrittenSignatureRef.current = next.toString();
      setParams(next, { replace: true });
    },
    [setParams],
  );

  React.useEffect(() => {
    if (selfWrittenSignatureRef.current === signature) return;
    // A URL this page did not write: history navigation, a drill-down link, or a
    // pasted address. A pending keystroke belongs to the view that was just left.
    setSearchResetToken((value) => value + 1);
  }, [signature]);

  // One-time hydration from server preferences when entering bare route without query parameters
  React.useEffect(() => {
    if (!prefReady || hydrated) return;
    setHydrated(true);
    if (viewPref.grouping) setGrouping(viewPref.grouping);
    if (typeof viewPref.autoRefresh === 'boolean') setIsAutoRefresh(viewPref.autoRefresh);

    if (!hasExplicit) {
      const nextParams = new URLSearchParams();
      if (viewPref.from !== undefined) {
        nextParams.set('from', String(viewPref.from));
        if (viewPref.to !== undefined) nextParams.set('to', String(viewPref.to));
      } else if (viewPref.preset && viewPref.preset !== '1h') {
        nextParams.set('preset', viewPref.preset);
      }
      if (viewPref.result && viewPref.result !== 'all') {
        nextParams.set('result', viewPref.result);
      }
      if (viewPref.limit && viewPref.limit !== 100) {
        nextParams.set('limit', String(viewPref.limit));
      }
      if (viewPref.cost && viewPref.cost !== 'all') {
        nextParams.set('cost', viewPref.cost);
      }
      // `cost` is a top-level query field, not a repeated filter dimension, so it
      // travels as its own parameter. It must not also be replayed from the stored
      // filter map, or the URL would carry it twice.
      const storedFilters = filterParamsToUrl({
        ...(viewPref.filterValues ?? {}),
        cost: undefined,
      });
      storedFilters.forEach((value, key) => nextParams.append(key, value));
      if (nextParams.toString()) {
        writeParams(nextParams);
      }
    }
  }, [prefReady, hydrated, hasExplicit, viewPref, writeParams]);

  // Restore the layout preferences even when arriving on a drill-down link.
  React.useEffect(() => {
    if (!prefReady || !hasExplicit) return;
    if (viewPref.grouping) setGrouping(viewPref.grouping);
    if (typeof viewPref.autoRefresh === 'boolean') setIsAutoRefresh(viewPref.autoRefresh);
  }, [prefReady, hasExplicit, viewPref.grouping, viewPref.autoRefresh]);

  /**
   * persistView writes the saved view for the *complete* next state.
   *
   * It used to take partial overrides and fall back to the previous query for
   * anything not mentioned. That is what made a cleared filter come back: the
   * override said `{ model: undefined }`, the fallback then read the model out of
   * the still-old `query`, and the removed value was written straight back into
   * storage. Deriving every field from one normalised state removes the class of
   * bug rather than the instance.
   */

  const persistView = React.useCallback(
    (nextParams: URLSearchParams, overrides?: { grouping?: EventGrouping; autoRefresh?: boolean }) => {
      // The saved view is derived from the URL that is actually being navigated to.
      // Deriving every field from one normalised state - rather than merging the
      // changed fields into the previous query - is what stops a cleared filter from
      // being read back out of the query it was removed from and reappearing on the
      // next visit. See `viewPreferenceFromUrl`.
      setViewPref(
        viewPreferenceFromUrl(nextParams, {
          grouping: overrides?.grouping ?? grouping,
          autoRefresh: overrides?.autoRefresh ?? isAutoRefresh,
        }),
      );
    },
    [grouping, isAutoRefresh, setViewPref],
  );

  /**
   * commit applies a filter change. `values` is the complete next filter map, so
   * a removal is expressed by the key being absent rather than by a sentinel.
   * The change is written to the URL and to the saved view together, which is
   * what keeps a reload equivalent to not having reloaded.
   */
  /**
   * Every local URL write records its signature first, so the effect above can tell
   * a change this page made from one that arrived from outside it.
   */
  const commit = React.useCallback(
    (values: Partial<Record<EventFilterKey, string[]>>, options?: { result?: UsageResultFilter; keepWindow?: boolean }) => {
      // The rewrite is defined in `usageEventViewActions`: every filter dimension is
      // replaced wholesale so a removal is expressible, while the window, page size
      // and cursor are left alone.
      const nextParams = replaceFilters(params, values, { result: options?.result });
      writeParams(nextParams);
      persistView(nextParams, { grouping });
    },
    [grouping, params, persistView, writeParams],
  );

  /** setFilter replaces one dimension wholesale. An empty list clears it. */
  const setFilter = React.useCallback(
    (key: EventFilterKey, values: string[]) => {
      commit(mergeFilters(committedParams, key, values));
    },
    [commit, committedParams],
  );

  const removeFilterValue = React.useCallback(
    (key: EventFilterKey, value?: string) => {
      const current = committedParams[key] ?? [];
      // Removing the search chip removes the whole filter, so a keystroke still
      // queued behind the debounce must be dropped with it.
      if (key === 'q') setSearchResetToken((token) => token + 1);
      setFilter(key, value === undefined ? [] : current.filter((entry) => entry !== value));
    },
    [committedParams, setFilter],
  );

  const clearFilters = React.useCallback(() => {
    // Filters and the verdict go; the window, page size and cursor stay. Reset the
    // window too and the reader is silently moved to a different hour.
    const windowOnly = clearAllFilters(params);
    writeParams(windowOnly);
    // Cancels any queued keystroke. The search box's committed value is already
    // empty during a clear, so nothing else would signal that its pending timer
    // must not fire.
    setSearchResetToken((value) => value + 1);
    // Persisted from the URL that is actually being navigated to. Saving the
    // defaults here instead is what reset the operator's window and page size in
    // storage while the URL kept them, so a later reload silently moved them.
    persistView(windowOnly, { grouping });
  }, [grouping, params, persistView, writeParams]);

  const setTimeWindow = React.useCallback(
    (window: { preset?: string; from?: number; to?: number }) => {
      const nextParams = applyTimeWindow(params, window);
      writeParams(nextParams);
      persistView(nextParams, { grouping });
    },
    [grouping, params, persistView, writeParams],
  );

  const [search, setSearch] = useDebouncedSearch(
    committedParams.q?.[0] ?? '',
    (value) => {
      setFilter('q', value ? [value] : []);
    },
    searchResetToken,
  );

  /**
   * setResult commits the result verdict.
   *
   * The verdict is a filter with no parameter of its own, so it rides alongside
   * the filter map rather than inside it - but it is still part of the view, and
   * a list narrowed to failures with no way to clear that from the URL would be a
   * filter the operator could only undo by guessing.
   */
  const setResult = React.useCallback(
    (result: UsageResultFilter) => {
      commit(committedParams, { result });
    },
    [commit, committedParams],
  );

  /**
   * setPageSize rewrites only the page size, and persists it with the rest of the
   * view.
   *
   * 100 is stored as the absence of the parameter, which is what every other
   * default in this view does: a URL that says nothing about the page size and
   * one that names the default have to mean the same thing, or a saved view would
   * carry a value that was never chosen.
   */
  const setPageSize = React.useCallback(
    (nextLimit: number) => {
      const nextParams = new URLSearchParams(params);
      if (nextLimit === 100) nextParams.delete('limit');
      else nextParams.set('limit', String(nextLimit));
      writeParams(nextParams);
      persistView(nextParams, { grouping });
    },
    [grouping, params, persistView, writeParams],
  );

  /** The grouping is a layout choice the saved view carries; see `persistView`. */
  const changeGrouping = React.useCallback(
    (next: EventGrouping) => {
      setGrouping(next);
      persistView(params, { grouping: next });
    },
    [params, persistView],
  );

  /**
   * Discarding filters on the operator's behalf is the one event a queued
   * keystroke cannot observe, so the caller states it rather than relying on
   * inference: see `resetToken` in `useDebouncedSearch`.
   */
  const resetSearchQueue = React.useCallback(() => {
    setSearchResetToken((value) => value + 1);
  }, []);
  const toggleAutoRefresh = React.useCallback(
    (next: boolean) => {
      setIsAutoRefresh(next);
      persistView(params, { grouping, autoRefresh: next });
    },
    [grouping, params, persistView],
  );

  return {
    signature,
    query,
    isEnabled: hasExplicit || prefReady,
    committedParams,
    rejectedParams,
    committedView,
    filterCount,
    search,
    setSearch,
    grouping,
    changeGrouping,
    isAutoRefresh,
    toggleAutoRefresh,
    commit,
    setFilter,
    removeFilterValue,
    clearFilters,
    setTimeWindow,
    setResult,
    setPageSize,
    resetSearchQueue,
  };
}
