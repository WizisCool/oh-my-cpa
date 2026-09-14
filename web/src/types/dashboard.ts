/** Response shapes for the request-record backed dashboard. */

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
  cost_source: string;
  cost_note: string;
  avg_latency_ms: number | null;
  avg_ttft_ms: number | null;
}

export interface DashboardCoverage {
  rollup_requests: number;
  detail_requests: number;
  pending_inbox: number;
  stored_events: number;
}

export interface DashboardResponse {
  window: DashboardWindow;
  requests: DashboardRequests;
  tokens: DashboardTokens;
  metrics: DashboardMetrics;
  coverage: DashboardCoverage;
  partial_errors: string[];
}

/**
 * Range presets offered by the dashboard picker, shortest first. "15m" is the
 * one the picker labels Live — see docs/design.md for why fifteen minutes and
 * not five.
 */
export const DASHBOARD_PRESETS = ['15m', '1h', '6h', '24h', '7d', '30d', '90d'] as const;
export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number];

/** Window length per preset, used to preview the range a preset resolves to. */
export const DASHBOARD_PRESET_MS: Record<DashboardPreset, number> = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};

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

export const DEFAULT_DASHBOARD_RANGE: DashboardRange = { preset: '24h' };

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
 * A relative preset and an open-ended custom range both move with the clock, so
 * both are worth polling. A closed custom range is frozen.
 */
export function isSlidingRange(range: DashboardRange): boolean {
  if (range.preset !== undefined) return true;
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
  // A poll answers for the window it was asked about. If a full fetch finished
  // after this tail was computed — or the two disagree about which window or
  // which grid they describe — the tail is simply older, not wrong, and the
  // fresher full response wins.
  if (
    patch.live.as_of_ms < base.window.to
    || patch.window.preset !== base.window.preset
    || patch.live.bucket_ms !== base.window.bucket_ms
  ) {
    return { data: base, broken: false };
  }
  const { live } = patch;
  const requests = spliceTail(base.requests.series, patch.requests.series, live);
  const tokens = spliceTail(base.tokens.series, patch.tokens.series, live);
  if (requests.broken || tokens.broken) return { data: base, broken: true };
  return {
    broken: false,
    data: {
      ...base,
      window: patch.window,
      requests: { ...base.requests, ...patch.requests, series: requests.series },
      tokens: { ...base.tokens, ...patch.tokens, series: tokens.series },
      metrics: patch.metrics,
    },
  };
}
