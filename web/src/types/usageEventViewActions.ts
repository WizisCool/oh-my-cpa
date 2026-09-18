import type { EventFilterKey } from './usageEventQuery';
import {
  EVENT_FILTER_KEYS,
  filterParamsToUrl,
  readEventQuery,
  queryToFilterParams,
} from './usageEventQuery';
import type { UsageEventsViewPreference } from './usageEventViewPreference';
import type { UsageResultFilter } from './usageEvents';

/**
 * The policies behind the request-record view, expressed without React.
 *
 * Each of these was a rule inside `UsageEventsPage` that could only be checked by
 * driving a browser: which parameters a filter edit rewrites, what a clear-all
 * preserves, and how the saved view is derived from the URL that is actually being
 * navigated to. The page keeps the wiring - it still owns `useSearchParams`, the
 * TanStack queries and the components - and calls these for the decisions.
 *
 * They are separate from the page because a rule that is only reachable through a
 * rendered page cannot be tested at the level it is actually about, and because
 * two of them (the clear-all rewrite and the saved-view derivation) exist to
 * prevent a regression that a browser can only reproduce by luck.
 */

/**
 * replaceFilters rewrites the filter dimensions of a URL, leaving everything else
 * alone.
 *
 * Every filter dimension is deleted and the supplied map is re-appended, rather
 * than being merged key by key. A removal has to be expressible, and the way
 * "this dimension is not filtering" is expressed everywhere is *absence* - so an
 * edit has to be able to take a key away, which a merge cannot do. The window,
 * the page size and the cursor are untouched: a filter change never silently moves
 * the reader to a different hour.
 *
 * The result verdict rides alongside rather than inside the map because it is a
 * top-level query field rather than a repeated dimension, so a caller can change
 * it in the same edit. `undefined` leaves it as it was.
 */
export function replaceFilters(
  current: URLSearchParams,
  filters: Partial<Record<EventFilterKey, string[]>>,
  options: { result?: UsageResultFilter } = {},
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of EVENT_FILTER_KEYS) next.delete(key);
  filterParamsToUrl(filters).forEach((value, key) => next.append(key, value));
  if (options.result !== undefined) {
    if (options.result === 'all') next.delete('result');
    else next.set('result', options.result);
  }
  return next;
}

/**
 * clearAllFilters drops every filter and the result verdict while keeping the
 * reader's window, page size and cursor.
 *
 * Clear-all is offered from two places and has to mean one thing: the filters go,
 * the window and the layout choices stay. Resetting the window too would move the
 * reader to a different hour without saying so, which reads as a bug rather than
 * as a reset.
 */
export function clearAllFilters(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of EVENT_FILTER_KEYS) next.delete(key);
  next.delete('result');
  return next;
}

/**
 * applyTimeWindow replaces the window dimensions of a URL.
 *
 * A preset and an absolute range are mutually exclusive: the URL carries one or
 * the other, never both, because a reader that saw both would have no way to tell
 * which one the query applied. An absolute range with no end is open-ended rather
 * than invalid - the console polls it like a preset and its end tracks now.
 */
export function applyTimeWindow(
  current: URLSearchParams,
  window: { preset?: string; from?: number; to?: number },
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete('preset');
  next.delete('from');
  next.delete('to');
  if (window.from !== undefined) {
    next.set('from', String(window.from));
    if (window.to !== undefined) next.set('to', String(window.to));
  } else if (window.preset) {
    next.set('preset', window.preset);
  }
  return next;
}

/**
 * mergeFilters folds one dimension into the committed filter map.
 *
 * An empty list removes the dimension instead of storing an empty one, so a
 * cleared field cannot come back as a parameter that still applies. The input is
 * not mutated: the caller's committed map is read from the URL on every render
 * and writing through it would make the next read disagree with the URL.
 */
export function mergeFilters(
  committed: Partial<Record<EventFilterKey, string[]>>,
  key: EventFilterKey,
  values: string[],
): Partial<Record<EventFilterKey, string[]>> {
  const next = { ...committed };
  if (values.length) next[key] = values;
  else delete next[key];
  return next;
}

/**
 * viewPreferenceFromUrl derives the saved view from the URL that is actually being
 * navigated to.
 *
 * It takes the complete next state and derives every field from it, rather than
 * accepting partial overrides merged into the previous query. That merge is the
 * bug this replaces: a cleared filter arrived as `{ model: undefined }`, the
 * fallback then read the model out of the still-old query, and the removed value
 * was written straight back into storage and reappeared on the next visit.
 * Deriving everything from one normalised state removes the class of bug rather
 * than the instance.
 *
 * `cost` is excluded from the stored filter map because it is persisted as its own
 * field; keeping it in both was a second source of truth that hydration wrote back
 * into the URL a second time.
 */
export function viewPreferenceFromUrl(
  nextParams: URLSearchParams,
  current: { grouping: UsageEventsViewPreference['grouping']; autoRefresh: boolean },
): UsageEventsViewPreference {
  const nextQuery = readEventQuery(nextParams);
  const nextPref: UsageEventsViewPreference = {
    result: nextQuery.result,
    limit: nextQuery.limit,
    grouping: current.grouping,
    autoRefresh: current.autoRefresh,
  };
  if (nextQuery.cost === 'priced' || nextQuery.cost === 'unpriced') nextPref.cost = nextQuery.cost;
  if (nextQuery.from !== undefined) {
    nextPref.from = nextQuery.from;
    if (nextQuery.to !== undefined) nextPref.to = nextQuery.to;
  } else {
    nextPref.preset = nextQuery.preset ?? '1h';
  }
  const filterValues = queryToFilterParams(nextQuery);
  delete filterValues.cost;
  if (Object.keys(filterValues).length) nextPref.filterValues = filterValues;
  return nextPref;
}
