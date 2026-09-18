import {
  USAGE_MULTI_FILTER_KEYS,
  USAGE_RANGE_FILTER_KEYS,
  USAGE_RANGE_MAX,
  USAGE_TEXT_FILTER_KEYS,
  compareCostBounds,
  formatUsageRangeBound,
  isCostRange,
  parseUsageRangeBound,
  usageRangeParamKey,
} from './usageEvents';
import type {
  RangeBound,
  UsageEventQuery,
  UsageFacetValue,
  UsageResultFilter,
  UsageMultiFilterKey,
  UsageRangeFilterKey,
  UsageTextFilterKey,
} from './usageEvents';

/** Re-exported for the filter panel, which is the only consumer of all three. */
export { USAGE_RANGE_MAX, parseUsageRangeBound };

export type { RangeBound };

export const EVENT_PRESETS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
  '90d': 90 * 24 * 60 * 60_000,
};

/**
 * EVENT_FILTER_KEYS is every parameter the request console's filter panel owns,
 * in the order the panel presents them. Anything outside this list is left
 * alone by reset, so a drill-down's unrelated parameters survive.
 */
export const EVENT_FILTER_KEYS = [
  ...USAGE_MULTI_FILTER_KEYS,
  ...USAGE_TEXT_FILTER_KEYS,
  ...USAGE_RANGE_FILTER_KEYS.flatMap((range) => [
    usageRangeParamKey(range, 'min'),
    usageRangeParamKey(range, 'max'),
  ]),
  'cost',
] as const;

export type EventFilterKey = (typeof EVENT_FILTER_KEYS)[number];

/** Check if the given URL search parameters contain any explicit event query keys */
export function hasExplicitEventQuery(params: URLSearchParams): boolean {
  if (params.has('preset') || params.has('from') || params.has('to') || params.has('result') || params.has('limit')) {
    return true;
  }
  for (const key of EVENT_FILTER_KEYS) {
    if (params.has(key)) return true;
  }
  return false;
}

/**
 * readEventQuery normalises the URL into the query the endpoint understands.
 * The URL is the single source of truth, including dashboard drill-downs and
 * Back, so an out-of-range or malformed parameter is dropped rather than
 * rendered as a filter that silently matches nothing.
 */
export function readEventQuery(params: URLSearchParams): UsageEventQuery {
  const preset = params.get('preset') || '1h';
  const result = params.get('result');
  const cost = params.get('cost');
  const limit = Number(params.get('limit') || 100);
  const query: UsageEventQuery = {
    preset: Object.prototype.hasOwnProperty.call(EVENT_PRESETS, preset) ? preset : '1h',
    result: (result === 'success' || result === 'failed' ? result : 'all') as UsageResultFilter,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100,
  };
  if (cost === 'priced' || cost === 'unpriced') query.cost = cost;

  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  if (params.has('from') && Number.isSafeInteger(from) && from >= 0) {
    if (!params.has('to')) query.from = from;
    else if (Number.isSafeInteger(to) && to > from) {
      query.from = from;
      query.to = to;
    }
  }

  const filters: Partial<Record<UsageMultiFilterKey, string[]>> = {};
  for (const key of USAGE_MULTI_FILTER_KEYS) {
    const values: string[] = [];
    for (const raw of params.getAll(key)) {
      const trimmed = raw.trim();
      if (trimmed && !values.includes(trimmed)) values.push(trimmed);
    }
    if (values.length) filters[key] = values;
  }
  if (Object.keys(filters).length) query.filters = filters;

  const text: Partial<Record<UsageTextFilterKey, string>> = {};
  for (const key of USAGE_TEXT_FILTER_KEYS) {
    const trimmed = (params.get(key) ?? '').trim();
    if (trimmed) text[key] = trimmed;
  }
  if (Object.keys(text).length) query.text = text;

  const ranges: Partial<Record<UsageRangeFilterKey, { min?: RangeBound; max?: RangeBound }>> = {};
  for (const range of USAGE_RANGE_FILTER_KEYS) {
    const bounds: { min?: RangeBound; max?: RangeBound } = {};
    for (const side of ['min', 'max'] as const) {
      const parsed = parseUsageRangeBound(range, params.get(usageRangeParamKey(range, side)));
      if (parsed !== undefined) bounds[side] = parsed;
    }
    // A reversed range cannot match any record, so it is dropped instead of
    // being sent as a filter that renders a guaranteed-empty list. A cost pair is
    // compared on its scaled digits, so two bounds differing in the ninth decimal
    // are ordered correctly rather than through a double approximation.
    if (bounds.min !== undefined && bounds.max !== undefined) {
      const order = isCostRange(range)
        ? compareCostBounds(String(bounds.min), String(bounds.max))
        : Number(bounds.min) - Number(bounds.max);
      if (order > 0) continue;
    }
    if (bounds.min !== undefined || bounds.max !== undefined) ranges[range] = bounds;
  }
  if (Object.keys(ranges).length) query.ranges = ranges;

  return query;
}

/**
 * queryToFilterParams flattens a normalised query back into the flat wire-keyed
 * map the chips and the preference document are built from.
 *
 * Deriving both from the *complete* normalised query - rather than from a
 * partial set of overrides merged into the previous state - is what keeps a
 * removal and an addition in the same edit from resurrecting the removed value.
 */
export function queryToFilterParams(query: UsageEventQuery): Partial<Record<EventFilterKey, string[]>> {
  const result: Partial<Record<EventFilterKey, string[]>> = {};
  for (const key of USAGE_MULTI_FILTER_KEYS) {
    const values = query.filters?.[key];
    if (values?.length) result[key] = [...values];
  }
  for (const key of USAGE_TEXT_FILTER_KEYS) {
    const value = query.text?.[key];
    if (value) result[key] = [value];
  }
  for (const range of USAGE_RANGE_FILTER_KEYS) {
    const bounds = query.ranges?.[range];
    if (bounds?.min !== undefined)
      result[usageRangeParamKey(range, 'min')] = [formatUsageRangeBound(bounds.min)];
    if (bounds?.max !== undefined)
      result[usageRangeParamKey(range, 'max')] = [formatUsageRangeBound(bounds.max)];
  }
  if (query.cost === 'priced' || query.cost === 'unpriced') result.cost = [query.cost];
  return result;
}

/**
 * filterParamsToUrl serialises the flat filter map into repeated search
 * parameters. It is the inverse of queryToFilterParams and shares the
 * single-value-per-text-key rule, so a round trip through either is stable.
 */
export function filterParamsToUrl(values: Partial<Record<EventFilterKey, string[]>>): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of EVENT_FILTER_KEYS) {
    for (const value of values[key] ?? []) {
      if (value) params.append(key, value);
    }
  }
  return params;
}

/**
 * readFilterParams reads the flat filter map straight from the URL, which is
 * what the chips and the preference document are built from. It goes through the
 * same normalisation as readEventQuery so the chips can never show a filter the
 * query did not actually apply.
 */
export function readFilterParams(params: URLSearchParams): Partial<Record<EventFilterKey, string[]>> {
  return queryToFilterParams(readEventQuery(params));
}

/**
 * rejectedEventParams names the query parameters present in the URL that
 * normalisation refused to apply.
 *
 * Dropping a filter is not a neutral act: an operator who mistypes a bound would
 * otherwise see a *wider* result set than they asked for while the panel still
 * shows a narrowed view. The page runs the filters that are usable and reports the
 * rest, so an ignored parameter can never be silent.
 */
export function rejectedEventParams(params: URLSearchParams): string[] {
  const rejected: string[] = [];
  for (const key of EVENT_FILTER_KEYS) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') continue;
    const range = USAGE_RANGE_FILTER_KEYS.find(
      (candidate) =>
        usageRangeParamKey(candidate, 'min') === key || usageRangeParamKey(candidate, 'max') === key,
    );
    if (range) {
      if (parseUsageRangeBound(range, raw) === undefined) rejected.push(key);
      continue;
    }
    if (key === 'cost') {
      const value = raw.trim();
      if (value !== 'priced' && value !== 'unpriced') rejected.push(key);
      continue;
    }
    // Every other dimension is a literal string, so it is unusable only when it is
    // longer than any stored value could be.
    if (raw.trim().length > 256) rejected.push(key);
  }

  // A reversed pair is reported once, under the dimension rather than under both
  // ends: the operator made one mistake, not two.
  for (const range of USAGE_RANGE_FILTER_KEYS) {
    const min = parseUsageRangeBound(range, params.get(usageRangeParamKey(range, 'min')));
    const max = parseUsageRangeBound(range, params.get(usageRangeParamKey(range, 'max')));
    if (min === undefined || max === undefined) continue;
    const reversed = isCostRange(range)
      ? compareCostBounds(String(min), String(max)) > 0
      : Number(min) > Number(max);
    if (reversed && !rejected.includes(range)) rejected.push(range);
  }

  const preset = params.get('preset');
  if (preset !== null && !Object.prototype.hasOwnProperty.call(EVENT_PRESETS, preset)) {
    rejected.push('preset');
  }
  const result = params.get('result');
  if (result !== null && result !== 'all' && result !== 'success' && result !== 'failed') {
    rejected.push('result');
  }
  return [...new Set(rejected)];
}

/**
 * mergeFacetOptions guarantees a selected value still appears in a dropdown.
 *
 * Facets are capped at 200 values and are computed for a window, so a value that
 * was selected earlier - or that arrived from a drill-down link - can be missing
 * from the current response. Leaving it out renders a blank control and lets the
 * operator believe the filter was dropped, while the query still applies it.
 */
export function mergeFacetOptions(
  values: readonly UsageFacetValue[] | undefined,
  selected: readonly string[],
  label: (value: UsageFacetValue) => string,
  describeSelected?: (value: string) => string,
): Array<{ value: string; label: string }> {
  const options = (values ?? []).map((entry) => ({ value: entry.value, label: label(entry) }));
  const known = new Set(options.map((option) => option.value));
  for (const value of selected) {
    if (known.has(value)) continue;
    known.add(value);
    options.push({ value, label: describeSelected ? describeSelected(value) : value });
  }
  return options;
}

/**
 * activeFilterCount counts the committed filter dimensions that are narrowing
 * the list, so the panel can report how much is hidden behind it. A dimension
 * counts once however many values it holds: "2 models" is one decision.
 */
export function activeFilterCount(filterValues: Partial<Record<EventFilterKey, string[]>>): number {
  let count = 0;
  for (const key of EVENT_FILTER_KEYS) {
    if ((filterValues[key]?.length ?? 0) > 0) count += 1;
  }
  return count;
}

/**
 * eventWindow freezes the window across cursor navigation so paging cannot walk
 * across a boundary that is still moving. An open-ended custom range keeps
 * following the clock, which is what makes it worth polling.
 */
export function eventWindow(query: UsageEventQuery, now: number) {
  return query.from !== undefined
    ? { from: query.from, to: Math.min(query.to ?? now, now) }
    : { from: now - (EVENT_PRESETS[query.preset || '1h'] ?? EVENT_PRESETS['1h']), to: now };
}
