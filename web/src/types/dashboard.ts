import type { MessageKey } from '../i18n/catalog';
import { CALENDAR_PRESETS, isCalendarPreset, isClosedCalendarPreset, type CalendarPreset } from './calendarPresets';
import { compareMetric, emptyMeasures, metricValue, type Measures, type MetricComparison } from './insightsCube';
/** Response shapes for the dashboard, which reads permanent usage facts. */

export interface DashboardWindow {
  preset?: string;
  from: number;
  to: number;
  bucket_ms: number;
  minutes: number;
  complete: boolean;
  /** True when the range has no end and the server resolved it to "now". */
  open_end: boolean;
}

export interface DashboardSeriesPoint {
  /** Bucket start in epoch milliseconds. */
  t: number;
  /** Requests in the bucket (omitted on token-only series). */
  v?: number;
  /** Failed requests in the bucket. */
  f?: number;
  tokens?: number;
  /** Cache reads in the bucket, so the cache-rate tile can plot its own shape. */
  cache_read?: number;
  /** Request cost in nanos. Exact on the wire; the browser scales it. */
  cost_nanos?: number;
}

export interface DashboardRequests {
  total: number;
  success: number;
  failed: number;
  success_rate: number | null;
  series: DashboardSeriesPoint[];
}

export interface DashboardTokens {
  token_accounting?: {
    canonical_requests: number;
    unresolved_requests: number;
    raw_input_tokens: number;
    raw_output_tokens: number;
    raw_total_tokens: number;
  };
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  cache_read: number;
  cache_creation: number;
  series: DashboardSeriesPoint[];
}

export interface DashboardMetrics {
  rpm: number | null;
  tpm: number | null;
  cache_rate: number | null;
  cost: number;
  cost_nanos?: number;
  costed_requests?: number;
  cost_source: string;
  cost_note: string;
  avg_latency_ms: number | null;
  avg_ttft_ms: number | null;
}

export interface DashboardComparison {
  from: number;
  to: number;
  same_stretch: boolean;
  requests: number;
  tokens: number;
  cost_nanos: number;
  costed_requests: number;
  baseline_requests?: number;
  baseline_tokens?: number;
  baseline_cost_nanos?: number;
  baseline_costed_requests?: number;
}

/**
 * costNoteKey names the caption the cost tile shows for a window.
 *
 * The server reports three states and they are not interchangeable: a window with no
 * request at all, a window whose requests were partly unpriced, and a window whose
 * requests all locked a price. Only the first two are caveats. Reading the last one as
 * a caveat - which is what a two-branch check does, because "estimated" is not
 * "partial" - labels a complete total as if no price were configured.
 *
 * Returns undefined when the total is complete and needs no caption.
 */
export function costNoteKey(costSource: string): MessageKey | undefined {
  switch (costSource) {
    case 'partial':
      return 'dash.cost_partial_note';
    case 'estimated':
      return undefined;
    default:
      // 'placeholder' and 'none' both mean nothing in this window was priced.
      return 'dash.cost_placeholder_note';
  }
}

export interface DashboardCoverage {
  rollup_requests: number;
  detail_requests: number;
  pending_inbox: number;
  /** Whether any request was ever recorded; false only on a deployment with no usage at all. */
  has_usage: boolean;
}

export interface DashboardResponse {
  window: DashboardWindow;
  requests: DashboardRequests;
  tokens: DashboardTokens;
  metrics: DashboardMetrics;
  comparison?: DashboardComparison;
  coverage: DashboardCoverage;
  partial_errors: string[];
}

export type DashboardComparableMetric = 'requests' | 'tokens' | 'cost';

export interface DashboardMetricDelta {
  comparison: MetricComparison;
  previousValue: number | null;
  window: { from: number; to: number };
  isSameStretch: boolean;
}

function currentMeasuresOf(data: DashboardResponse): Measures {
  const measures = emptyMeasures();
  measures.requests = data.requests.total;
  measures.failures = data.requests.failed;
  measures.totalTokens = data.tokens.total;
  measures.costNanos = data.metrics.cost_nanos ?? Math.round(data.metrics.cost * 1_000_000_000);
  measures.costedRequests = data.metrics.costed_requests
    ?? (data.metrics.cost_source === 'estimated' || data.metrics.cost_source === 'partial' ? data.requests.total : 0);
  return measures;
}

function previousMeasuresOf(comparison: DashboardComparison): Measures {
  const measures = emptyMeasures();
  measures.requests = comparison.requests;
  measures.totalTokens = comparison.tokens;
  measures.costNanos = comparison.cost_nanos;
  measures.costedRequests = comparison.costed_requests;
  return measures;
}

function baselineMeasuresOf(comparison: DashboardComparison): Measures {
  const measures = emptyMeasures();
  measures.requests = comparison.baseline_requests ?? comparison.requests;
  measures.totalTokens = comparison.baseline_tokens ?? comparison.tokens;
  measures.costNanos = comparison.baseline_cost_nanos ?? comparison.cost_nanos;
  measures.costedRequests = comparison.baseline_costed_requests ?? comparison.costed_requests;
  return measures;
}

/**
 * Evaluates a KPI tile's change against the server's robust previous-period baseline
 * using the same Poisson noise-floor rules as Insights. Returns null when neither window
 * carried traffic so an idle deployment is not littered with empty deltas.
 */
export function dashboardMetricComparison(
  data: DashboardResponse,
  metric: DashboardComparableMetric,
): DashboardMetricDelta | null {
  const previousBlock = data.comparison;
  if (!previousBlock) return null;
  if (data.requests.total === 0 && previousBlock.requests === 0) return null;
  const current = currentMeasuresOf(data);
  const previousRaw = previousMeasuresOf(previousBlock);
  const baseline = baselineMeasuresOf(previousBlock);
  if (metric === 'cost' && current.costedRequests === 0 && previousRaw.costedRequests === 0) return null;
  // Before the first request of an open calendar unit arrives, '-100%' only restates that
  // the period just started; keep the previous baseline figure without a percentage alarm.
  const isUnstartedOpenUnit = data.requests.total === 0 && isOpenCalendarPreset(data.window.preset);
  return {
    comparison: isUnstartedOpenUnit ? { kind: 'none' } : compareMetric(current, baseline, metric, previousRaw),
    previousValue: metricValue(baseline, metric),
    window: { from: previousBlock.from, to: previousBlock.to },
    isSameStretch: false,
  };
}

/** Whether a preset is an open calendar unit still accumulating ('today', 'this_week', 'this_month'). */
export function isOpenCalendarPreset(preset: string | undefined): preset is 'today' | 'this_week' | 'this_month' {
  return isCalendarPreset(preset) && !isClosedCalendarPreset(preset);
}

/** Maps an open calendar unit to its closed predecessor for one-click fallback when the new period is quiet. */
export function previousCalendarPreset(preset: string | undefined): CalendarPreset | undefined {
  switch (preset) {
    case 'today':
      return 'yesterday';
    case 'this_week':
      return 'last_week';
    case 'this_month':
      return 'last_month';
    default:
      return undefined;
  }
}

/**
 * Spans back from now offered by the dashboard picker, shortest first. The picker
 * lists the calendar units ahead of them.
 *
 * "all" has no length of its own: the server starts it at the deployment's first
 * usage record, which is why no table here maps a preset to a span.
 */
export const DASHBOARD_SPAN_PRESETS = ['1h', '6h', '24h', '7d', '30d', '90d', 'all'] as const;
export const DASHBOARD_PRESETS = [...CALENDAR_PRESETS, ...DASHBOARD_SPAN_PRESETS] as const;
export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number];

/**
 * The preset a dashboard drill-down opens the request list on.
 *
 * The request list reads request records, which roll out of retention, and it
 * bounds its window; the dashboard's all-time window reads permanent usage
 * facts and does neither. An all-time drill-down therefore lands on the longest
 * window the list offers instead of a range it would reject.
 */
export const REQUEST_LIST_LONGEST_PRESET = '90d';

export function requestListPreset(preset: DashboardPreset): string {
  return preset === 'all' ? REQUEST_LIST_LONGEST_PRESET : preset;
}

/**
 * The request-list query a dashboard drill-down opens.
 *
 * A span carries over by name. A calendar unit has no name the request list knows, so it
 * carries over as the bounds the server resolved it to; the current unit stays open so the
 * list keeps following the clock the way the dashboard did.
 */
export function requestListWindowParams(range: DashboardRange, window: DashboardWindow | undefined): URLSearchParams {
  const search = new URLSearchParams();
  if (isCalendarPreset(range.preset)) {
    if (!window) {
      search.set('preset', '24h');
      return search;
    }
    search.set('from', String(window.from));
    if (isClosedCalendarPreset(range.preset)) search.set('to', String(window.to));
  } else if (range.preset) {
    search.set('preset', requestListPreset(range.preset));
  } else if (range.from !== undefined) {
    search.set('from', String(range.from));
    if (typeof range.to === 'number') search.set('to', String(range.to));
  }
  return search;
}

export interface DashboardRange {
  preset?: DashboardPreset;
  /** Custom window start in epoch milliseconds. */
  from?: number;
  /**
   * Custom window end. `null` means open-ended (through now): the end tracks the
   * current time and the page keeps polling it, exactly like a relative preset.
   * `undefined` means no custom range is selected at all.
   */
  to?: number | null;
}

/** The stored preference key holding the dashboard's current range. */
export const DASHBOARD_RANGE_PREFERENCE = 'dashboard_range';
export const DASHBOARD_COMPARISON_PREFERENCE = 'omc_dashboard_comparison';
export const DEFAULT_DASHBOARD_COMPARISON = true;

export function parseDashboardComparisonPreference(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

export const DEFAULT_DASHBOARD_RANGE: DashboardRange = { preset: 'today' };

export function dashboardRangeParams(range: DashboardRange): string {
  const search = new URLSearchParams();
  if (range.from !== undefined) {
    search.set('from', String(range.from));
    // An open-ended range sends no `to`: the server resolves it to now on every
    // request, which is what makes the newest bucket keep appearing.
    if (typeof range.to === 'number') search.set('to', String(range.to));
  } else if (range.preset) {
    search.set('preset', range.preset);
  }
  return search.toString();
}

/**
 * A relative preset, the current calendar unit and an open-ended custom range all
 * move with the clock, so they are worth polling. A closed custom range and a
 * previous calendar unit are frozen.
 */
export function isSlidingRange(range: DashboardRange): boolean {
  if (range.preset !== undefined) return !isClosedCalendarPreset(range.preset);
  return range.from !== undefined && range.to === null;
}

/**
 * parseDashboardRange validates a stored range before the page trusts it.
 *
 * The value comes back from a JSON blob the browser wrote, so it is input, not
 * state: anything malformed must fall back to the default rather than render a
 * window the server will reject.
 */
export function parseDashboardRange(raw: unknown): DashboardRange | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.preset === 'string') {
    return (DASHBOARD_PRESETS as readonly string[]).includes(value.preset)
      ? { preset: value.preset as DashboardPreset }
      : undefined;
  }
  if (typeof value.from !== 'number' || !Number.isFinite(value.from)) return undefined;
  if (value.to === null) return { from: value.from, to: null };
  if (typeof value.to !== 'number' || !Number.isFinite(value.to) || value.to <= value.from) return undefined;
  return { from: value.from, to: value.to };
}

/** Where the re-shipped tail sits on the grid the browser already holds. */
export interface DashboardLive {
  as_of_ms: number;
  bucket_ms: number;
  series_start_ms: number;
  tail_from_ms: number;
}

/**
 * Tail response: the same window numbers as DashboardResponse, a few buckets of
 * series, and no coverage. `Omit` is load-bearing — a tail that answered with a
 * zeroed coverage block would have the UI report "0 stored events" over a
 * healthy collector.
 */
export interface DashboardTailResponse extends Omit<DashboardResponse, 'coverage'> {
  live: DashboardLive;
}

/**
 * livePollInterval paces tail polling to the resolution actually being served:
 * a tick per twelfth of a bucket, floored at 5s so a quiet console still feels
 * immediate and a busy one does not stampede, capped at 2min because past that
 * the next poll is indistinguishable from a manual refresh.
 */
export function livePollInterval(bucketMs: number): number | false {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) return false;
  return Math.min(Math.max(Math.round(bucketMs / 12), 5_000), 120_000);
}

interface Splice<T> {
  series: T[];
  /** The cached grid and the tail do not line up; the window must be refetched. */
  broken: boolean;
}

/**
 * spliceTail replaces the trailing buckets of a cached series with fresh ones.
 *
 * The rule is deliberately strict: the merged series must start exactly on the
 * grid the server is now using and step by exactly one bucket. A tab that slept
 * through several buckets leaves a cache that cannot be patched — and a series
 * with a hole in it would be drawn as a cliff, which is worse than one stale
 * frame. `broken` sends the caller back to the full endpoint instead.
 */
export function spliceTail<T extends { t: number }>(cached: T[], tail: T[], live: DashboardLive): Splice<T> {
  if (tail.length === 0) return { series: cached, broken: false };
  const kept = cached.filter((point) => point.t >= live.series_start_ms && point.t < live.tail_from_ms);
  const merged = [...kept, ...tail].sort((left, right) => left.t - right.t);
  if (merged.length === 0 || merged[0].t !== live.series_start_ms) {
    return { series: cached, broken: true };
  }
  for (let index = 1; index < merged.length; index += 1) {
    if (merged[index].t - merged[index - 1].t !== live.bucket_ms) {
      return { series: cached, broken: true };
    }
  }
  return { series: merged, broken: false };
}

export interface MergedDashboard {
  data?: DashboardResponse;
  broken: boolean;
}

/**
 * applyTail folds one tail poll into the last full response.
 *
 * Totals and metrics are taken wholesale — a sliding window's totals move on
 * every tick even when nothing arrived, because the left edge keeps dropping
 * old events. Two blocks survive from the full response instead: coverage, which
 * the tail does not answer for, and partial_errors, which it cannot report on
 * (it queries less, not more). Overwriting either would let a poll silently
 * clear a warning the last full fetch had good reason to raise.
 */
export function applyTail(base: DashboardResponse, patch?: DashboardTailResponse): MergedDashboard {
  if (!patch || !patch.live?.bucket_ms || !patch.live.tail_from_ms) {
    return { data: base, broken: false };
  }
  // A poll from an older instant or an abandoned preset was overtaken in flight;
  // discard it without triggering a heal.
  if (patch.live.as_of_ms < base.window.to || patch.window.preset !== base.window.preset) {
    return { data: base, broken: false };
  }
  // A newer poll on the same preset whose bucket width stepped up (e.g. 'today'
  // crossing from 1m to 2m buckets) cannot splice onto the old grid; mark broken
  // so the page refetches the full series on the new resolution.
  if (patch.live.bucket_ms !== base.window.bucket_ms) {
    return { data: base, broken: true };
  }
  const { live } = patch;
  const requests = spliceTail(base.requests.series, patch.requests.series, live);
  const tokens = spliceTail(base.tokens.series, patch.tokens.series, live);
  if (requests.broken || tokens.broken) return { data: base, broken: true };
  // Collector warnings come only from the full response, while comparison degradation
  // is re-evaluated on every tail poll.
  const collectorErrors = base.partial_errors.filter((entry) => entry !== 'comparison unavailable');
  const mergedErrors = Array.from(new Set([...collectorErrors, ...patch.partial_errors]));
  return {
    broken: false,
    data: {
      ...base,
      window: patch.window,
      requests: { ...base.requests, ...patch.requests, series: requests.series },
      tokens: { ...base.tokens, ...patch.tokens, series: tokens.series },
      metrics: patch.metrics,
      comparison: patch.comparison,
      partial_errors: mergedErrors,
    },
  };
}

/**
 * One bucket of a row's traffic on the provider list's activity grid. Only buckets that served a
 * request travel; an absent one was idle.
 */
export interface TrafficBucket {
  start_ms: number;
  total: number;
  failure: number;
}

/** The window's traffic one channel label carried, for the records no API key answered. */
export interface WindowProviderTraffic {
  id: string;
  total: number;
  success: number;
  failure: number;
  success_rate: number | null;
  buckets?: TrafficBucket[];
}

/** The window's traffic one upstream API key answered, by the key's runtime auth index. */
export interface WindowCredentialTraffic {
  auth_index: string;
  total: number;
  failure: number;
  buckets?: TrafficBucket[];
}
