import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_TRENDS_VIEW,
  HOUR_LIMIT_MS,
  availablePerfGroups,
  buildQuotaBurnSeries,
  clampLens,
  countdownParts,
  filterGroupByForKey,
  filterKeyForGroupBy,
  formatPercent,
  isRangeWithinHourLimit,
  latencySeriesRows,
  lensFromSweep,
  nearestPointIndex,
  omitTrendsFilter,
  panLens,
  percentileRows,
  perfBucketsHaveSamples,
  perfSeriesForMode,
  perfSeriesKey,
  pickQuotaWindow,
  quotaCredentialAttention,
  quotaRisk,
  quotaWindowAttention,
  quotaCycleBars,
  quotaDivider,
  quotaEventsHref,
  quotaLensMinSpan,
  quotaWindowName,
  readTrendsView,
  resolvePerfBuckets,
  stabilityLanes,
  stepPointIndex,
  substitutionEventsHref,
  successRate,
  toggleTrendsFilter,
  tpsRows,
  trendsEventsHref,
  trendsFilterDimensions,
  trendsFilterOptions,
  trendsQuotaParams,
  trendsWindowParams,
  usageGroupBy,
  writeTrendsView,
  zoomLens,
  GLOBAL_SERIES_ID,
} from '../../src/pages/trends/trendsLogic.ts';
import { readEventQuery } from '../../src/types/usageEventQuery.ts';
import { MAX_USAGE_EVENT_FILTER_VALUES } from '../../src/types/usageEvents.ts';
import type { TrendsQuotaCredential, TrendsQuotaWindow, TrendsTelemetryBucket } from '../../src/types/trends.ts';
import type { TFunc } from '../../src/i18n/index.tsx';
import { CATALOGS } from '../../src/i18n/resources.ts';
import { formatMessage } from '../../src/i18n/format.ts';
import { languageLocale } from '../../src/i18n/language.ts';

const HOUR = 3_600_000;

function quotaWindow(patch: Partial<TrendsQuotaWindow> = {}): TrendsQuotaWindow {
  return {
    window_id: '5h', period_hours: 5, cycle_start_ms: 0, cycle_reset_ms: 5 * HOUR,
    used_percent: 60, remaining_percent: 40, status: 'projected_exhaust',
    current_requests: 30, current_net_tokens: 9000, current_total_tokens: 12000, current_cost_nanos: 0,
    buckets: [
      { start_ms: 0, end_ms: HOUR, used_percent: 25, delta_percent: 25, requests: 10, net_tokens: 3000, total_tokens: 4000, is_forecast: false },
      { start_ms: HOUR, end_ms: 2 * HOUR, used_percent: 60, delta_percent: 35, requests: 20, net_tokens: 6000, total_tokens: 8000, is_forecast: false },
      { start_ms: 2 * HOUR, end_ms: 5 * HOUR, used_percent: 140, delta_percent: 80, requests: 0, net_tokens: 0, total_tokens: 0, is_forecast: true },
    ],
    cycles: [
      { cycle_start_ms: 0, cycle_reset_ms: 5 * HOUR, is_current: true, used_percent: 60, actual_requests: 30, actual_net_tokens: 9000, actual_total_tokens: 12000 },
      { cycle_start_ms: -5 * HOUR, cycle_reset_ms: 0, is_current: false, used_percent: 50, actual_requests: 40, actual_net_tokens: 8000, actual_total_tokens: 10000, full_requests: 80, full_net_tokens: 16000 },
    ],
    ...patch,
  };
}

function credential(authIndex: string, windows: TrendsQuotaWindow[]): TrendsQuotaCredential {
  return { auth_index: authIndex, provider: 'codex', account_label: `a…${authIndex}`, status: 'active', observed_at_ms: 0, windows };
}

function telemetryBucket(start: number, patch: Partial<TrendsTelemetryBucket> = {}): TrendsTelemetryBucket {
  return {
    start_ms: start, total_requests: 0, success_requests: 0, failed_requests: 0, rate_limited_429: 0, upstream_5xx: 0,
    stream_truncated: 0, force_cooldown: 0, other_failures: 0, model_substituted: 0, tps_mean: null, tps_p50: null,
    tps_samples: 0, ttft_p50_ms: null, ttft_p95_ms: null, ttft_samples: 0, latency_p50_ms: null, latency_p95_ms: null,
    latency_samples: 0, ...patch,
  };
}

test('trends view round-trips through the URL and leaves defaults out', () => {
  assert.equal(writeTrendsView(DEFAULT_TRENDS_VIEW).toString(), '');
  const view = readTrendsView(new URLSearchParams('group=key&perf=scatter&perf_group=provider&perf_item=codex&bucket=day&quota_auth=c1&quota_window=7d&model=gpt-5&model=gpt-5&provider=%20codex%20&perf=bogus'));
  assert.equal(view.usageGroup, 'key');
  assert.equal(view.perfMode, 'scatter');
  assert.equal(view.perfGroup, 'provider');
  assert.equal(view.perfItem, 'codex');
  assert.equal(view.bucket, 'day');
  assert.equal(view.quotaCredential, 'c1');
  assert.equal(view.quotaWindow, '7d');
  assert.deepEqual(view.filters, { model: ['gpt-5'], provider: ['codex'] });
  assert.deepEqual(readTrendsView(writeTrendsView(view)), view);
  const latencyView = readTrendsView(new URLSearchParams('perf=latency&perf_item=gpt-5'));
  assert.equal(latencyView.perfMode, 'latency');
  assert.equal(latencyView.perfItem, 'gpt-5');
  assert.deepEqual(readTrendsView(writeTrendsView(latencyView)), latencyView);
  assert.equal(readTrendsView(new URLSearchParams('perf=bogus')).perfMode, 'tps');

  const added = toggleTrendsFilter({}, 'api_key', 'hmac:a');
  assert.deepEqual(added, { api_key: ['hmac:a'] });
  assert.deepEqual(toggleTrendsFilter(added, 'api_key', 'hmac:a'), {});
});

test('trends reads spell the grouping and filters in the server vocabulary', () => {
  assert.equal(usageGroupBy('model', 'call'), 'call_point');
  assert.equal(usageGroupBy('model', 'model'), 'model');
  assert.equal(usageGroupBy('credential', 'model'), 'credential');
  assert.equal(filterKeyForGroupBy('call_point'), 'model_alias');
  assert.equal(filterKeyForGroupBy('key'), 'api_key');
  assert.equal(filterKeyForGroupBy('credential'), 'auth_index');
  assert.equal(filterKeyForGroupBy('bogus'), null);

  // The server's default grouping stays implicit, so the demonstration's captured reads match.
  assert.equal(trendsWindowParams({ preset: '7d' }, 'auto', 'model', {}), 'preset=7d');
  const params = new URLSearchParams(trendsWindowParams({ from: 1000, to: null }, 'day', 'client_agent', { api_key: ['hmac:a'], auth_index: ['c1'] }));
  assert.equal(params.get('from'), '1000');
  assert.equal(params.has('to'), false);
  assert.equal(params.get('bucket'), 'day');
  assert.equal(params.get('group_by'), 'client_agent');
  assert.deepEqual(params.getAll('api_key'), ['hmac:a']);
  // The quota read takes the connection filters only.
  assert.equal(trendsQuotaParams({ model: ['gpt-5'], provider: ['codex'], auth_index: ['c1'] }), 'provider=codex&auth_index=c1');

  // Filter bar dimension & option helpers keep active model view and omit the active dimension's own filter.
  assert.equal(filterGroupByForKey('api_key'), 'key');
  assert.equal(filterGroupByForKey('auth_index'), 'credential');
  assert.deepEqual(trendsFilterDimensions('model'), ['api_key', 'model', 'provider', 'auth_index', 'client_agent']);
  assert.deepEqual(trendsFilterDimensions('call'), ['api_key', 'model_alias', 'provider', 'auth_index', 'client_agent']);
  assert.deepEqual(omitTrendsFilter({ model: ['gpt-5'], provider: ['codex'] }, 'provider'), { model: ['gpt-5'] });
});

test('quota burn splits the measured curve from its projection at one shared point', () => {
  const window = quotaWindow();
  const points = buildQuotaBurnSeries(window);
  assert.deepEqual(points.map((point) => point.t), [0, HOUR, 2 * HOUR, 5 * HOUR]);
  assert.deepEqual(points.map((point) => point.actual), [0, 25, 60, null]);
  // The last measured reading starts the projection too, so the two lines meet without a gap.
  assert.deepEqual(points.map((point) => point.forecast), [null, null, 60, 140]);
  assert.equal(points[3]!.isForecast, true);
  assert.equal(quotaDivider(window), 2 * HOUR);
  assert.equal(quotaDivider(quotaWindow({ exhausted_at_ms: 90 * 60_000 })), 90 * 60_000);
  assert.deepEqual(buildQuotaBurnSeries(quotaWindow({ buckets: [] })), []);

  // A projected exhaustion inside the forecast span adds a 100% milestone point at that exact instant.
  const withMilestone = buildQuotaBurnSeries(quotaWindow({ projected_exhaust_at_ms: 3.5 * HOUR }));
  assert.deepEqual(withMilestone.map((point) => point.t), [0, HOUR, 2 * HOUR, 3.5 * HOUR, 5 * HOUR]);
  assert.equal(withMilestone[3]!.isExhaustMilestone, true);
  assert.equal(withMilestone[3]!.used, 100);
  assert.equal(withMilestone[3]!.forecast, 100);
  // Already-exhausted windows or exhaustions past reset do not add a synthetic milestone.
  assert.equal(buildQuotaBurnSeries(quotaWindow({ exhausted_at_ms: 2 * HOUR, projected_exhaust_at_ms: 3.5 * HOUR })).some((p) => p.isExhaustMilestone), false);
  assert.equal(buildQuotaBurnSeries(quotaWindow({ projected_exhaust_at_ms: 6 * HOUR })).some((p) => p.isExhaustMilestone), false);

  // Pointer and keyboard land on the nearest reading and stay inside the curve.
  assert.equal(nearestPointIndex(points, 1.4 * HOUR), 1);
  assert.equal(stepPointIndex(null, 'ArrowRight', 4), 0);
  assert.equal(stepPointIndex(null, 'ArrowLeft', 4), 3);
  assert.equal(stepPointIndex(3, 'ArrowRight', 4), 3);
  assert.equal(stepPointIndex(1, 'ArrowLeft', 4), 0);
  assert.equal(stepPointIndex(2, 'Home', 4), 0);
  assert.equal(stepPointIndex(2, 'a', 4), 2);
  assert.equal(stepPointIndex(null, 'ArrowRight', 0), null);
});

test('quota card opens on the requested window or the most pressing one', () => {
  const calm = quotaWindow({ window_id: '7d', status: 'normal', used_percent: 20 });
  const hot = quotaWindow({ window_id: '5h', status: 'limit_reached', used_percent: 100 });
  const items = [credential('c1', [calm]), credential('c2', [calm, hot]), credential('c3', [quotaWindow({ cycle_reset_ms: 0 })])];
  const pressing = pickQuotaWindow(items, undefined, undefined)!;
  assert.equal(pressing.credential.auth_index, 'c2');
  assert.equal(pressing.window.window_id, '5h');
  const asked = pickQuotaWindow(items, 'c2', '7d')!;
  assert.equal(asked.window.window_id, '7d');
  // A credential with no cycle to draw is skipped rather than opened empty.
  assert.equal(pickQuotaWindow(items, 'c3', undefined)!.credential.auth_index, 'c2');
  assert.equal(pickQuotaWindow([], undefined, undefined), null);

  // Risk counts only credentials with a cycle to project, each once by its worst window.
  const heading = quotaWindow({ window_id: '5h', status: 'projected_exhaust', projected_exhaust_at_ms: HOUR });
  const plugin = credential('p1', []);
  const unverified = { ...credential('u1', [hot]), status: 'unknown' };
  assert.deepEqual(
    quotaRisk([credential('c1', [calm]), credential('c2', [hot, heading]), credential('c3', [heading]), plugin, items[2]!, unverified]),
    { forecastable: 3, limited: 1, projected: 1 },
  );
  // A picker flags a window by its own state and a credential by its worst window.
  assert.deepEqual([calm, hot, heading].map(quotaWindowAttention), [null, 'danger', 'warn']);
  assert.deepEqual([credential('c1', [calm]), credential('c2', [heading, hot]), credential('c3', [calm, heading]), plugin].map(quotaCredentialAttention), [null, 'danger', 'warn', null]);

  const bars = quotaCycleBars(quotaWindow(), 'net_tokens');
  assert.deepEqual(bars.map((bar) => [bar.start, bar.actual, bar.full, bar.isCurrent]), [[-5 * HOUR, 8000, 16000, false], [0, 9000, null, true]]);
  assert.deepEqual(quotaCycleBars(quotaWindow(), 'requests').map((bar) => bar.full), [80, null]);

  assert.deepEqual(countdownParts((2 * 24 * 60 + 3 * 60 + 5) * 60_000 + 59_000), { days: 2, hours: 3, minutes: 5 });
  assert.deepEqual(countdownParts(-1), { days: 0, hours: 0, minutes: 0 });
  assert.equal(formatPercent(62.345), '62.3%');
  assert.equal(formatPercent(140.2), '140%');
  assert.equal(formatPercent(null), '—');
});

test('telemetry gaps stay gaps and stability lanes count each failure kind', () => {
  const buckets = [
    telemetryBucket(0, { total_requests: 4, success_requests: 3, rate_limited_429: 1, tps_p50: 40, tps_samples: 3, ttft_p50_ms: 800, ttft_p95_ms: 1500, ttft_samples: 3 }),
    telemetryBucket(HOUR),
    telemetryBucket(2 * HOUR, { total_requests: 2, success_requests: 1, upstream_5xx: 1, model_substituted: 2, tps_p50: 55, tps_samples: 1, ttft_p50_ms: 600, ttft_p95_ms: 500, ttft_samples: 1 }),
  ];
  const series = [{ id: 'gpt-5', label: 'gpt-5', ...buckets[0]!, buckets: [buckets[0]!] }];
  const tps = tpsRows(buckets, series);
  assert.deepEqual(tps.map((row) => row[GLOBAL_SERIES_ID]), [40, null, 55]);
  // A group absent from a bucket is no reading there, never zero.
  assert.deepEqual(tps.map((row) => row[perfSeriesKey('gpt-5')]), [40, null, null]);
  // A group named "start" does not overwrite the bucket timestamp field.
  const startGroupSeries = [{ id: 'start', label: 'start', ...buckets[0]!, buckets: [buckets[0]!] }];
  const tpsWithStart = tpsRows(buckets, startGroupSeries);
  assert.equal(tpsWithStart[0]!.start, 0);
  assert.equal(tpsWithStart[0]![perfSeriesKey('start')], 40);

  const ttft = percentileRows(buckets, 'ttft');
  assert.deepEqual(ttft.map((row) => row.band), [[800, 1500], null, [600, 600]]);
  assert.deepEqual(percentileRows(buckets, 'latency').map((row) => row.p50), [null, null, null]);

  const lanes = stabilityLanes(buckets);
  assert.deepEqual(lanes.map((lane) => [lane.lane, lane.total, lane.max]), [
    ['rate_limited_429', 1, 1], ['stream_truncated', 0, 0], ['force_cooldown', 0, 0], ['upstream_5xx', 1, 1], ['other_failures', 0, 0], ['model_substituted', 2, 2],
  ]);
  assert.deepEqual(lanes[5]!.counts, [0, 0, 2]);
  assert.equal(successRate({ total_requests: 4, success_requests: 3 }), 0.75);
  assert.equal(successRate({ total_requests: 0, success_requests: 0 }), null);

  // Performance latency filtering resolves in-memory top series or an on-demand item read.
  const modelBucket = telemetryBucket(0, { ttft_p50_ms: 250, ttft_p95_ms: 400, ttft_samples: 2 });
  const tailBucket = telemetryBucket(0, { latency_p50_ms: 1800, latency_p95_ms: 2900, latency_samples: 4 });
  const telemetry = {
    window: { preset: '7d', from: 0, to: 3 * HOUR - 1, open_end: true, bucket: 'hour' as const, timezone: 'UTC', widened: false },
    tps_mode: 'exclude_ttft' as const,
    group_by: 'model',
    summary: buckets[0]!,
    buckets,
    groups: [{ id: 'gpt-5', label: 'gpt-5' }, { id: 'tail-model', label: 'tail-model' }, { id: '', label: 'unknown' }],
    series: [{ ...buckets[0]!, id: 'gpt-5', label: 'gpt-5', buckets: [modelBucket] }],
    scatter: [],
    substitution_pairs: [],
    coverage: { fact_requests: 6, retained_requests: 6, is_truncated_by_retention: false },
  };
  const tailTelemetry = { ...telemetry, buckets: [tailBucket] };
  assert.deepEqual(availablePerfGroups(telemetry, true).map((g) => g.id), ['gpt-5', 'tail-model']);
  assert.deepEqual(availablePerfGroups(telemetry, false).map((g) => g.id), ['gpt-5']);
  assert.equal(resolvePerfBuckets(telemetry, 'ttft', undefined), buckets);
  assert.deepEqual(resolvePerfBuckets(telemetry, 'ttft', 'gpt-5'), [modelBucket]);
  assert.deepEqual(resolvePerfBuckets(telemetry, 'latency', 'tail-model', tailTelemetry), [tailBucket]);
  assert.equal(resolvePerfBuckets(telemetry, 'tps', 'gpt-5'), buckets);
  assert.equal(perfBucketsHaveSamples([modelBucket], 'ttft'), true);
  assert.equal(perfBucketsHaveSamples([modelBucket], 'latency'), false);

  // Per-model latency series keep gaps as nulls and switch cleanly between P50 and P95.
  const ttftP50 = latencySeriesRows(buckets, telemetry.series, 'ttft', 'p50');
  assert.deepEqual(ttftP50.map((row) => row[GLOBAL_SERIES_ID]), [800, null, 600]);
  assert.deepEqual(ttftP50.map((row) => row[perfSeriesKey('gpt-5')]), [250, null, null]);
  const ttftP95 = latencySeriesRows(buckets, telemetry.series, 'ttft', 'p95');
  assert.deepEqual(ttftP95.map((row) => row[GLOBAL_SERIES_ID]), [1500, null, 500]);
  assert.deepEqual(ttftP95.map((row) => row[perfSeriesKey('gpt-5')]), [400, null, null]);
  const noTtftSeries = [{ ...buckets[1]!, id: 'non-stream', label: 'non-stream', buckets: [tailBucket] }];
  assert.deepEqual(perfSeriesForMode([...telemetry.series, ...noTtftSeries], [], 'ttft').map((g) => g.id), ['gpt-5']);
  assert.deepEqual(perfSeriesForMode([...telemetry.series, ...noTtftSeries], [], 'latency').map((g) => g.id), ['non-stream']);

  // Filter options prefer full `groups` list and fall back to series/movers cleanly.
  assert.deepEqual(
    trendsFilterOptions({
      window: telemetry.window,
      compare_window: null,
      group_by: 'provider',
      totals: { requests: 10, failures: 0, net_tokens: 100, total_tokens: 100, cost_nanos: 0, prompt_tokens: 100, completion_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cache_rate: null, reasoning_share: null, priced_requests: 0, costed_requests: 0 },
      buckets: [],
      groups: [
        { id: 'codex', label: 'codex', requests: 8 },
        { id: 'masked', label: 'masked', requests: 3, filter_disabled: true },
        { id: '', label: 'unknown', requests: 2 },
      ],
      series: [],
      movers: { metric: 'net_tokens', risers: [], fallers: [] },
      coverage: { fact_requests: 10, detail_requests: 10 },
    }),
    [{ id: 'codex', label: 'codex', requests: 8 }],
  );
});

test('trends drill links open the request list on the records the page counted', () => {
  const window = { from: 1000, to: 9999, open_end: false };
  const href = trendsEventsHref(window, { api_key: ['hmac:a'], model_alias: ['sonnet'] })!;
  const query = readEventQuery(new URLSearchParams(href.split('?')[1]));
  assert.equal(query.from, 1000);
  assert.equal(query.to, 9999);
  assert.deepEqual(query.filters, { api_key: ['hmac:a'], model_alias: ['sonnet'] });
  // A window that follows the clock keeps following it.
  assert.equal(new URLSearchParams(trendsEventsHref({ ...window, open_end: true }, {})!.split('?')[1]).has('to'), false);
  assert.equal(trendsEventsHref(window, { model: Array.from({ length: MAX_USAGE_EVENT_FILTER_VALUES + 1 }, (_, index) => `m${index}`) }), null);

  const substitution = new URLSearchParams(substitutionEventsHref(window, { model: ['other'] }, { requested_model: 'gpt-5', served_model: 'gpt-5-mini', provider: 'codex' })!.split('?')[1]);
  assert.equal(substitution.get('served'), 'substituted');
  assert.deepEqual(substitution.getAll('model'), ['gpt-5']);
  assert.deepEqual(substitution.getAll('response_model'), ['gpt-5-mini']);
  assert.deepEqual(substitution.getAll('provider'), ['codex']);
  assert.equal(readEventQuery(substitution).served, 'substituted');
  assert.equal(
    substitutionEventsHref(window, {}, { requested_model: 'redacted:req', served_model: 'redacted:srv', provider: 'codex', drill_disabled: true }),
    null,
  );
  assert.equal(
    substitutionEventsHref(window, {}, { requested_model: 'gpt-5', served_model: 'redacted:srv', provider: 'codex', requested_id: 'gpt-5', served_id: 'redacted:srv', provider_id: 'codex' }, { isDemo: true }),
    null,
  );
  assert.equal(
    new URLSearchParams(
      substitutionEventsHref(window, {}, { requested_model: 'gpt-5', served_model: 'gpt-5-mini', provider: 'codex' }, { isDemo: true })!.split('?')[1],
    ).get('replay'),
    'calendar',
  );

  const running = new URLSearchParams(quotaEventsHref('c1', quotaWindow(), HOUR)!.split('?')[1]);
  assert.equal(running.get('from'), '0');
  assert.equal(running.has('to'), false);
  assert.deepEqual(running.getAll('auth_index'), ['c1']);
  const finished = new URLSearchParams(quotaEventsHref('c1', quotaWindow(), 6 * HOUR)!.split('?')[1]);
  assert.equal(finished.get('to'), String(5 * HOUR));
});

test('the quota lens zooms, pans and sweeps inside its cycle', () => {
  const bounds = { start: 0, end: 10 * HOUR };
  const min = quotaLensMinSpan(quotaWindow());
  // One bucket of the cycle, never under a quarter hour.
  assert.equal(min, HOUR);
  assert.equal(quotaLensMinSpan({ ...quotaWindow(), buckets: [{ ...quotaWindow().buckets[0]!, end_ms: 60_000 }] }), 15 * 60_000);

  // Zooming about an instant keeps that instant where it was on screen.
  const zoomed = zoomLens(bounds, bounds, 0.5, min, 2 * HOUR);
  assert.deepEqual(zoomed, { start: HOUR, end: 6 * HOUR });
  assert.deepEqual(zoomLens(zoomed, bounds, 0.01, min), { start: 3 * HOUR, end: 4 * HOUR });
  assert.deepEqual(zoomLens(zoomed, bounds, 4, min), bounds);

  // A pan past an edge slides back to it without narrowing.
  assert.deepEqual(panLens(zoomed, bounds, -3 * HOUR, min), { start: 0, end: 5 * HOUR });
  assert.deepEqual(panLens(zoomed, bounds, 9 * HOUR, min), { start: 5 * HOUR, end: 10 * HOUR });

  // A sweep reads either way, and one narrower than the minimum widens about its middle.
  assert.deepEqual(lensFromSweep(4 * HOUR, 2 * HOUR, bounds, min), { start: 2 * HOUR, end: 4 * HOUR });
  assert.deepEqual(lensFromSweep(HOUR, 1.2 * HOUR, bounds, min), { start: 0.6 * HOUR, end: 1.6 * HOUR });
  assert.deepEqual(clampLens({ start: -HOUR, end: 20 * HOUR }, bounds, min), bounds);
});

test('the analytical hour bucket limit holds for ranges up to 14 days', () => {
  assert.equal(isRangeWithinHourLimit({ preset: '7d' }), true);
  assert.equal(isRangeWithinHourLimit({ preset: '30d' }), false);
  assert.equal(isRangeWithinHourLimit({ preset: '90d' }), false);
  assert.equal(isRangeWithinHourLimit({ preset: 'all' }), false);
  assert.equal(isRangeWithinHourLimit({ preset: 'last_month' }), false);
  assert.equal(isRangeWithinHourLimit({ from: 0, to: HOUR_LIMIT_MS }), true);
  assert.equal(isRangeWithinHourLimit({ from: 0, to: HOUR_LIMIT_MS + 1 }), false);
  assert.equal(isRangeWithinHourLimit({ from: 0, to: null }, HOUR_LIMIT_MS + 1), false);
  assert.equal(isRangeWithinHourLimit({ preset: 'this_month' }, Date.UTC(2026, 2, 10, 0, 0, 0)), true);
  assert.equal(isRangeWithinHourLimit({ preset: 'this_month' }, Date.UTC(2026, 2, 20, 0, 0, 0)), false);
});

test('trends quota window names follow OAuth management localization across all languages', async () => {
  const windows: TrendsQuotaWindow[] = [
    quotaWindow({ window_id: 'five_hour', label: '5小时滚动用量 (5-Hour)', scope: 'standard', period_hours: 5 }),
    quotaWindow({ window_id: 'seven_day_sonnet', label: 'Sonnet 每周用量', scope: 'model', model: 'claude-3-5-sonnet', period_hours: 168 }),
    quotaWindow({ window_id: 'seven_day_oauth_apps', label: '第三方应用 每周用量', scope: 'standard', period_hours: 168 }),
    quotaWindow({ window_id: 'seven_day_cowork', label: 'Cowork 协作每周用量', scope: 'standard', period_hours: 168 }),
    quotaWindow({ window_id: 'ag_Gemini Models_gemini-shared-5h', label: 'Gemini Models \u00b7 5小时限制 (5-Hour)', scope: 'group', period_hours: 5 }),
    quotaWindow({ window_id: 'ag_Claude and GPT_claude-5h', label: 'Claude and GPT \u00b7 5小时限制 (5-Hour)', scope: 'group', period_hours: 5 }),
    quotaWindow({ window_id: 'code_review_5h', label: '代码审查', scope: 'code_review', period_hours: 5 }),
    quotaWindow({ window_id: 'xai_credit_usage', label: '额度总使用率 (Credit Usage)', scope: 'standard', period_hours: 168 }),
  ];
  const expected = {
    zh: ['5 小时', '每周 Sonnet', '每周 第三方应用', '每周 Cowork', '5 小时 Gemini', '5 小时 Claude and GPT', '5 小时 代码审查', '额度用量'],
    en: ['5 hours', 'Weekly Sonnet', 'Weekly OAuth apps', 'Weekly Cowork', '5 hours Gemini', '5 hours Claude and GPT', '5 hours Code review', 'Credit usage'],
    'zh-Hant': ['5 小時', '每週 Sonnet', '每週 第三方應用', '每週 Cowork', '5 小時 Gemini', '5 小時 Claude and GPT', '5 小時 程式碼審查', '額度用量'],
    ms: ['5 jam', 'Sonnet Mingguan', 'Aplikasi OAuth Mingguan', 'Cowork Mingguan', 'Gemini 5 jam', 'Claude and GPT 5 jam', 'Semakan kod 5 jam', 'Penggunaan kredit'],
  } as const;
  for (const lang of ['zh', 'en', 'zh-Hant', 'ms'] as const) {
    const entry = CATALOGS[lang];
    const catalog = typeof entry === 'function' ? await entry() : entry;
    const t: TFunc = (key, vars) => formatMessage(catalog[key], vars, languageLocale(lang));
    assert.deepEqual(windows.map((win) => quotaWindowName(win, t, windows)), expected[lang], lang);
  }
  // 8-hour Codex custom period is formatted as 8h rather than falling back to 5-Hour Chinese text,
  // and distinct model-scoped windows sharing `scope: "model"` keep distinct period labels.
  const codexCustom: TrendsQuotaWindow[] = [
    quotaWindow({ window_id: 'standard_primary', label: '5小时用量上限 (5-Hour)', kind: 'model_scoped', scope: 'standard', period_hours: 8 }),
    quotaWindow({ window_id: 'spark_5h', label: 'Spark 5小时', kind: 'model_scoped', scope: 'model', model: 'spark', period_hours: 5 }),
    quotaWindow({ window_id: 'spark_7d', label: 'Spark 每周', kind: 'model_scoped', scope: 'model', model: 'spark', period_hours: 168 }),
  ];
  const enCatalog = typeof CATALOGS.en === 'function' ? await CATALOGS.en() : CATALOGS.en;
  const tEn: TFunc = (key, vars) => formatMessage(enCatalog[key], vars, languageLocale('en'));
  assert.deepEqual(codexCustom.map((win) => quotaWindowName(win, tEn, codexCustom)), ['8h', '5 hours Spark', 'Weekly Spark']);
});
