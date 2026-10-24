/**
 * The Insights page's wire shapes and window model.
 *
 * The page reads one cube per window - every dimension tuple's usage per bucket - and pivots it here
 * in the browser (`insightsCube.ts`), so regrouping or narrowing it never waits on the server. The
 * window itself is resolved by the server in the OMC Time Zone: a calendar unit such as "today" is a
 * fact of the deployment's calendar, not of whatever clock the browser runs.
 */

export const INSIGHTS_CALENDAR_PRESETS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'] as const;
export const INSIGHTS_SPAN_PRESETS = ['24h', '7d', '30d', '90d', 'all'] as const;
export const INSIGHTS_PRESETS = [...INSIGHTS_CALENDAR_PRESETS, ...INSIGHTS_SPAN_PRESETS] as const;
export type InsightsPreset = (typeof INSIGHTS_PRESETS)[number];

export const INSIGHTS_BUCKETS = ['auto', 'hour', 'day', 'week', 'month'] as const;
export type InsightsBucketChoice = (typeof INSIGHTS_BUCKETS)[number];
export type InsightsBucket = Exclude<InsightsBucketChoice, 'auto'>;

/** The stored window: a preset, or a custom range whose `to` is null while it follows the clock. */
export interface InsightsRange {
  preset?: InsightsPreset;
  from?: number;
  to?: number | null;
}

export const INSIGHTS_RANGE_PREFERENCE = 'insights_range';
export const DEFAULT_INSIGHTS_RANGE: InsightsRange = { preset: '7d' };

export function parseInsightsRange(raw: unknown): InsightsRange | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.preset === 'string') {
    return (INSIGHTS_PRESETS as readonly string[]).includes(value.preset)
      ? { preset: value.preset as InsightsPreset }
      : undefined;
  }
  if (typeof value.from === 'number' && Number.isFinite(value.from)) {
    const to = typeof value.to === 'number' && Number.isFinite(value.to) ? value.to : null;
    return to !== null && to <= value.from ? undefined : { from: value.from, to };
  }
  return undefined;
}

/** The query string a window and granularity are read with. */
export function insightsRangeParams(range: InsightsRange, bucket: InsightsBucketChoice = 'auto'): string {
  const params = new URLSearchParams();
  if (range.from !== undefined) {
    params.set('from', String(range.from));
    if (typeof range.to === 'number') params.set('to', String(range.to));
  } else {
    params.set('preset', range.preset ?? DEFAULT_INSIGHTS_RANGE.preset!);
  }
  if (bucket !== 'auto') params.set('bucket', bucket);
  return params.toString();
}

export interface InsightsWindow {
  preset: string;
  from: number;
  /** Inclusive. */
  to: number;
  /** The end follows the clock, so the page polls it. */
  open_end: boolean;
  bucket: InsightsBucket;
  timezone: string;
  /** Request records behind the retention horizon could not split an edge, so the window was widened. */
  widened: boolean;
}

export interface InsightsCompareWindow {
  from: number;
  to: number;
}

export interface InsightsKey {
  /** The usage fingerprint (`hmac:…`), or CPA's own label for traffic that carried no client key. */
  id: string;
  alias?: string;
  mask?: string;
  is_client_key: boolean;
}

export interface InsightsCredential {
  auth_index: string;
  auth_type: string;
}

export interface InsightsCubeResponse {
  window: InsightsWindow;
  compare_window: InsightsCompareWindow | null;
  bucket_starts: number[];
  dims: {
    keys: InsightsKey[];
    call_points: string[];
    models: string[];
    providers: string[];
    credentials: InsightsCredential[];
  };
  /** Cell names for `rows`; `previous_rows` carry the same without the leading bucket. */
  columns: string[];
  rows: number[][];
  previous_rows: number[][];
  coverage: { fact_requests: number; detail_requests: number };
}

export interface InsightsRhythmCell {
  /** Monday is 0. */
  weekday: number;
  hour: number;
  requests: number;
  total_tokens: number;
  cost_nanos: number;
}

export interface InsightsRhythmResponse {
  window: InsightsWindow;
  cells: InsightsRhythmCell[];
}

/** How often a window that follows the clock is re-read. Hours move faster than days. */
export function insightsPollInterval(window: InsightsWindow | undefined): number | false {
  if (!window?.open_end) return false;
  if (window.bucket === 'hour') return 60_000;
  return window.to - window.from > 92 * 24 * 60 * 60 * 1000 ? 300_000 : 120_000;
}
