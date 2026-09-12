import type {
  RangeBound,
  UsageCostFilter,
  UsageEvent,
  UsageEventQuery,
  UsageFacetValue,
  UsageResultFilter,
  UsageMultiFilterKey,
  UsageRangeFilterKey,
  UsageTextFilterKey,
} from './usageEvents';
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
 * The auto-refresh cadence is fixed, not configurable. The console used to offer
 * 5/10/30-second intervals, which is a setting nobody can evaluate without
 * watching the clock, and the operator only ever wants one of two answers: "keep
 * this current" or "stop moving".
 */
export const EVENT_AUTO_REFRESH_MS = 10_000;

/**
 * How long a manual sync may run before the page says it is still working.
 *
 * A sync pops CPA's queue and waits for the captured records to decode, so it
 * legitimately outlasts a read; a button that only spins gives no way to tell
 * "still draining a backlog" from "stuck on a hung gateway".
 */
export const EVENT_SYNC_NOTICE_MS = 1_500;

/**
 * How long the request console's search box waits after the last keystroke
 * before committing to the URL.
 *
 * Exported rather than inlined because the browser acceptance suite has to time
 * itself against this deadline: it asserts both that a keystroke lands once the
 * debounce elapses and that a keystroke queued when a clear-all arrives never
 * lands at all. A private copy in the test would silently keep asserting against
 * the old cadence after a change here.
 */
export const EVENT_SEARCH_DEBOUNCE_MS = 350;

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

export const USAGE_EVENTS_VIEW_PREFERENCE = 'usage_events_view';

export const EVENT_GROUPING_VALUES = ['time', 'provider', 'credential'] as const;
export type EventGrouping = (typeof EVENT_GROUPING_VALUES)[number];

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

  const grouping = (EVENT_GROUPING_VALUES as readonly string[]).includes(String(val.grouping))
    ? (String(val.grouping) as EventGrouping)
    : 'time';

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

export function eventPageMetrics(events: UsageEvent[]) {
  return {
    count: events.length,
    failed: events.filter((event) => event.failed).length,
    tokens: events.reduce((sum, event) => sum + event.tokens.total, 0),
    latency: events.length ? events.reduce((sum, event) => sum + event.latency_ms, 0) / events.length : null,
  };
}

/** Colour a verdict may carry. Matches the legend-dot tones in the theme. */
export type VerdictTone = 'success' | 'warn' | 'danger' | 'neutral';

/**
 * Share of failures a window may carry before it is worth looking at.
 *
 * A gateway fanning out to several upstreams always produces some noise:
 * provider 429s, a timeout that the next retry absorbs, a request the caller
 * cancelled. At 98% success the old thresholds painted the indicator amber,
 * which trained the operator to ignore it. Upstream noise is not a verdict.
 */
export const SUCCESS_ROUTINE_FAILURE_PERCENT = 5;

/**
 * Share of failures above which the window is treated as broken rather than
 * degraded. Deliberately far from the routine band so the two never blur.
 */
export const SUCCESS_ELEVATED_FAILURE_PERCENT = 20;

/**
 * Requests a window needs before a failure rate may escalate on its own. Two
 * failures out of four is a 50% rate and tells nobody anything, so a window
 * this small stays neutral unless the failure count itself is damning.
 */
export const SUCCESS_VERDICT_MIN_SAMPLE = 20;

/**
 * Failures that make a window conclusive without a full sample. Nine failures
 * out of ten requests is an outage whatever the sample size, and a small window
 * must still be able to say so.
 */
export const SUCCESS_VERDICT_MIN_FAILURES = 3;

/**
 * successRateVerdict decides whether a window needs attention, which is not the
 * same question as whether anything failed.
 *
 * The thresholds are on the *failure* rate rather than the success rate: "98%"
 * is a number nobody reasons about, "2% of requests failed" is a decision.
 *
 *   no traffic                    -> neutral  (nothing to judge)
 *   no failures                   -> success  (clean window)
 *   no evidence yet               -> neutral  (below the sample floor and the
 *                                              failure floor: a coin flip on
 *                                              four requests is not a trend)
 *   within the routine band       -> neutral  (upstream noise)
 *   above the elevated band       -> danger   (broken)
 *   otherwise                     -> warn
 */
export function successRateVerdict(total: number, failed: number): VerdictTone {
  const samples = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (samples === 0) return 'neutral';
  const failures = Number.isFinite(failed) ? Math.min(Math.max(0, Math.floor(failed)), samples) : 0;
  if (failures === 0) return 'success';
  // A verdict needs evidence: either a real sample, or enough failures that the
  // rate cannot be a fluke.
  if (samples < SUCCESS_VERDICT_MIN_SAMPLE && failures < SUCCESS_VERDICT_MIN_FAILURES) return 'neutral';
  const failurePercent = (failures / samples) * 100;
  if (failurePercent <= SUCCESS_ROUTINE_FAILURE_PERCENT) return 'neutral';
  if (failurePercent > SUCCESS_ELEVATED_FAILURE_PERCENT) return 'danger';
  return 'warn';
}

export function formatEventDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export type CredentialFile = {
  name: string;
  auth_index?: string;
  provider?: string;
  type?: string;
  email?: string;
  project_id?: string;
};
export type CredentialIndex = ReadonlyMap<string, CredentialFile | null>;
export type CredentialIdentity = {
  name?: string;
  kind: 'resource' | 'current_file' | 'source' | 'index' | 'unknown';
};

/** Ambiguous indexes must never be guessed, even if one filename looks likely. */
export function indexCredentialFiles(files: readonly CredentialFile[]): CredentialIndex {
  const index = new Map<string, CredentialFile | null>();
  for (const file of files) {
    if (!file.auth_index || !file.name) continue;
    index.set(file.auth_index, index.has(file.auth_index) ? null : file);
  }
  return index;
}

export function resolveCredential(event: UsageEvent, files: CredentialIndex): CredentialIdentity {
  if (event.resource_name?.trim()) return { name: event.resource_name.trim(), kind: 'resource' };
  const file = event.auth_index ? files.get(event.auth_index) : undefined;
  const provider = (file?.provider || file?.type || '').toLowerCase();
  // Never assign a current file belonging to a different provider to history.
  if (file && (!provider || !event.provider || provider === event.provider.toLowerCase()))
    return { name: file.name, kind: 'current_file' };
  if (event.auth_index?.trim()) return { name: event.auth_index.trim(), kind: 'index' };
  if (event.source?.trim()) return { name: event.source.trim(), kind: 'source' };
  return { kind: 'unknown' };
}

export const KNOWN_PROVIDER_ICONS: Record<string, string> = {
  claude: 'Claude',
  anthropic: 'Claude',
  antigravity: 'Antigravity',
  codex: 'Codex',
  xai: 'XAI',
  grok: 'XAI',
  kimi: 'Kimi',
  moonshot: 'Kimi',
  openai: 'OpenAI',
  gemini: 'Gemini',
  google: 'Gemini',
  vertex: 'Google',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  minimax: 'Minimax',
  stepfun: 'Stepfun',
  baichuan: 'Baichuan',
  zhipu: 'Zhipu',
  doubao: 'Doubao',
  spark: 'Spark',
};

export interface EventCacheRateResult {
  rate: number;
  cached: number;
  hasData: boolean;
}

/**
 * eventCacheRate calculates the prompt cache hit percentage matching the dashboard's
 * cacheRateParts convention:
 * - OpenAI-style: input tokens already includes the cached prefix (cache_read <= input)
 * - Anthropic-style: input tokens counts only new tokens, prompt = input + cache_read
 * Returns the raw rate (0..100), the cached token count, and whether the record
 * carried token data at all. Presentation (one decimal, the sub-100% cap, the em
 * dash for no data) lives in theme/cacheScale.ts, which imports nothing so this
 * module stays loadable on its own by the test harness.
 *
 * Cache-write tokens are deliberately not in the denominator. CPA reports them
 * only for providers whose accounting treats cache buckets as separate from
 * input, but the persisted row carries no canonical breakdown to prove which
 * convention produced its raw counts, so widening the denominator here would be
 * a guess. See docs/design.md §2 for the deferred work.
 */
export function eventCacheRate(tokens?: UsageEvent['tokens']): EventCacheRateResult {
  if (!tokens) {
    return { rate: 0, cached: 0, hasData: false };
  }
  const cached = Math.max(0, tokens.cache_read || tokens.cached || 0);
  if (cached === 0) {
    return { rate: 0, cached: 0, hasData: true };
  }
  let prompt = Math.max(0, tokens.input || (tokens.total - tokens.output));
  if (prompt <= 0 && tokens.total > 0) {
    prompt = tokens.total;
  }
  let denominator = prompt;
  if (cached > prompt) {
    denominator = prompt + cached;
  }
  if (denominator <= 0) {
    return { rate: 0, cached: 0, hasData: false };
  }
  const rate = Math.min(100, Math.max(0, (cached / denominator) * 100));
  return { rate, cached, hasData: true };
}

export interface EventTokensPerSecondResult {
  tps: number | null;
  formatted: string;
  hasTTFT: boolean;
}

/**
 * eventTokensPerSecond estimates output generation throughput in tokens per second:
 * - When valid TTFT (0 <= ttft_ms < latency_ms) is available: output * 1000 / (latency_ms - ttft_ms)
 * - Fallback when TTFT is missing: output * 1000 / latency_ms (end-to-end average)
 * - Returns formatted string (e.g. "109.21 t/s") or "—" when not measurable (non-generation, zero output, invalid latency).
 */
export function eventTokensPerSecond(
  event?: Partial<Pick<UsageEvent, 'generate' | 'latency_ms' | 'ttft_ms' | 'tokens'>>,
): EventTokensPerSecondResult {
  if (!event || event.generate === false) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }
  const output = Number(event.tokens?.output);
  if (!Number.isFinite(output) || output <= 0) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }
  const latency = Number(event.latency_ms);
  if (!Number.isFinite(latency) || latency <= 0) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }

  const ttft = event.ttft_ms != null ? Number(event.ttft_ms) : null;
  let durationMs: number;
  let hasTTFT = false;

  if (ttft !== null && Number.isFinite(ttft) && ttft >= 0 && ttft < latency) {
    durationMs = latency - ttft;
    hasTTFT = true;
  } else {
    durationMs = latency;
    hasTTFT = false;
  }

  if (durationMs <= 0) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }

  const tps = (output * 1000) / durationMs;
  return {
    tps,
    formatted: `${tps.toFixed(2)} t/s`,
    hasTTFT,
  };
}

export interface ProviderLookupEntry {
  id: string;
  name: string;
  family?: string;
  auth_index?: string;
  base_url?: string;
}

export interface ResolvedProviderInfo {
  isOAuth: boolean;
  iconId: string;
  title: string;
  subtitle?: string;
  authFile?: string;
  accountIdentity?: string;
}

export function resolveProviderInfo(
  event: UsageEvent,
  credentials: CredentialIndex,
  providerIcons: Record<string, string> = {},
  configuredProviders: ProviderLookupEntry[] = [],
  fallbackIconResolver?: (family: string, name?: string, url?: string) => string,
): ResolvedProviderInfo {
  const file = event.auth_index ? credentials.get(event.auth_index) : undefined;
  const isOAuth =
    event.auth_type?.toLowerCase() === 'oauth' ||
    file?.type?.toLowerCase() === 'oauth' ||
    Boolean(file?.email || file?.project_id);

  const resolveIcon = (family: string, name?: string, url?: string): string => {
    if (fallbackIconResolver) return fallbackIconResolver(family, name, url);
    const key = (family || '').toLowerCase().trim();
    return KNOWN_PROVIDER_ICONS[key] || 'CloudServerOutlined';
  };

  if (isOAuth) {
    const providerFamily = (file?.provider || file?.type || event.provider || 'oauth').toLowerCase();
    const iconId = resolveIcon(providerFamily, file?.name);
    const account = file?.email || file?.project_id;
    const credIdentity = resolveCredential(event, credentials);
    const fileName = credIdentity.name || file?.name || event.source || '';

    // For OAuth: display account identity prominently (e.g. email / project_id / file name)
    const displayName = account || fileName || event.resource_name || event.auth_index || providerFamily;
    const providerLabel = providerFamily ? providerFamily.charAt(0).toUpperCase() + providerFamily.slice(1) : 'OAuth';
    const secondary = `${providerLabel} OAuth`;

    return {
      isOAuth: true,
      iconId,
      title: displayName,
      subtitle: secondary,
      authFile: fileName,
      accountIdentity: account || undefined,
    };
  }

  // AI Provider flow
  // 1. Try exact matches first: auth_index, resource_id, resource_name, id, or name
  let matched = configuredProviders.find(
    (p) =>
      (event.auth_index && p.auth_index === event.auth_index) ||
      (event.resource_id && p.id === event.resource_id) ||
      (event.resource_name && p.name.toLowerCase() === event.resource_name.toLowerCase()) ||
      (p.id && p.id.toLowerCase() === (event.provider || '').toLowerCase()) ||
      (p.name && p.name.toLowerCase() === (event.provider || '').toLowerCase()),
  );

  // 2. If no exact match, check if any unique configured provider's name is contained in event.provider or event.resource_name
  if (!matched && configuredProviders.length > 0) {
    const candidateText = `${event.provider || ''} ${event.resource_name || ''}`.toLowerCase();
    const candidateMatches = configuredProviders.filter(
      (p) => p.name && candidateText.includes(p.name.toLowerCase()),
    );
    if (candidateMatches.length === 1) {
      matched = candidateMatches[0];
    }
  }

  const credIdentity = resolveCredential(event, credentials);
  const fileName = credIdentity.name || event.source || '';

  // Determine clean display name: configured name -> resource name -> cleaned provider text
  let providerName = matched?.name;
  if (!providerName && event.resource_name?.trim()) {
    providerName = event.resource_name.trim();
  }
  if (!providerName && event.provider) {
    // Strip technical prefixes like openai-compatible- and trailing -go/ go
    let cleaned = event.provider.trim().replace(/^openai-compat(ibility|ible)?[-/_\s]*/i, '');
    cleaned = cleaned.replace(/[-_\s]+go$/i, '');
    if (cleaned) {
      providerName = cleaned === cleaned.toLowerCase() ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : cleaned;
    } else {
      providerName = event.provider;
    }
  }
  if (!providerName) {
    providerName = 'Unknown';
  }

  const providerFamily = (matched?.family || event.provider || '').toLowerCase();
  const iconId =
    (matched && (providerIcons[matched.id] || providerIcons[matched.name])) ||
    providerIcons[event.provider] ||
    providerIcons[providerName] ||
    resolveIcon(providerFamily, providerName, matched?.base_url);

  // For AI Providers, show only the clean Name (no technical driver subtitle)
  return {
    isOAuth: false,
    iconId,
    title: providerName,
    subtitle: undefined,
    authFile: fileName,
  };
}

/** api_group_label is a grouping category, NOT a user-assigned API key name.
 *  An api_key group resolves to its display mask, never to the stored
 *  fingerprint: records from before the mask column existed have no readable
 *  key form at all and resolve to undefined. */
export function requestGroupName(event: UsageEvent): string | undefined {
  const category = event.api_group_label?.trim().toLowerCase();
  if (category === 'api_key' || category === 'apikey') {
    return event.api_key_mask?.trim() || undefined;
  }
  const key = event.api_group_key?.trim();
  return key && key !== 'unknown' ? key : undefined;
}

/** Result-capsule label key for one record: the stored failed flag is the only
 *  success signal, so the capsule can never disagree with the filter counts. */
export function eventResultLabelKey(event: Pick<UsageEvent, 'failed'>): string {
  return event.failed ? 'events.filter_failed' : 'events.filter_success';
}

/** The client label for the list's UA column. The stored value is the one the
 *  ingestion/persistence path already reduced to a short product label, so the
 *  list shows it verbatim; a record captured without one reads as an em dash. */
export function eventUserAgentLabel(event: Pick<UsageEvent, 'user_agent'>): string {
  const value = event.user_agent?.trim();
  return value || '—';
}

/** The caller key for the list's Key column.
 *
 *  Only an `api_key` group is a caller key, and the only readable form of it we
 *  hold is the stored display mask; records ingested before the mask column
 *  existed show an em dash rather than a fingerprint. `provider` and `endpoint`
 *  groups carry a provider name or a public URL, which is not a key, so they
 *  fall through to the source fingerprint instead. */
export function eventKeyLabel(event: UsageEvent): string {
  const category = event.api_group_label?.trim().toLowerCase();
  if (category === 'api_key' || category === 'apikey') {
    return event.api_key_mask?.trim() || '—';
  }
  return event.source?.trim() || '—';
}

/** One filter-dropdown label. Key-shaped facets carry a mask so the list reads
 *  as caller keys instead of stored fingerprints. */
export function usageFacetLabel(value: { value: string; requests: number; mask?: string }): string {
  return `${value.mask?.trim() || value.value} (${value.requests})`;
}
