import {
  EVENT_FILTER_KEYS,
  EVENT_PRESETS,
} from './usageEventQuery';
import type { EventFilterKey } from './usageEventQuery';
import type {
  UsageCostFilter,
  UsageResultFilter,
} from './usageEvents';

export const USAGE_EVENTS_VIEW_PREFERENCE = 'usage_events_view';

/**
 * The groupings the console offers.
 *
 * `source` merges what used to be two modes, "by provider" and "by auth
 * source". They were not really alternatives - a provider whose records arrive
 * through three credentials has three source lines, and a provider with one
 * credential has no credential worth naming - so one mode keeps the provider
 * context and separates the credential underneath it. `ua` is the client the
 * request came from, which answers "which tool is doing this" and is orthogonal
 * to both.
 */
export const EVENT_GROUPING_VALUES = ['time', 'source', 'ua'] as const;

export type EventGrouping = (typeof EVENT_GROUPING_VALUES)[number];

/**
 * Groupings written by an earlier revision.
 *
 * `provider` and `credential` both described the provider-and-credential pair
 * `source` now means, so a saved view keeps its shape instead of silently
 * reverting to chronological order - which a returning operator would read as
 * their preference having been forgotten. Keyed by stored string rather than by
 * type because the values it names are no longer in the union.
 */
const LEGACY_EVENT_GROUPINGS: Record<string, EventGrouping> = {
  provider: 'source',
  credential: 'source',
};

/**
 * parseEventGrouping reads a stored grouping, migrating the retired modes.
 *
 * Anything unrecognised becomes `time` rather than being rejected: recording
 * order is the mode that never hides records, so an unreadable preference always
 * falls back to something honest.
 */
export function parseEventGrouping(raw: unknown): EventGrouping {
  const value = String(raw ?? '');
  if ((EVENT_GROUPING_VALUES as readonly string[]).includes(value)) return value as EventGrouping;
  return LEGACY_EVENT_GROUPINGS[value] ?? 'time';
}

/**
 * The persisted view excludes the reader's layout preferences and the time
 * window **only where it is a preset**; `filterValues` holds the committed
 * filters by their wire key so a cleared dimension is absent rather than stale.
 */
export interface UsageEventsViewPreference {
  preset?: string;
  from?: number;
  to?: number;
  result?: UsageResultFilter;
  cost?: UsageCostFilter;
  limit?: number;
  /** Committed filter values, keyed by wire parameter. Multi-value dimensions
   *  hold every selected value; a key with no values is omitted entirely. */
  filterValues?: Partial<Record<EventFilterKey, string[]>>;
  grouping?: EventGrouping;
  autoRefresh?: boolean;
}

export const DEFAULT_USAGE_EVENTS_VIEW: UsageEventsViewPreference = {
  preset: '1h',
  result: 'all',
  limit: 100,
  grouping: 'time',
  autoRefresh: false,
};

/**
 * parseUsageEventsView validates a stored view preference document.
 *
 * It also migrates the older flat shape, where each single-value filter was a
 * top-level string property (`{ model: 'gpt-5' }`). Those documents are still on
 * disk, and dropping them would silently reset a returning operator's filters to
 * the default window — the exact opposite of what persistence is for. A legacy
 * scalar becomes a one-element list, because that is what it always meant.
 */
export function parseUsageEventsView(raw: unknown): UsageEventsViewPreference | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const val = raw as Record<string, unknown>;

  const grouping = parseEventGrouping(val.grouping);

  const autoRefresh = val.autoRefresh === true;

  const resultVal = String(val.result ?? '');
  const result: UsageResultFilter = resultVal === 'success' || resultVal === 'failed' ? resultVal : 'all';

  const costVal = String(val.cost ?? '');
  const cost: UsageCostFilter = costVal === 'priced' || costVal === 'unpriced' ? costVal : 'all';
  const limitNum = Number(val.limit);
  const limit = Number.isInteger(limitNum) && limitNum > 0 ? Math.min(Math.max(limitNum, 1), 500) : 100;

  const pref: UsageEventsViewPreference = {
    result,
    limit,
    grouping,
    autoRefresh,
  };

  const from = Number(val.from);
  const to = Number(val.to);
  if (val.from !== undefined && Number.isSafeInteger(from) && from >= 0) {
    pref.from = from;
    if (val.to !== undefined && Number.isSafeInteger(to) && to > from) {
      pref.to = to;
    }
  } else {
    const presetStr = String(val.preset ?? '1h');
    pref.preset = Object.prototype.hasOwnProperty.call(EVENT_PRESETS, presetStr) ? presetStr : '1h';
  }

  const stored = val.filterValues;
  const storedRecord =
    typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : undefined;

  /** Reads one dimension out of the new shape, falling back to the legacy flat
   *  property of the same name. */
  const storedValues = (key: EventFilterKey): string[] => {
    const source = storedRecord ? storedRecord[key] : val[key];
    const values: string[] = [];
    for (const candidate of Array.isArray(source) ? source : [source]) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (trimmed && !values.includes(trimmed)) values.push(trimmed);
    }
    return values;
  };

  // Cost is normalised here, once. It is persisted as its own field, and a document
  // may carry it in any of three shapes: the current top-level field, a nested copy
  // written by an earlier revision, or the legacy flat property. A valid top-level
  // value wins. Failing that, a nested **singleton** is adopted: two contradictory
  // values mean the document cannot be trusted, and guessing one would apply a
  // filter the operator may never have chosen.
  let resolvedCost = cost;
  if (resolvedCost === 'all') {
    const nested = [...new Set(storedValues('cost'))].filter(
      (candidate) => candidate === 'priced' || candidate === 'unpriced',
    );
    if (nested.length === 1) resolvedCost = nested[0] as UsageCostFilter;
  }
  if (resolvedCost !== 'all') pref.cost = resolvedCost;

  const filterValues: Partial<Record<EventFilterKey, string[]>> = {};
  for (const key of EVENT_FILTER_KEYS) {
    // Cost never appears inside the map: it has exactly one representation, which
    // is the top-level field settled above.
    if (key === 'cost') continue;
    const values = storedValues(key);
    if (values.length) filterValues[key] = values;
  }
  if (Object.keys(filterValues).length) pref.filterValues = filterValues;

  return pref;
}
