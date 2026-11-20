/**
 * The Trends page's pure half: its view in the URL, the reads it sends, and the shapes its charts
 * draw. Kept free of React so a burn curve's forecast split, a telemetry gap and a drill link are
 * asserted without a browser.
 */

import { INSIGHTS_BUCKETS, insightsRangeParams, type InsightsBucketChoice, type InsightsRange, type InsightsWindow } from '../../types/insights';
import type { TFunc } from '../../i18n';
import dayjs from '../../utils/time';
import type { QuotaWindow } from '../../types/quota';
import type { RollingReadout } from '../../types/rollingNumber';
import { MAX_USAGE_EVENT_FILTER_VALUES, type UsageEvent, type UsageFailureCategory } from '../../types/usageEvents';
import { quotaReadingLabels, roundQuotaPeriodHours } from '../quota/quotaWindowNaming';
import type {
  TrendsFailureGroup,
  TrendsGroupName,
  TrendsQuotaCredential,
  TrendsQuotaWindow,
  TrendsScatterPoint,
  TrendsStatusCount,
  TrendsSubstitutionPair,
  TrendsTelemetryBucket,
  TrendsTelemetryResponse,
  TrendsTelemetrySeries,
  TrendsTelemetrySummary,
  TrendsUsageGroupOption,
  TrendsUsageResponse,
} from '../../types/trends';

/** The page's filters, spelled in the reads' own vocabulary, which is also the request list's. */
export const TRENDS_FILTER_KEYS = ['api_key', 'model', 'model_alias', 'provider', 'auth_index', 'client_agent'] as const;
export type TrendsFilterKey = (typeof TRENDS_FILTER_KEYS)[number];
export type TrendsFilters = Partial<Record<TrendsFilterKey, string[]>>;

/** What the movers group by; `model` follows the console's model view. */
export const TRENDS_USAGE_GROUPS = ['model', 'key', 'client_agent', 'provider', 'credential'] as const;
export type TrendsUsageGroup = (typeof TRENDS_USAGE_GROUPS)[number];
export const TRENDS_PERF_GROUPS = ['model', 'provider', 'credential'] as const;
export type TrendsPerfGroup = (typeof TRENDS_PERF_GROUPS)[number];

export const PERF_MODES = ['tps', 'ttft', 'latency', 'scatter'] as const;
export type PerfMode = (typeof PERF_MODES)[number];
export const PERF_QUANTILES = ['p50', 'p95'] as const;
export type PerfQuantile = (typeof PERF_QUANTILES)[number];
export const QUOTA_VIEWS = ['burn', 'cycles'] as const;
export type QuotaView = (typeof QUOTA_VIEWS)[number];

export interface TrendsViewState {
  bucket: InsightsBucketChoice;
  usageGroup: TrendsUsageGroup;
  perfGroup: TrendsPerfGroup;
  perfMode: PerfMode;
  /** The specific model/provider/credential picked in TTFT or total-latency mode; absent means all traffic. */
  perfItem?: string;
  quotaView: QuotaView;
  /** The credential and window the burn card shows; the first one with a cycle when absent. */
  quotaCredential?: string;
  quotaWindow?: string;
  filters: TrendsFilters;
}

export const DEFAULT_TRENDS_VIEW: TrendsViewState = {
  bucket: 'auto',
  usageGroup: 'model',
  perfGroup: 'model',
  perfMode: 'tps',
  quotaView: 'burn',
  filters: {},
};

function oneOf<T extends string>(values: readonly T[], raw: string | null, fallback: T): T {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export function readTrendsView(search: URLSearchParams): TrendsViewState {
  const filters: TrendsFilters = {};
  for (const key of TRENDS_FILTER_KEYS) {
    const values = search.getAll(key).map((value) => value.trim()).filter(Boolean);
    if (values.length > 0) filters[key] = [...new Set(values)];
  }
  const view: TrendsViewState = {
    bucket: oneOf(INSIGHTS_BUCKETS, search.get('bucket'), DEFAULT_TRENDS_VIEW.bucket),
    usageGroup: oneOf(TRENDS_USAGE_GROUPS, search.get('group'), DEFAULT_TRENDS_VIEW.usageGroup),
    perfGroup: oneOf(TRENDS_PERF_GROUPS, search.get('perf_group'), DEFAULT_TRENDS_VIEW.perfGroup),
    perfMode: oneOf(PERF_MODES, search.get('perf'), DEFAULT_TRENDS_VIEW.perfMode),
    quotaView: oneOf(QUOTA_VIEWS, search.get('quota_view'), DEFAULT_TRENDS_VIEW.quotaView),
    filters,
  };
  const perfItem = search.get('perf_item')?.trim();
  const credential = search.get('quota_auth')?.trim();
  const window = search.get('quota_window')?.trim();
  if (perfItem) view.perfItem = perfItem;
  if (credential) view.quotaCredential = credential;
  if (window) view.quotaWindow = window;
  return view;
}

/** Writes a view back, leaving defaults out so a plain link stays plain. */
export function writeTrendsView(view: TrendsViewState): URLSearchParams {
  const search = new URLSearchParams();
  if (view.bucket !== DEFAULT_TRENDS_VIEW.bucket) search.set('bucket', view.bucket);
  if (view.usageGroup !== DEFAULT_TRENDS_VIEW.usageGroup) search.set('group', view.usageGroup);
  if (view.perfGroup !== DEFAULT_TRENDS_VIEW.perfGroup) search.set('perf_group', view.perfGroup);
  if (view.perfMode !== DEFAULT_TRENDS_VIEW.perfMode) search.set('perf', view.perfMode);
  if (view.perfItem) search.set('perf_item', view.perfItem);
  if (view.quotaView !== DEFAULT_TRENDS_VIEW.quotaView) search.set('quota_view', view.quotaView);
  if (view.quotaCredential) search.set('quota_auth', view.quotaCredential);
  if (view.quotaWindow) search.set('quota_window', view.quotaWindow);
  for (const key of TRENDS_FILTER_KEYS) {
    for (const value of view.filters[key] ?? []) search.append(key, value);
  }
  return search;
}

export function toggleTrendsFilter(filters: TrendsFilters, key: TrendsFilterKey, value: string): TrendsFilters {
  const current = filters[key] ?? [];
  const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
  const result = { ...filters };
  if (next.length > 0) result[key] = next;
  else delete result[key];
  return result;
}

export function hasTrendsFilters(filters: TrendsFilters): boolean {
  return TRENDS_FILTER_KEYS.some((key) => (filters[key]?.length ?? 0) > 0);
}

/** The server's `group_by` for a grouping: the model grouping reads the console's model view. */
export function usageGroupBy(group: TrendsUsageGroup | TrendsPerfGroup, modelView: 'model' | 'call'): string {
  if (group === 'model') return modelView === 'model' ? 'model' : 'call_point';
  return group;
}

/** The filter a group's id narrows, so a mover or a legend entry filters the page by itself. */
export function filterGroupByForKey(key: TrendsFilterKey): string {
  switch (key) {
    case 'model': return 'model';
    case 'model_alias': return 'call_point';
    case 'api_key': return 'key';
    case 'provider': return 'provider';
    case 'auth_index': return 'credential';
    case 'client_agent': return 'client_agent';
  }
}

export function omitTrendsFilter(filters: TrendsFilters, omitKey: TrendsFilterKey): TrendsFilters {
  if (!filters[omitKey]?.length) return filters;
  const next = { ...filters };
  delete next[omitKey];
  return next;
}

export function trendsFilterDimensions(modelView: 'model' | 'call'): TrendsFilterKey[] {
  const inactiveModelKey: TrendsFilterKey = modelView === 'model' ? 'model_alias' : 'model';
  return TRENDS_FILTER_KEYS.filter((key) => key !== inactiveModelKey);
}

/** Candidate values for one filter dimension, preferring the server's full group list over top-series fallbacks. */
export function trendsFilterOptions(
  usage: TrendsUsageResponse | undefined,
  telemetry?: TrendsTelemetryResponse,
): TrendsUsageGroupOption[] {
  if (usage?.groups && usage.groups.length > 0) {
    return usage.groups.filter((item) => item.id !== '' && !item.filter_disabled);
  }
  const seen = new Map<string, TrendsUsageGroupOption>();
  for (const item of usage?.series ?? []) {
    if (item.folded || item.id === '' || item.filter_disabled) continue;
    seen.set(item.id, { id: item.id, label: item.label, alias: item.alias, mask: item.mask, requests: item.requests });
  }
  for (const mover of [...(usage?.movers.risers ?? []), ...(usage?.movers.fallers ?? [])]) {
    if (mover.id === '' || mover.filter_disabled || seen.has(mover.id)) continue;
    seen.set(mover.id, { id: mover.id, label: mover.label, alias: mover.alias, mask: mover.mask, requests: mover.requests });
  }
  if (telemetry && usage && telemetry.group_by === usage.group_by) {
    const byId = new Map(telemetry.series.map((item) => [item.id, item.total_requests]));
    for (const group of telemetry.groups ?? []) {
      if (group.id === '' || group.filter_disabled || seen.has(group.id)) continue;
      seen.set(group.id, { id: group.id, label: group.label, alias: group.alias, mask: group.mask, requests: byId.get(group.id) ?? 0 });
    }
  }
  return [...seen.values()];
}

/** The filter a group's id narrows, so a mover or a legend entry filters the page by itself. */
export function filterKeyForGroupBy(groupBy: string): TrendsFilterKey | null {
  switch (groupBy) {
    case 'model': return 'model';
    case 'call_point': return 'model_alias';
    case 'key': return 'api_key';
    case 'provider': return 'provider';
    case 'credential': return 'auth_index';
    case 'client_agent': return 'client_agent';
    default: return null;
  }
}

function appendFilters(params: URLSearchParams, filters: TrendsFilters, keys: readonly TrendsFilterKey[] = TRENDS_FILTER_KEYS): void {
  for (const key of keys) {
    for (const value of filters[key] ?? []) params.append(key, value);
  }
}

/** The usage or telemetry read for a window, granularity, grouping and the page's filters. */
export function trendsWindowParams(range: InsightsRange, bucket: InsightsBucketChoice, groupBy: string, filters: TrendsFilters): string {
  const params = new URLSearchParams(insightsRangeParams(range, bucket));
  // The server's own default stays implicit, so the demonstration's captured reads still match.
  if (groupBy !== 'model') params.set('group_by', groupBy);
  appendFilters(params, filters);
  return params.toString();
}

/** The quota read takes only the connection filters: a credential's cycle is not a window's slice. */
export function trendsQuotaParams(filters: TrendsFilters): string {
  const params = new URLSearchParams();
  appendFilters(params, filters, ['provider', 'auth_index']);
  return params.toString();
}

// ── Quota burn ─────────────────────────────────────────────────────────────

/** The fixed vertical range of a burn chart: past the limit, so an overshoot reads as one. */
export const QUOTA_AXIS_MAX = 150;

export interface QuotaBurnPoint {
  /** The instant the cumulative reading belongs to: a bucket's end, or the cycle's start. */
  t: number;
  startMs: number;
  endMs: number;
  used: number;
  delta: number;
  requests: number;
  netTokens: number;
  totalTokens: number;
  isForecast: boolean;
  /** True for the exact projected-exhaustion milestone on the 100% limit line. */
  isExhaustMilestone?: boolean;
  /** The measured line's value, null past the divider. */
  actual: number | null;
  /** The projected line's value, null before the divider; the divider's point carries both. */
  forecast: number | null;
}

/** A window's windows that have a cycle to draw, in the server's order. */
export function chartableWindows(credential: TrendsQuotaCredential | undefined): TrendsQuotaWindow[] {
  return (credential?.windows ?? []).filter((window) => window.cycle_reset_ms > window.cycle_start_ms);
}

export function quotaCredentialName(item: TrendsQuotaCredential): string {
  return item.display_name?.trim() || item.account_label || item.auth_index;
}

function toQuotaWindow(window: TrendsQuotaWindow): QuotaWindow {
  return {
    id: window.window_id,
    label: window.label ?? '',
    kind: window.kind as QuotaWindow['kind'],
    scope: (window.scope as QuotaWindow['scope']) || 'standard',
    model: window.model,
    period_hours: window.period_hours ?? undefined,
  };
}

export function quotaWindowNames(windows: readonly TrendsQuotaWindow[], t: TFunc): Map<string, string> {
  const labels = quotaReadingLabels(windows.map(toQuotaWindow), t);
  const resolved = new Map<string, string>();
  for (const window of windows) {
    const label = labels.get(window.window_id)?.trim();
    if (label) {
      resolved.set(window.window_id, label);
    } else if (window.period_hours !== null && window.period_hours > 0) {
      const roundedHours = roundQuotaPeriodHours(window.period_hours);
      resolved.set(
        window.window_id,
        roundedHours % 24 === 0
          ? t('trends.quota.period_days', { n: roundedHours / 24 })
          : t('trends.quota.period_hours', { n: roundedHours }),
      );
    } else {
      resolved.set(window.window_id, window.window_id);
    }
  }
  return resolved;
}

export function quotaWindowName(window: TrendsQuotaWindow, t: TFunc, allWindows?: readonly TrendsQuotaWindow[]): string {
  const source = allWindows && allWindows.length > 0 ? allWindows : [window];
  return quotaWindowNames(source, t).get(window.window_id) ?? window.window_id;
}

/** The credential and window the burn card opens on: the requested pair, or the most pressing one. */
export function pickQuotaWindow(
  items: readonly TrendsQuotaCredential[],
  credentialId: string | undefined,
  windowId: string | undefined,
): { credential: TrendsQuotaCredential; window: TrendsQuotaWindow } | null {
  const usable = items.filter((item) => chartableWindows(item).length > 0);
  if (usable.length === 0) return null;
  const credential = usable.find((item) => item.auth_index === credentialId) ?? mostPressing(usable);
  const windows = chartableWindows(credential);
  const window = windows.find((item) => item.window_id === windowId) ?? windows.reduce((best, item) => (urgency(item) > urgency(best) ? item : best));
  return { credential, window };
}

export function forecastableWindows(item: TrendsQuotaCredential, nowMs?: number): TrendsQuotaWindow[] {
  if (STALE_CREDENTIAL_STATUSES.has(item.status)) return [];
  return chartableWindows(item).filter((window) => nowMs === undefined || window.cycle_reset_ms > nowMs);
}

/**
 * Picks the most pressing credential/window from the same active, non-stale set counted by `quotaRisk`.
 * Historical readings remain available via `pickQuotaWindow`.
 */
export function pickForecastableQuotaWindow(
  items: readonly TrendsQuotaCredential[],
  nowMs?: number,
): { credential: TrendsQuotaCredential; window: TrendsQuotaWindow } | null {
  let best: { credential: TrendsQuotaCredential; window: TrendsQuotaWindow } | null = null;
  let bestScore = -Infinity;
  for (const credential of items) {
    const windows = forecastableWindows(credential, nowMs);
    if (windows.length === 0) continue;
    const window = windows.reduce((curr, item) => (urgency(item) > urgency(curr) ? item : curr));
    const score = urgency(window);
    if (score > bestScore) {
      best = { credential, window };
      bestScore = score;
    }
  }
  return best;
}

/** The dot a quota window earns: amber while heading for its limit, red once it has reached it. */
export function quotaWindowAttention(window: TrendsQuotaWindow): 'warn' | 'danger' | null {
  return window.status === 'limit_reached' ? 'danger' : window.status === 'projected_exhaust' ? 'warn' : null;
}

/** A credential's dot is its worst window's, so a picker flags it without opening each one. */
export function quotaCredentialAttention(credential: TrendsQuotaCredential): 'warn' | 'danger' | null {
  const tones = chartableWindows(credential).map(quotaWindowAttention);
  return tones.includes('danger') ? 'danger' : tones.includes('warn') ? 'warn' : null;
}

/**
 * The credentials whose quota can be projected - an active window with a trustworthy reading and
 * known cycle - and how many of them are at a limit or heading for one this cycle, each counted
 * once by its worst active window.
 */
const STALE_CREDENTIAL_STATUSES = new Set(['stale', 'error', 'unavailable', 'disabled', 'unknown']);

export type TrendsQuotaNoticeKind = 'cpa_unreachable' | 'stale';

export interface TrendsQuotaNoticeState {
  kind: TrendsQuotaNoticeKind;
  canRefreshQuota: boolean;
}

/**
 * Classifies why the selected quota cycle cannot project forward: CPA itself could not be
 * reached to verify live credentials (retry the read) or the observation is stale, failed, or
 * past its reset (trigger a live upstream quota refresh).
 */
export function quotaNoticeState(
  credential: TrendsQuotaCredential,
  window: TrendsQuotaWindow,
  isMembershipUnknown: boolean,
  nowMs: number,
): TrendsQuotaNoticeState | null {
  if (isMembershipUnknown) {
    return { kind: 'cpa_unreachable', canRefreshQuota: false };
  }
  if (STALE_CREDENTIAL_STATUSES.has(credential.status) || window.cycle_reset_ms <= nowMs) {
    return {
      kind: 'stale',
      canRefreshQuota: credential.status !== 'disabled' && credential.auth_index.trim() !== '',
    };
  }
  return null;
}

export function quotaRisk(items: readonly TrendsQuotaCredential[], nowMs?: number): { forecastable: number; limited: number; projected: number } {
  let forecastable = 0;
  let limited = 0;
  let projected = 0;
  for (const item of items) {
    const windows = forecastableWindows(item, nowMs);
    if (windows.length === 0) continue;
    forecastable += 1;
    if (windows.some((window) => window.status === 'limit_reached')) limited += 1;
    else if (windows.some((window) => window.status === 'projected_exhaust')) projected += 1;
  }
  return { forecastable, limited, projected };
}

const STATUS_URGENCY: Record<string, number> = { limit_reached: 3, projected_exhaust: 2, normal: 1, underutilized: 0 };

function urgency(window: TrendsQuotaWindow): number {
  return (STATUS_URGENCY[window.status] ?? 0) * 1000 + window.used_percent;
}

function mostPressing(items: readonly TrendsQuotaCredential[]): TrendsQuotaCredential {
  let best = items[0]!;
  let bestScore = -Infinity;
  for (const item of items) {
    const score = Math.max(...chartableWindows(item).map(urgency));
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The instant the measured part of a cycle ends: where it hit the limit, else the last measured
 * bucket's end, else the cycle's start.
 */
export function quotaDivider(window: TrendsQuotaWindow): number {
  if (window.exhausted_at_ms !== undefined) return window.exhausted_at_ms;
  let last = window.cycle_start_ms;
  for (const bucket of window.buckets) {
    if (!bucket.is_forecast) last = Math.max(last, bucket.end_ms);
  }
  return last;
}

/**
 * The burn curve: one cumulative point at the cycle's start and one at each bucket's end. The
 * measured and projected lines are two series sharing the point where one becomes the other, so
 * they meet without a gap and neither is drawn across the other's span.
 */
export function buildQuotaBurnSeries(window: TrendsQuotaWindow): QuotaBurnPoint[] {
  const buckets = [...window.buckets].sort((a, b) => a.start_ms - b.start_ms);
  if (buckets.length === 0) return [];
  const first = buckets[0]!;
  const startUsed = Math.max(0, first.used_percent - first.delta_percent);
  const points: QuotaBurnPoint[] = [{
    t: first.start_ms,
    startMs: first.start_ms,
    endMs: first.start_ms,
    used: startUsed,
    delta: 0,
    requests: 0,
    netTokens: 0,
    totalTokens: 0,
    isForecast: first.is_forecast,
    actual: first.is_forecast ? null : startUsed,
    forecast: first.is_forecast ? startUsed : null,
  }];
  for (const bucket of buckets) {
    points.push({
      t: bucket.end_ms,
      startMs: bucket.start_ms,
      endMs: bucket.end_ms,
      used: bucket.used_percent,
      delta: bucket.delta_percent,
      requests: bucket.requests,
      netTokens: bucket.net_tokens,
      totalTokens: bucket.total_tokens,
      isForecast: bucket.is_forecast,
      actual: bucket.is_forecast ? null : bucket.used_percent,
      forecast: bucket.is_forecast ? bucket.used_percent : null,
    });
  }
  // The last measured point starts the projection too.
  let lastActual = -1;
  points.forEach((point, index) => { if (!point.isForecast) lastActual = index; });
  if (lastActual >= 0 && lastActual < points.length - 1) points[lastActual] = { ...points[lastActual]!, forecast: points[lastActual]!.used };

  // Insert the exact projected-exhaustion instant as a snap-to milestone on the 100% line when it falls in the forecast span.
  const exhaustAt = window.exhausted_at_ms === undefined ? window.projected_exhaust_at_ms : undefined;
  const lastMeasuredEnd = lastActual >= 0 ? points[lastActual]!.t : window.cycle_start_ms;
  if (exhaustAt !== undefined && exhaustAt > lastMeasuredEnd && exhaustAt < window.cycle_reset_ms) {
    const existingIndex = points.findIndex((point) => point.t === exhaustAt);
    if (existingIndex >= 0) {
      points[existingIndex] = { ...points[existingIndex]!, used: 100, forecast: 100, isExhaustMilestone: true };
    } else {
      const insertIndex = points.findIndex((point) => point.t > exhaustAt);
      const prev = insertIndex > 0 ? points[insertIndex - 1]! : points[points.length - 1]!;
      const milestone: QuotaBurnPoint = {
        t: exhaustAt,
        startMs: exhaustAt,
        endMs: exhaustAt,
        used: 100,
        delta: Math.max(0, 100 - prev.used),
        requests: 0,
        netTokens: 0,
        totalTokens: 0,
        isForecast: true,
        isExhaustMilestone: true,
        actual: null,
        forecast: 100,
      };
      if (insertIndex >= 0) points.splice(insertIndex, 0, milestone);
      else points.push(milestone);
    }
  }
  return points;
}

/** The point the keyboard or pointer lands on for an instant: the nearest reading. */
export function nearestPointIndex(points: readonly { t: number }[], t: number): number {
  let best = -1;
  let bestDistance = Infinity;
  points.forEach((point, index) => {
    const distance = Math.abs(point.t - t);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** One arrow key's step through the points, held inside them. */
export function stepPointIndex(current: number | null, key: string, count: number): number | null {
  if (count === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return current;
  if (current === null) return key === 'ArrowLeft' ? count - 1 : 0;
  const next = current + (key === 'ArrowLeft' ? -1 : 1);
  return Math.min(count - 1, Math.max(0, next));
}

/** A countdown in whole units, largest first, for a catalog sentence to spell. */
export function countdownParts(ms: number): { days: number; hours: number; minutes: number } {
  const total = Math.max(0, Math.floor(ms / 60_000));
  return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}

/** A percentage reading with the precision a gauge needs. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  return `${rounded.toFixed(Math.abs(rounded) >= 100 ? 0 : digits)}%`;
}

/** `formatPercent` as an animated readout so percentage tiles align and roll beside sibling figures. */
export function percentReadout(value: number | null | undefined, digits = 1): RollingReadout | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  const rounded = Number(value.toFixed(digits));
  const fractionDigits = Math.abs(rounded) >= 100 ? 0 : digits;
  return {
    number: rounded,
    suffix: '%',
    format: { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits },
  };
}

export interface QuotaCycleBar {
  start: number;
  reset: number;
  isCurrent: boolean;
  isApproximate: boolean;
  usedPercent: number;
  actual: number;
  full: number | null;
}

/** The cycle history as bars: what each cycle used, and what its whole window would have held. */
export function quotaCycleBars(window: TrendsQuotaWindow, measure: 'net_tokens' | 'requests'): QuotaCycleBar[] {
  return [...window.cycles]
    .sort((a, b) => a.cycle_start_ms - b.cycle_start_ms)
    .map((cycle) => ({
      start: cycle.cycle_start_ms,
      reset: cycle.cycle_reset_ms,
      isCurrent: cycle.is_current,
      isApproximate: Boolean(cycle.is_approximate),
      usedPercent: cycle.used_percent,
      actual: measure === 'net_tokens' ? cycle.actual_net_tokens : cycle.actual_requests,
      full: (measure === 'net_tokens' ? cycle.full_net_tokens : cycle.full_requests) ?? null,
    }));
}

// ── Usage ──────────────────────────────────────────────────────────────────

/** A relative change, or null without a baseline to compare against. */
export function relativeChange(current: number, baseline: number | null | undefined): number | null {
  if (baseline === null || baseline === undefined || !Number.isFinite(baseline) || baseline <= 0) return null;
  return (current - baseline) / baseline;
}

// ── Telemetry ──────────────────────────────────────────────────────────────

export const GLOBAL_SERIES_ID = '\u0000all';

export function perfSeriesKey(id: string): string {
  return `s:${id}`;
}

/** The median streaming speed per bucket, overall and per group, with idle buckets left empty. */
export function tpsRows(buckets: readonly TrendsTelemetryBucket[], series: readonly TrendsTelemetrySeries[]): Array<Record<string, number | null>> {
  const bySeries = new Map(series.map((group) => [group.id, new Map(group.buckets.map((bucket) => [bucket.start_ms, bucket]))]));
  return buckets.map((bucket) => {
    const row: Record<string, number | null> = { start: bucket.start_ms, [GLOBAL_SERIES_ID]: sampled(bucket.tps_p50, bucket.tps_samples) };
    for (const group of series) {
      const own = bySeries.get(group.id)?.get(bucket.start_ms);
      row[perfSeriesKey(group.id)] = own ? sampled(own.tps_p50, own.tps_samples) : null;
    }
    return row;
  });
}

function sampled(value: number | null, samples: number): number | null {
  return samples > 0 && value !== null && Number.isFinite(value) ? value : null;
}

export interface PercentileRow {
  start: number;
  p50: number | null;
  p95: number | null;
  /** The band between the median and the 95th percentile, absent where either is. */
  band: [number, number] | null;
  samples: number;
}

export function percentileRows(buckets: readonly TrendsTelemetryBucket[], measure: 'ttft' | 'latency'): PercentileRow[] {
  return buckets.map((bucket) => {
    const samples = measure === 'ttft' ? bucket.ttft_samples : bucket.latency_samples;
    const p50 = sampled(measure === 'ttft' ? bucket.ttft_p50_ms : bucket.latency_p50_ms, samples);
    const p95 = sampled(measure === 'ttft' ? bucket.ttft_p95_ms : bucket.latency_p95_ms, samples);
    return { start: bucket.start_ms, p50, p95, band: p50 !== null && p95 !== null ? [p50, Math.max(p50, p95)] : null, samples };
  });
}

/** The chosen latency quantile per bucket, overall and per group, with idle buckets left empty. */
export function latencySeriesRows(
  buckets: readonly TrendsTelemetryBucket[],
  series: readonly TrendsTelemetrySeries[],
  measure: 'ttft' | 'latency',
  quantile: PerfQuantile = 'p50',
): Array<Record<string, number | null>> {
  const bySeries = new Map(series.map((group) => [group.id, new Map(group.buckets.map((bucket) => [bucket.start_ms, bucket]))]));
  const pick = (bucket: TrendsTelemetryBucket): number | null => {
    if (measure === 'ttft') return sampled(quantile === 'p50' ? bucket.ttft_p50_ms : bucket.ttft_p95_ms, bucket.ttft_samples);
    return sampled(quantile === 'p50' ? bucket.latency_p50_ms : bucket.latency_p95_ms, bucket.latency_samples);
  };
  return buckets.map((bucket) => {
    const row: Record<string, number | null> = { start: bucket.start_ms, [GLOBAL_SERIES_ID]: pick(bucket) };
    for (const group of series) {
      const own = bySeries.get(group.id)?.get(bucket.start_ms);
      row[perfSeriesKey(group.id)] = own ? pick(own) : null;
    }
    return row;
  });
}

/** Keeps only the ranked groups that have measured readings in the active speed view. */
export function perfSeriesForMode(
  series: readonly TrendsTelemetrySeries[],
  scatter: readonly TrendsScatterPoint[],
  mode: PerfMode,
): TrendsTelemetrySeries[] {
  if (mode === 'tps') {
    return series.filter((item) => item.tps_samples > 0 || item.buckets.some((bucket) => bucket.tps_samples > 0 && bucket.tps_p50 !== null));
  }
  if (mode === 'ttft') {
    return series.filter((item) => item.ttft_samples > 0 || item.buckets.some((bucket) => bucket.ttft_samples > 0 && (bucket.ttft_p50_ms !== null || bucket.ttft_p95_ms !== null)));
  }
  if (mode === 'latency') {
    return series.filter((item) => item.latency_samples > 0 || item.buckets.some((bucket) => bucket.latency_samples > 0 && (bucket.latency_p50_ms !== null || bucket.latency_p95_ms !== null)));
  }
  const hasMeasuredScatter = scatter.some((point) => point.ttft_ms !== null && point.latency_ms !== null);
  if (!hasMeasuredScatter) return [...series];
  const measured = new Set(scatter.filter((point) => !point.failed && point.ttft_ms !== null && point.latency_ms !== null).map((point) => point.group_id));
  return series.filter((item) => measured.has(item.id));
}

/** Selectable groups for latency filtering: full window list on live deployments, top series when only captured snapshots exist. */
export function availablePerfGroups(data: TrendsTelemetryResponse | undefined, includeAllGroups: boolean): readonly TrendsGroupName[] {
  if (!data) return [];
  const source = includeAllGroups && data.groups && data.groups.length > 0 ? data.groups : data.series;
  return source.filter((item) => item.id !== '' && !item.filter_disabled);
}

/** Buckets drawn for TTFT / total-latency mode, preferring in-memory top series before any filtered fallback read. */
export function resolvePerfBuckets(
  data: TrendsTelemetryResponse | undefined,
  mode: PerfMode,
  selectedItem: string | undefined,
  itemData?: TrendsTelemetryResponse,
): readonly TrendsTelemetryBucket[] {
  if (!data) return [];
  if ((mode !== 'ttft' && mode !== 'latency') || !selectedItem) return data.buckets;
  const matched = data.series.find((item) => item.id === selectedItem);
  if (matched) return matched.buckets;
  if (itemData) return itemData.buckets;
  return data.buckets;
}

export function perfBucketsHaveSamples(buckets: readonly TrendsTelemetryBucket[], mode: 'ttft' | 'latency'): boolean {
  return buckets.some((bucket) => (mode === 'ttft' ? bucket.ttft_samples : bucket.latency_samples) > 0);
}

export function perfModeHasSamples(
  data: TrendsTelemetryResponse | undefined,
  mode: PerfMode,
  activeBuckets: readonly TrendsTelemetryBucket[],
  modeSeries: readonly TrendsTelemetrySeries[],
): boolean {
  if (!data) return false;
  if (mode === 'ttft' || mode === 'latency') return perfBucketsHaveSamples(activeBuckets, mode);
  if (mode === 'tps') {
    return data.buckets.some((bucket) => bucket.tps_samples > 0 && bucket.tps_p50 !== null) || modeSeries.length > 0;
  }
  return data.scatter.some((point) => point.ttft_ms !== null && point.latency_ms !== null);
}

export const STABILITY_LANES = ['rate_limited_429', 'stream_truncated', 'force_cooldown', 'upstream_5xx', 'other_failures', 'model_substituted'] as const;
export type StabilityLane = (typeof STABILITY_LANES)[number];
export const STABILITY_FAILURE_LANES = ['rate_limited_429', 'stream_truncated', 'force_cooldown', 'upstream_5xx', 'other_failures'] as const;
export type StabilityFailureLane = (typeof STABILITY_FAILURE_LANES)[number];
export const STABILITY_ATTRIBUTION_DIMS = ['model', 'provider', 'credential'] as const;
export type StabilityAttributionDim = (typeof STABILITY_ATTRIBUTION_DIMS)[number];

export function isStabilityFailureLane(lane: StabilityLane | null | undefined): lane is StabilityFailureLane {
  return lane !== null && lane !== undefined && lane !== 'model_substituted';
}

export interface StabilityLaneRow {
  lane: StabilityLane;
  total: number;
  max: number;
  counts: number[];
}

export interface StabilityDisplayBucket {
  start_ms: number;
  last_start_ms: number;
  end_ms: number;
  span_count: number;
  total_requests: number;
  success_requests: number;
  failed_requests: number;
  rate_limited_429: number;
  stream_truncated: number;
  force_cooldown: number;
  upstream_5xx: number;
  other_failures: number;
  model_substituted: number;
}

/**
 * Aggregates adjacent telemetry buckets into coarser display cells whenever the bucket count
 * exceeds the lane track's cell budget so trailing buckets are never clipped.
 */
export function stabilityDisplayBuckets(
  buckets: readonly TrendsTelemetryBucket[],
  windowEndMs: number,
  maxCells?: number,
): StabilityDisplayBucket[] {
  if (buckets.length === 0) return [];
  const groupSize = maxCells && maxCells > 0 && buckets.length > maxCells
    ? Math.ceil(buckets.length / maxCells)
    : 1;
  const cells: StabilityDisplayBucket[] = [];
  for (let index = 0; index < buckets.length; index += groupSize) {
    const slice = buckets.slice(index, index + groupSize);
    const first = slice[0]!;
    const last = slice[slice.length - 1]!;
    const next = buckets[index + groupSize];
    const endMs = next ? next.start_ms : Math.max(last.start_ms, windowEndMs);
    let total_requests = 0;
    let success_requests = 0;
    let failed_requests = 0;
    let rate_limited_429 = 0;
    let stream_truncated = 0;
    let force_cooldown = 0;
    let upstream_5xx = 0;
    let other_failures = 0;
    let model_substituted = 0;
    for (const item of slice) {
      total_requests += item.total_requests;
      success_requests += item.success_requests;
      failed_requests += item.failed_requests;
      rate_limited_429 += item.rate_limited_429;
      stream_truncated += item.stream_truncated;
      force_cooldown += item.force_cooldown;
      upstream_5xx += item.upstream_5xx;
      other_failures += item.other_failures;
      model_substituted += item.model_substituted;
    }
    cells.push({
      start_ms: first.start_ms,
      last_start_ms: last.start_ms,
      end_ms: endMs,
      span_count: slice.length,
      total_requests,
      success_requests,
      failed_requests,
      rate_limited_429,
      stream_truncated,
      force_cooldown,
      upstream_5xx,
      other_failures,
      model_substituted,
    });
  }
  if (groupSize > 1 && cells.length >= 2) {
    const tail = cells[cells.length - 1]!;
    if (tail.span_count < groupSize) {
      const prev = cells[cells.length - 2]!;
      cells[cells.length - 2] = {
        start_ms: prev.start_ms,
        last_start_ms: tail.last_start_ms,
        end_ms: tail.end_ms,
        span_count: prev.span_count + tail.span_count,
        total_requests: prev.total_requests + tail.total_requests,
        success_requests: prev.success_requests + tail.success_requests,
        failed_requests: prev.failed_requests + tail.failed_requests,
        rate_limited_429: prev.rate_limited_429 + tail.rate_limited_429,
        stream_truncated: prev.stream_truncated + tail.stream_truncated,
        force_cooldown: prev.force_cooldown + tail.force_cooldown,
        upstream_5xx: prev.upstream_5xx + tail.upstream_5xx,
        other_failures: prev.other_failures + tail.other_failures,
        model_substituted: prev.model_substituted + tail.model_substituted,
      };
      cells.pop();
    }
  }
  return cells;
}

export interface StabilityAttributionPeer {
  id: string;
  label: string;
  count: number;
}

export interface StabilityAttributionRow {
  dimension: StabilityAttributionDim;
  /** Filterable id (`model`, `provider`, or `auth_index`); empty when unassigned. */
  id: string;
  /** Projected display label from the server. */
  label: string;
  /** Primary provider for credential rows, so credential failures show their provider context. */
  providerId?: string;
  providerLabel?: string;
  /** Complementary failing entities (providers for model rows; models for provider/credential rows). */
  peers: StabilityAttributionPeer[];
  /** Distinct non-empty credentials affected (for model/provider rows). */
  credentialCount: number;
  /** Failure count in the active scope (overall failures or selected lane). */
  failures: number;
  /** Total requests for this entity in the active scope (denominator for failure rate). */
  totalRequests: number;
  /** Share of failures (`failures / totalRequests`), or null when denominator is unknown/zero. */
  failureRate: number | null;
  lanes: Record<UsageFailureCategory, number>;
  statusCodes: TrendsStatusCount[];
  lastFailedAtMs: number;
  drillDisabled: boolean;
}

function statusMatchesLane(code: number, lane: UsageFailureCategory | null | undefined): boolean {
  if (!lane) return true;
  // Shared tuple status histograms cannot separate status codes belonging to protocol-level
  // stream_truncated or force_cooldown failures from co-occurring failures in the same tuple,
  // so omit shared status distributions when focused on those lanes.
  if (lane === 'stream_truncated' || lane === 'force_cooldown') return false;
  if (lane === 'rate_limited_429') return code === 429;
  if (lane === 'upstream_5xx') return code >= 500 && code < 600;
  return code !== 429 && !(code >= 500 && code < 600);
}

const STABILITY_FAILURE_LANES_LIST: readonly UsageFailureCategory[] = [
  'rate_limited_429',
  'upstream_5xx',
  'stream_truncated',
  'force_cooldown',
  'other_failures',
];

/**
 * True when every failure event recorded in `group` belongs exclusively to `lane`,
 * so tuple-level `last_failed_at_ms` is guaranteed to describe that lane alone.
 */
export function isFailureGroupExclusiveToLane(
  group: TrendsFailureGroup,
  lane: UsageFailureCategory,
): boolean {
  const laneCount = group[lane];
  if (laneCount <= 0) return false;
  if (group.failed_requests > laneCount) return false;
  return STABILITY_FAILURE_LANES_LIST.every((other) => other === lane || group[other] === 0);
}

/**
 * Rolls failure attribution tuples (`model × provider × credential`) up into a ranked list for one
 * dimension, optionally narrowed to a single failure lane. Entity denominators come from the
 * server's exact window totals rather than summing only failing channels.
 */
export function aggregateStabilityFailures(
  groups: readonly TrendsFailureGroup[] | undefined,
  dimension: StabilityAttributionDim,
  activeLane?: UsageFailureCategory | null,
  options?: { isPartial?: boolean },
): StabilityAttributionRow[] {
  if (!groups || groups.length === 0) return [];
  const isPartial = Boolean(options?.isPartial);
  type Acc = {
    id: string;
    label: string;
    providerCounts: Map<string, { id: string; label: string; count: number }>;
    peers: Map<string, StabilityAttributionPeer>;
    credentials: Set<string>;
    failures: number;
    totalRequests: number;
    lanes: Record<UsageFailureCategory, number>;
    statusCodes: Map<number, number>;
    lastFailedAtMs: number;
    isLastSeenExact: boolean;
    hasDrillableGroup: boolean;
  };
  const map = new Map<string, Acc>();

  for (const group of groups) {
    const count = activeLane
      ? group[activeLane]
      : Math.max(
          group.failed_requests,
          group.rate_limited_429,
          group.upstream_5xx,
          group.stream_truncated,
          group.force_cooldown,
          group.other_failures,
        );
    if (count <= 0) continue;

    let id: string;
    let label: string;
    let entityTotal: number;
    if (dimension === 'model') {
      id = group.model_id ?? group.model;
      label = group.model;
      entityTotal = id ? group.model_total_requests : 0;
    } else if (dimension === 'provider') {
      id = group.provider_id ?? group.provider;
      label = group.provider;
      entityTotal = id ? group.provider_total_requests : 0;
    } else {
      id = group.auth_index_id ?? group.auth_index ?? '';
      label = group.auth_index ?? '';
      // Unassigned credentials lack an all-requests denominator across non-failing tuples, so omit
      // the rate rather than computing it from failing tuples alone.
      entityTotal = id ? (group.credential_total_requests ?? 0) : 0;
    }

    const key = `${id}\u0000${label}`;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        id,
        label,
        providerCounts: new Map(),
        peers: new Map(),
        credentials: new Set(),
        failures: 0,
        totalRequests: 0,
        lanes: {
          rate_limited_429: 0,
          upstream_5xx: 0,
          stream_truncated: 0,
          force_cooldown: 0,
          other_failures: 0,
        },
        statusCodes: new Map(),
        lastFailedAtMs: 0,
        isLastSeenExact: true,
        hasDrillableGroup: false,
      };
      map.set(key, acc);
    }

    acc.failures += count;
    if (entityTotal > acc.totalRequests) {
      acc.totalRequests = entityTotal;
    }
    if (activeLane) {
      // Only record the selected lane's count; tuple-wide sibling lane counts do not prove
      // per-request intersection.
      acc.lanes[activeLane] += count;
      if (!isFailureGroupExclusiveToLane(group, activeLane)) {
        acc.isLastSeenExact = false;
      } else if ((group.last_failed_at_ms ?? 0) > acc.lastFailedAtMs) {
        acc.lastFailedAtMs = group.last_failed_at_ms ?? 0;
      }
    } else {
      acc.lanes.rate_limited_429 += group.rate_limited_429;
      acc.lanes.upstream_5xx += group.upstream_5xx;
      acc.lanes.stream_truncated += group.stream_truncated;
      acc.lanes.force_cooldown += group.force_cooldown;
      acc.lanes.other_failures += group.other_failures;
      if ((group.last_failed_at_ms ?? 0) > acc.lastFailedAtMs) {
        acc.lastFailedAtMs = group.last_failed_at_ms ?? 0;
      }
    }
    if (!group.drill_disabled && id !== '') {
      acc.hasDrillableGroup = true;
    }
    const credKey = group.auth_index_id ?? group.auth_index ?? '';
    if (credKey) acc.credentials.add(credKey);

    const provId = group.provider_id ?? group.provider;
    if (provId || group.provider) {
      const prev = acc.providerCounts.get(provId) ?? { id: provId, label: group.provider, count: 0 };
      prev.count += count;
      acc.providerCounts.set(provId, prev);
    }

    const peerId = dimension === 'model' ? provId : (group.model_id ?? group.model);
    const peerLabel = dimension === 'model' ? group.provider : group.model;
    if (peerId || peerLabel) {
      const peerKey = `${peerId}\u0000${peerLabel}`;
      const prevPeer = acc.peers.get(peerKey) ?? { id: peerId, label: peerLabel, count: 0 };
      prevPeer.count += count;
      acc.peers.set(peerKey, prevPeer);
    }

    const skipAmbiguousOtherStatuses =
      activeLane === 'other_failures' && (group.stream_truncated > 0 || group.force_cooldown > 0);
    if (!skipAmbiguousOtherStatuses) {
      for (const entry of group.status_codes ?? []) {
        if (entry.code <= 0 || entry.count <= 0) continue;
        if (!statusMatchesLane(entry.code, activeLane)) continue;
        acc.statusCodes.set(entry.code, (acc.statusCodes.get(entry.code) ?? 0) + entry.count);
      }
    }
  }

  return [...map.values()]
    .map<StabilityAttributionRow>((acc) => {
      const peers = [...acc.peers.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      const topProvider = [...acc.providerCounts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
      const statusCodes = [...acc.statusCodes.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code - b.code);
      const denominator = !isPartial && acc.totalRequests > 0 ? Math.max(acc.totalRequests, acc.failures) : 0;
      return {
        dimension,
        id: acc.id,
        label: acc.label,
        providerId: dimension === 'credential' ? topProvider?.id : undefined,
        providerLabel: dimension === 'credential' ? topProvider?.label : undefined,
        peers,
        credentialCount: acc.credentials.size,
        failures: acc.failures,
        totalRequests: denominator,
        failureRate: denominator > 0 ? acc.failures / denominator : null,
        lanes: acc.lanes,
        statusCodes,
        lastFailedAtMs: acc.isLastSeenExact ? acc.lastFailedAtMs : 0,
        drillDisabled: !acc.hasDrillableGroup,
      };
    })
    .sort((left, right) => {
      if (left.failures !== right.failures) return right.failures - left.failures;
      const lr = left.failureRate ?? -1;
      const rr = right.failureRate ?? -1;
      if (lr !== rr) return rr - lr;
      if (left.lastFailedAtMs !== right.lastFailedAtMs) return right.lastFailedAtMs - left.lastFailedAtMs;
      return left.label.localeCompare(right.label);
    });
}

/**
 * Derives failure attribution tuples from raw usage events (used as a clean fallback in Demo mode
 * when slicing a custom time cell whose telemetry snapshot was not pre-exported).
 *
 * `isCapped` marks a truncated sample (`has_more === true` or failure-only reads): when set,
 * entity totals are left as 0 so callers display exact sample counts without a misleading rate.
 */
export function deriveFailureGroupsFromEvents(
  events: readonly (UsageEvent & { fail_code?: string })[],
  options?: { isCapped?: boolean; omitUncategorizedOther?: boolean },
): TrendsFailureGroup[] {
  if (events.length === 0) return [];
  const isCapped = Boolean(options?.isCapped);
  const omitUncategorizedOther = Boolean(options?.omitUncategorizedOther);
  const modelTotals = new Map<string, number>();
  const providerTotals = new Map<string, number>();
  const credTotals = new Map<string, number>();
  const comboTotals = new Map<string, number>();
  type Acc = {
    model: string;
    provider: string;
    authIndex: string;
    failed: number;
    rl429: number;
    up5xx: number;
    truncated: number;
    cooldown: number;
    other: number;
    codes: Map<number, number>;
    lastMs: number;
  };
  const failed = new Map<string, Acc>();
  for (const event of events) {
    const model = event.model || '';
    const provider = event.provider || 'unknown';
    const authIndex = event.auth_index?.trim() || '';
    const key = `${model}\u0000${provider}\u0000${authIndex}`;
    modelTotals.set(model, (modelTotals.get(model) ?? 0) + 1);
    providerTotals.set(provider, (providerTotals.get(provider) ?? 0) + 1);
    if (authIndex) credTotals.set(authIndex, (credTotals.get(authIndex) ?? 0) + 1);
    comboTotals.set(key, (comboTotals.get(key) ?? 0) + 1);
    const failCode = event.fail_code ?? '';
    const isTruncated = failCode === 'stream_truncated';
    const isCooldown = failCode === 'force_cooldown';
    if (!event.failed && !isTruncated && !isCooldown) continue;
    let acc = failed.get(key);
    if (!acc) {
      acc = {
        model,
        provider,
        authIndex,
        failed: 0,
        rl429: 0,
        up5xx: 0,
        truncated: 0,
        cooldown: 0,
        other: 0,
        codes: new Map(),
        lastMs: 0,
      };
      failed.set(key, acc);
    }
    if (event.failed) acc.failed += 1;
    const code = event.fail_status_code ?? 0;
    const is429 = event.failed && code === 429;
    const is5xx = event.failed && code >= 500 && code < 600;
    if (is429) acc.rl429 += 1;
    if (is5xx) acc.up5xx += 1;
    if (isTruncated) acc.truncated += 1;
    if (isCooldown) acc.cooldown += 1;
    if (
      event.failed &&
      !is429 &&
      !is5xx &&
      !isTruncated &&
      !isCooldown &&
      (!omitUncategorizedOther || event.fail_code !== undefined)
    ) {
      acc.other += 1;
    }
    if (code > 0) acc.codes.set(code, (acc.codes.get(code) ?? 0) + 1);
    if (event.timestamp_ms > acc.lastMs) acc.lastMs = event.timestamp_ms;
  }
  return [...failed.entries()].map(([key, acc]) => ({
    model: acc.model,
    provider: acc.provider,
    auth_index: acc.authIndex || undefined,
    total_requests: isCapped ? 0 : (comboTotals.get(key) ?? acc.failed),
    model_total_requests: isCapped ? 0 : (modelTotals.get(acc.model) ?? acc.failed),
    provider_total_requests: isCapped ? 0 : (providerTotals.get(acc.provider) ?? acc.failed),
    credential_total_requests: !isCapped && acc.authIndex ? credTotals.get(acc.authIndex) : undefined,
    failed_requests: acc.failed,
    rate_limited_429: acc.rl429,
    upstream_5xx: acc.up5xx,
    stream_truncated: acc.truncated,
    force_cooldown: acc.cooldown,
    other_failures: acc.other,
    status_codes: [...acc.codes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code - b.code),
    last_failed_at_ms: acc.lastMs,
  }));
}

/** Derives substitution pairs from raw usage events for Demo mode cell slices. */
export function deriveSubstitutionPairsFromEvents(events: readonly UsageEvent[]): TrendsSubstitutionPair[] {
  const counts = new Map<string, TrendsSubstitutionPair>();
  for (const event of events) {
    if (!event.model_substituted || !event.response_model) continue;
    const requested = event.model || '';
    const served = event.response_model;
    const provider = event.provider || 'unknown';
    const key = `${requested}\u0000${served}\u0000${provider}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { requested_model: requested, served_model: served, provider, count: 1 });
    }
  }
  return [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.requested_model.localeCompare(b.requested_model) ||
      a.served_model.localeCompare(b.served_model) ||
      a.provider.localeCompare(b.provider),
  );
}

/** Query string for Demo mode cell attribution: reads all requests (successes + failures) so denominators stay honest. */
export function stabilityDemoSliceEventsQueryString(
  window: Pick<InsightsWindow, 'from' | 'to'>,
  filters: TrendsFilters,
  cell: Pick<StabilityDisplayBucket, 'start_ms' | 'end_ms'>,
  limit = 200,
): string | null {
  const span = stabilityWindowForCell(window, cell);
  if (!span) return null;
  const href = trendsEventsHref(span, filters, { result: 'all', limit: String(limit) }, { isDemo: true });
  if (!href) return null;
  const queryStart = href.indexOf('?');
  return queryStart >= 0 ? href.slice(queryStart + 1) : '';
}

export function stabilityFilterKeyForDim(dimension: StabilityAttributionDim): TrendsFilterKey {
  switch (dimension) {
    case 'model': return 'model';
    case 'provider': return 'provider';
    case 'credential': return 'auth_index';
  }
}

/**
 * Clamps a stability display cell's span inside the resolved window. Returns `null` when the
 * intersection is a single instant (`to <= from`), because both `/trends/telemetry` and
 * `/usage/events` reject `from >= to` and widening `to` would spill into the next bucket.
 */
export function stabilityWindowForCell(
  window: Pick<InsightsWindow, 'from' | 'to'>,
  cell: Pick<StabilityDisplayBucket, 'start_ms' | 'end_ms'>,
): { from: number; to: number; open_end: false } | null {
  const from = Math.max(window.from, cell.start_ms);
  const rawEnd = cell.end_ms > cell.start_ms ? cell.end_ms - 1 : cell.end_ms;
  const clampedEnd = Math.min(window.to, rawEnd);
  if (clampedEnd <= from) return null;
  return { from, to: clampedEnd, open_end: false };
}

/** Query string for fetching exact failure attribution & substitutions inside one clicked stability cell. */
export function stabilitySliceTelemetryParams(
  window: Pick<InsightsWindow, 'from' | 'to'>,
  cell: Pick<StabilityDisplayBucket, 'start_ms' | 'end_ms'>,
  filters: TrendsFilters,
): string | null {
  const span = stabilityWindowForCell(window, cell);
  if (!span) return null;
  const params = new URLSearchParams();
  params.set('from', String(span.from));
  params.set('to', String(span.to));
  params.set('top', '1');
  appendFilters(params, filters);
  return params.toString();
}

export interface StabilityDrillScope {
  lane?: StabilityLane | null;
  cell?: Pick<StabilityDisplayBucket, 'start_ms' | 'end_ms'> | null;
  entity?: { dimension: StabilityAttributionDim; id: string } | null;
  limit?: number;
}

/** Query string (without leading `?`) for fetching or opening request records matching a stability focus. */
export function stabilityEventsQueryString(
  window: Pick<InsightsWindow, 'from' | 'to' | 'open_end'>,
  filters: TrendsFilters,
  scope: StabilityDrillScope,
  options?: { isDemo?: boolean },
): string | null {
  const targetWindow = scope.cell ? stabilityWindowForCell(window, scope.cell) : window;
  if (!targetWindow) return null;
  const narrowed: TrendsFilters = { ...filters };
  if (scope.entity) {
    if (!scope.entity.id) return null;
    const key = stabilityFilterKeyForDim(scope.entity.dimension);
    narrowed[key] = [scope.entity.id];
  }
  const extra: Record<string, string> = {};
  if (scope.lane === 'model_substituted') {
    extra.served = 'substituted';
  } else if (isStabilityFailureLane(scope.lane)) {
    if (scope.lane !== 'stream_truncated' && scope.lane !== 'force_cooldown') {
      extra.result = 'failed';
    }
    extra.failure = scope.lane;
  } else {
    extra.result = 'failed';
  }
  if (scope.limit !== undefined) extra.limit = String(scope.limit);
  const href = trendsEventsHref(targetWindow, narrowed, extra, { isDemo: options?.isDemo });
  if (!href) return null;
  const queryStart = href.indexOf('?');
  return queryStart >= 0 ? href.slice(queryStart + 1) : '';
}

/** Full `/usage/events?...` link for a stability lane, cell, or failing entity. */
export function stabilityEventsHref(
  window: Pick<InsightsWindow, 'from' | 'to' | 'open_end'>,
  filters: TrendsFilters,
  scope: StabilityDrillScope,
  options?: { isDemo?: boolean },
): string | null {
  const query = stabilityEventsQueryString(window, filters, scope, options);
  return query === null ? null : `/usage/events?${query}`;
}

export function stabilityLanes(buckets: readonly Pick<TrendsTelemetryBucket, StabilityLane>[]): StabilityLaneRow[] {
  return STABILITY_LANES.map((lane) => {
    const counts = buckets.map((bucket) => bucket[lane]);
    return { lane, counts, total: counts.reduce((sum, count) => sum + count, 0), max: Math.max(0, ...counts) };
  });
}

/** The failure share at which a stability cell reaches full strength: the attribution table's danger band. */
export const STABILITY_SATURATION_RATE = 0.2;
/** The faintest a cell with any event is drawn, so a single failure stays visible on the track. */
const STABILITY_MIN_WEIGHT = 24;
/** The strongest a cell is drawn; even an outage stops short of the raw state hue. */
const STABILITY_MAX_WEIGHT = 88;

/**
 * How strongly a stability cell is tinted, in percent of its lane hue. Strength follows the share of
 * the cell's requests the lane caught, not the count against the lane's own peak: one failure among
 * thousands of answers stays a faint mark instead of a full red block. The square root keeps small
 * shares distinguishable from each other.
 */
export function stabilityCellWeight(count: number, totalRequests: number): number {
  if (count <= 0) return 0;
  const share = totalRequests > 0 ? Math.min(1, count / totalRequests / STABILITY_SATURATION_RATE) : 1;
  return Math.round(STABILITY_MIN_WEIGHT + (STABILITY_MAX_WEIGHT - STABILITY_MIN_WEIGHT) * Math.sqrt(share));
}

export function hasStabilityActivity(data: Pick<TrendsTelemetryResponse, 'buckets' | 'substitution_pairs'>): boolean {
  return data.substitution_pairs.length > 0 || stabilityLanes(data.buckets).some((lane) => lane.total > 0);
}

/** The share of requests that succeeded, or null without any. */
export function successRate(summary: Pick<TrendsTelemetrySummary, 'total_requests' | 'success_requests'>): number | null {
  return summary.total_requests > 0 ? summary.success_requests / summary.total_requests : null;
}

export const HOUR_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;

export function isRangeWithinHourLimit(range: InsightsRange, nowMs = Date.now()): boolean {
  if (range.from !== undefined) {
    const end = typeof range.to === 'number' ? range.to : nowMs;
    return end - range.from <= HOUR_LIMIT_MS;
  }
  const preset = range.preset ?? '7d';
  if (preset === 'this_month') {
    const cur = dayjs(nowMs);
    const startOfMonth = cur.subtract(cur.date() - 1, 'day').startOf('day').valueOf();
    return nowMs - startOfMonth <= HOUR_LIMIT_MS;
  }
  return preset !== '30d' && preset !== '90d' && preset !== 'all' && preset !== 'last_month';
}

// ── Drill links ────────────────────────────────────────────────────────────

/**
 * The request-list link behind a view. The window is the one the server resolved; one that follows
 * the clock keeps following it. A filter past the list's ceiling would open on fewer records than the
 * page counted, so the link is withheld instead.
 */
export function trendsEventsHref(
  window: Pick<InsightsWindow, 'from' | 'to' | 'open_end'> | { from: number; to: number | null },
  filters: TrendsFilters,
  extra: Record<string, string> = {},
  options?: { isDemo?: boolean; extraMulti?: Record<string, readonly string[]> },
): string | null {
  if (TRENDS_FILTER_KEYS.some((key) => (filters[key]?.length ?? 0) > MAX_USAGE_EVENT_FILTER_VALUES)) return null;
  if (options?.isDemo && TRENDS_FILTER_KEYS.some((key) => (filters[key] ?? []).some((value) => value.startsWith('redacted:')))) {
    return null;
  }
  if (options?.isDemo && options.extraMulti && Object.values(options.extraMulti).some((values) => values.some((value) => value.startsWith('redacted:')))) {
    return null;
  }
  const params = new URLSearchParams();
  params.set('from', String(window.from));
  const isOpen = 'open_end' in window ? window.open_end : window.to === null;
  if (!isOpen && window.to !== null) params.set('to', String(window.to));
  if (options?.isDemo) params.set('replay', 'calendar');
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  appendFilters(params, filters);
  if (options?.extraMulti) {
    for (const [key, values] of Object.entries(options.extraMulti)) {
      for (const value of values) {
        if (value) params.append(key, value);
      }
    }
  }
  return `/usage/events?${params.toString()}`;
}

/** A substitution pair's records: the exact requested model and served model on that provider. */
export function substitutionEventsHref(
  window: Pick<InsightsWindow, 'from' | 'to' | 'open_end'>,
  filters: TrendsFilters,
  pair: Pick<TrendsSubstitutionPair, 'requested_model' | 'served_model' | 'provider' | 'requested_id' | 'served_id' | 'provider_id' | 'drill_disabled'>,
  options?: { isDemo?: boolean },
): string | null {
  if (pair.drill_disabled) return null;
  const requested = pair.requested_id ?? pair.requested_model;
  const served = pair.served_id ?? pair.served_model;
  const provider = pair.provider_id ?? pair.provider;
  const narrowed: TrendsFilters = { ...filters, model: [requested] };
  if (provider) narrowed.provider = [provider];
  return trendsEventsHref(
    window,
    narrowed,
    { served: 'substituted' },
    { isDemo: options?.isDemo, extraMulti: served ? { response_model: [served] } : undefined },
  );
}

/** One credential's records over its current cycle, through now when the cycle is still running. */
export function quotaEventsHref(credential: string, window: TrendsQuotaWindow, nowMs: number): string | null {
  const to = window.cycle_reset_ms <= nowMs ? window.cycle_reset_ms : null;
  return trendsEventsHref({ from: window.cycle_start_ms, to }, { auth_index: [credential] });
}
