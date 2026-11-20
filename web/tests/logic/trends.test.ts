import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_TRENDS_VIEW,
  HOUR_LIMIT_MS,
  availablePerfGroups,
  buildQuotaBurnSeries,
  countdownParts,
  filterGroupByForKey,
  filterKeyForGroupBy,
  formatPercent,
  hasStabilityActivity,
  isRangeWithinHourLimit,
  latencySeriesRows,
  nearestPointIndex,
  omitTrendsFilter,
  percentReadout,
  percentileRows,
  perfBucketsHaveSamples,
  perfModeHasSamples,
  perfSeriesForMode,
  perfSeriesKey,
  pickForecastableQuotaWindow,
  pickQuotaWindow,
  quotaCredentialAttention,
  quotaRisk,
  quotaWindowAttention,
  quotaCycleBars,
  quotaDivider,
  quotaEventsHref,
  quotaNoticeState,
  quotaWindowName,
  readTrendsView,
  resolvePerfBuckets,
  aggregateStabilityFailures,
  deriveFailureGroupsFromEvents,
  deriveSubstitutionPairsFromEvents,
  stabilityDemoSliceEventsQueryString,
  stabilityDisplayBuckets,
  stabilityEventsHref,
  stabilityCellWeight,
  stabilityLanes,
  stabilitySliceTelemetryParams,
  stabilityWindowForCell,
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
  GLOBAL_SERIES_ID,
} from '../../src/pages/trends/trendsLogic.ts';
import { resolveTrendsManagementTarget } from '../../src/pages/trends/useTrendsIdentity.tsx';
import { readEventQuery } from '../../src/types/usageEventQuery.ts';
import { MAX_USAGE_EVENT_FILTER_VALUES } from '../../src/types/usageEvents.ts';
import type { TrendsFailureGroup, TrendsQuotaCredential, TrendsQuotaWindow, TrendsTelemetryBucket } from '../../src/types/trends.ts';
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
  assert.equal(
    pickQuotaWindow([credential('c1', [quotaWindow({ window_id: 'weekly', status: 'normal', used_percent: 12 }), quotaWindow({ window_id: '5h', status: 'projected_exhaust', used_percent: 60 })])], undefined, undefined)!.window.window_id,
    '5h',
  );
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
  assert.deepEqual(countdownParts(3 * HOUR), { days: 0, hours: 3, minutes: 0 });
  assert.deepEqual(countdownParts(-1), { days: 0, hours: 0, minutes: 0 });
  assert.equal(formatPercent(62.345), '62.3%');
  assert.equal(formatPercent(30, 2), '30.00%');
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
  assert.equal(successRate({ total_requests: 20, success_requests: 18 }), 0.9);
  assert.equal(formatPercent(0.9 * 100), '90.0%');
  assert.equal(successRate({ total_requests: 0, success_requests: 0 }), null);

  // A cell's tint follows the share of its requests the lane caught, so a stray failure stays faint.
  assert.equal(stabilityCellWeight(0, 100), 0);
  assert.ok(stabilityCellWeight(1, 1000) < 30);
  assert.ok(stabilityCellWeight(1, 1000) < stabilityCellWeight(10, 1000));
  assert.equal(stabilityCellWeight(20, 100), stabilityCellWeight(100, 100));
  assert.equal(stabilityCellWeight(3, 0), stabilityCellWeight(100, 100));

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
  assert.equal(
    quotaWindowName(quotaWindow({ window_id: 'short_3m', label: '', scope: 'standard', period_hours: 0.05 }), tEn),
    '0.05h',
  );
  assert.equal(
    quotaWindowName(quotaWindow({ window_id: 'custom_8h', label: '', scope: 'standard', period_hours: 28860 / 3600 }), tEn),
    '8h',
  );
});

test('quota tile targeting, percentage readouts, performance mode samples, and stability aggregation stay consistent', () => {
  // Stale/expired/unknown credentials are excluded from forecastable risk and tile target selection
  // while historical readings remain openable via pickQuotaWindow.
  const staleLimit = credential('stale-1', [quotaWindow({ window_id: '5h', status: 'limit_reached', used_percent: 100 })]);
  staleLimit.status = 'stale';
  const unknownCred = credential('unknown-1', [quotaWindow({ window_id: '5h', status: 'normal', used_percent: 60 })]);
  unknownCred.status = 'unknown';
  const expiredActive = credential('expired-1', [quotaWindow({ window_id: '5h', status: 'limit_reached', cycle_reset_ms: HOUR })]);
  const currentProjected = credential('active-1', [quotaWindow({ window_id: '5h', status: 'projected_exhaust', cycle_reset_ms: 5 * HOUR })]);
  assert.deepEqual(quotaRisk([staleLimit, unknownCred, expiredActive, currentProjected], 2 * HOUR), { forecastable: 1, limited: 0, projected: 1 });
  assert.equal(pickForecastableQuotaWindow([staleLimit, unknownCred, expiredActive, currentProjected], 2 * HOUR)?.credential.auth_index, 'active-1');
  assert.equal(pickForecastableQuotaWindow([unknownCred], 2 * HOUR), null);
  assert.equal(pickQuotaWindow([unknownCred], undefined, undefined)?.credential.auth_index, 'unknown-1');

  // Percentage readouts mirror formatPercent rounding so the delivery tile rolls and aligns beside sibling tiles.
  assert.equal(percentReadout(null), undefined);
  assert.deepEqual(percentReadout(95.8), {
    number: 95.8,
    suffix: '%',
    format: { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  });
  assert.deepEqual(percentReadout(99.96), {
    number: 100,
    suffix: '%',
    format: { minimumFractionDigits: 0, maximumFractionDigits: 0 },
  });

  // Performance mode sample detection checks mode-specific drawability and excludes filter_disabled groups.
  const latencyOnlyBucket = telemetryBucket(0, { latency_samples: 4, latency_p50_ms: 900, latency_p95_ms: 1400 });
  const latencyOnlyTelemetry = {
    window: { preset: '7d', from: 0, to: HOUR - 1, open_end: true, bucket: 'hour' as const, timezone: 'UTC', widened: false },
    tps_mode: 'exclude_ttft' as const,
    group_by: 'provider',
    summary: latencyOnlyBucket,
    buckets: [latencyOnlyBucket],
    groups: [
      { id: 'codex', label: 'codex' },
      { id: 'endpoint', label: 'endpoint', filter_disabled: true },
      { id: '', label: 'unknown' },
    ],
    series: [{ ...latencyOnlyBucket, id: 'codex', label: 'codex', buckets: [latencyOnlyBucket] }],
    scatter: [{ timestamp_ms: 100, group_id: 'codex', model: 'gpt-5', provider: 'codex', ttft_ms: null, latency_ms: 900, tps: null, output_tokens: 10, failed: false, model_substituted: false }],
    substitution_pairs: [],
    coverage: { fact_requests: 4, retained_requests: 4, is_truncated_by_retention: false },
  };
  assert.deepEqual(availablePerfGroups(latencyOnlyTelemetry, true).map((g) => g.id), ['codex']);
  assert.equal(perfModeHasSamples(latencyOnlyTelemetry, 'tps', [latencyOnlyBucket], []), false);
  assert.equal(perfModeHasSamples(latencyOnlyTelemetry, 'scatter', [latencyOnlyBucket], []), false);
  assert.equal(perfModeHasSamples(latencyOnlyTelemetry, 'latency', [latencyOnlyBucket], []), true);

  // Clean windows have no stability activity; dense windows aggregate adjacent buckets without dropping trailing counts.
  const cleanBuckets = [telemetryBucket(0), telemetryBucket(HOUR)];
  assert.equal(hasStabilityActivity({ buckets: cleanBuckets, substitution_pairs: [] }), false);

  const manyBuckets = Array.from({ length: 10 }, (_, index) =>
    telemetryBucket(index * HOUR, {
      rate_limited_429: index === 9 ? 4 : 1,
      force_cooldown: index === 0 ? 2 : 0,
    }),
  );
  const aggregated = stabilityDisplayBuckets(manyBuckets, 10 * HOUR, 4);
  assert.equal(aggregated.length, 3);
  assert.deepEqual(aggregated.map((cell) => [cell.start_ms, cell.last_start_ms, cell.end_ms, cell.span_count, cell.rate_limited_429]), [
    [0, 2 * HOUR, 3 * HOUR, 3, 3],
    [3 * HOUR, 5 * HOUR, 6 * HOUR, 3, 3],
    [6 * HOUR, 9 * HOUR, 10 * HOUR, 4, 7],
  ]);
  const lanes = stabilityLanes(aggregated);
  assert.equal(lanes.find((l) => l.lane === 'rate_limited_429')?.total, 13);
  assert.equal(lanes.find((l) => l.lane === 'force_cooldown')?.total, 2);
});

test('stability failure attribution rolls up model, provider, credential and lane scopes with exact totals and ops links', () => {
  const groups: TrendsFailureGroup[] = [
    {
      model: 'gpt-5',
      provider: 'codex',
      auth_index: 'cred-1',
      total_requests: 20,
      model_total_requests: 120,
      provider_total_requests: 100,
      credential_total_requests: 40,
      failed_requests: 10,
      rate_limited_429: 8,
      upstream_5xx: 2,
      stream_truncated: 0,
      force_cooldown: 1,
      other_failures: 0,
      status_codes: [{ code: 429, count: 8 }, { code: 503, count: 2 }],
      last_failed_at_ms: 2 * HOUR,
    },
    {
      model: 'gpt-5',
      provider: 'relay-a',
      auth_index: '',
      total_requests: 10,
      model_total_requests: 120,
      provider_total_requests: 50,
      failed_requests: 4,
      rate_limited_429: 0,
      upstream_5xx: 0,
      stream_truncated: 0,
      force_cooldown: 0,
      other_failures: 4,
      status_codes: [{ code: 401, count: 4 }],
      last_failed_at_ms: 3 * HOUR,
    },
  ];

  // Model rollup uses the exact window-wide denominator (120), not only failing channels (30).
  const byModel = aggregateStabilityFailures(groups, 'model', null);
  assert.equal(byModel.length, 1);
  assert.equal(byModel[0]!.failures, 14);
  assert.equal(byModel[0]!.totalRequests, 120);
  assert.equal(byModel[0]!.failureRate, 14 / 120);
  assert.deepEqual(byModel[0]!.peers.map((p) => [p.id, p.count]), [['codex', 10], ['relay-a', 4]]);
  assert.equal(byModel[0]!.credentialCount, 1);

  // Lane narrowing filters both failure counts and HTTP status codes cleanly.
  const only429 = aggregateStabilityFailures(groups, 'provider', 'rate_limited_429');
  assert.deepEqual(only429.map((r) => [r.id, r.failures, r.statusCodes]), [['codex', 8, [{ code: 429, count: 8 }]]]);

  const onlyOther = aggregateStabilityFailures(groups, 'credential', 'other_failures');
  assert.equal(onlyOther.length, 1);
  assert.equal(onlyOther[0]!.id, '');
  assert.equal(onlyOther[0]!.drillDisabled, true);
  assert.equal(onlyOther[0]!.totalRequests, 0);
  assert.equal(onlyOther[0]!.failureRate, null);
  assert.deepEqual(onlyOther[0]!.statusCodes, [{ code: 401, count: 4 }]);

  // Selected-lane aggregation isolates lane counts (never leaking tuple-wide sibling lanes)
  // and omits lastFailedAtMs when the tuple also contains sibling failure types.
  assert.equal(only429[0]!.lanes.force_cooldown, 0);
  assert.equal(only429[0]!.lastFailedAtMs, 0);
  const exclusive429 = aggregateStabilityFailures([{
    ...groups[0]!,
    failed_requests: 8,
    upstream_5xx: 0,
    force_cooldown: 0,
    status_codes: [{ code: 429, count: 8 }],
  }], 'provider', 'rate_limited_429');
  assert.equal(exclusive429[0]!.lastFailedAtMs, 2 * HOUR);

  // Shared tuple status histograms are omitted for protocol-level truncation/cooldown lanes
  // so co-occurring HTTP status codes (e.g. 502/503 from sibling failures) are never misattributed.
  const overlappingGroup: TrendsFailureGroup = {
    model: 'claude-sonnet',
    provider: 'anthropic',
    auth_index: 'cred-2',
    total_requests: 10,
    model_total_requests: 10,
    provider_total_requests: 10,
    credential_total_requests: 10,
    failed_requests: 3,
    rate_limited_429: 0,
    upstream_5xx: 2,
    stream_truncated: 1,
    force_cooldown: 1,
    other_failures: 1,
    status_codes: [{ code: 502, count: 1 }, { code: 503, count: 1 }, { code: 400, count: 1 }],
    last_failed_at_ms: 4 * HOUR,
  };
  const truncatedRows = aggregateStabilityFailures([overlappingGroup], 'model', 'stream_truncated');
  assert.equal(truncatedRows[0]!.failures, 1);
  assert.deepEqual(truncatedRows[0]!.statusCodes, []);
  const cooldownRows = aggregateStabilityFailures([overlappingGroup], 'model', 'force_cooldown');
  assert.equal(cooldownRows[0]!.failures, 1);
  assert.deepEqual(cooldownRows[0]!.statusCodes, []);
  const ambiguousOtherRows = aggregateStabilityFailures([overlappingGroup], 'model', 'other_failures');
  assert.equal(ambiguousOtherRows[0]!.failures, 1);
  assert.deepEqual(ambiguousOtherRows[0]!.statusCodes, []);
  const upstreamRows = aggregateStabilityFailures([overlappingGroup], 'model', 'upstream_5xx');
  assert.deepEqual(upstreamRows[0]!.statusCodes, [{ code: 502, count: 1 }, { code: 503, count: 1 }]);

  // Cell clamping guarantees to > from, returns null for single-millisecond intersections rather
  // than spilling into the next bucket, and builds exact slice/events URLs.
  const win = { from: 0, to: 10 * HOUR - 1, open_end: false as const };
  const cell = { start_ms: HOUR, end_ms: 2 * HOUR };
  assert.deepEqual(stabilityWindowForCell(win, cell), { from: HOUR, to: 2 * HOUR - 1, open_end: false });
  assert.equal(stabilityWindowForCell({ from: 999, to: 10_000 }, { start_ms: 0, end_ms: 1000 }), null);
  assert.equal(stabilitySliceTelemetryParams({ from: 999, to: 10_000 }, { start_ms: 0, end_ms: 1000 }, {}), null);
  assert.equal(stabilityDemoSliceEventsQueryString({ from: 999, to: 10_000 }, {}, { start_ms: 0, end_ms: 1000 }), null);
  assert.equal(stabilityEventsHref({ from: 999, to: 10_000, open_end: false }, {}, { lane: 'rate_limited_429', cell: { start_ms: 0, end_ms: 1000 } }), null);
  assert.equal(stabilitySliceTelemetryParams(win, cell, { provider: ['codex'] }), `from=${HOUR}&to=${2 * HOUR - 1}&top=1&provider=codex`);

  const href = stabilityEventsHref(win, { api_key: ['hmac:k1'] }, {
    lane: 'rate_limited_429',
    cell,
    entity: { dimension: 'credential', id: 'cred-1' },
  });
  assert.ok(href);
  const parsed = readEventQuery(new URL(href, 'http://localhost').searchParams);
  assert.equal(parsed.from, HOUR);
  assert.equal(parsed.to, 2 * HOUR - 1);
  assert.equal(parsed.result, 'failed');
  assert.equal(parsed.failure, 'rate_limited_429');
  assert.deepEqual(parsed.filters?.auth_index, ['cred-1']);
  assert.deepEqual(parsed.filters?.api_key, ['hmac:k1']);

  const truncatedHref = stabilityEventsHref(win, {}, { lane: 'stream_truncated', cell });
  assert.ok(truncatedHref);
  const parsedTruncated = readEventQuery(new URL(truncatedHref, 'http://localhost').searchParams);
  assert.equal(parsedTruncated.result, 'all');
  assert.equal(parsedTruncated.failure, 'stream_truncated');

  const demoSliceQuery = stabilityDemoSliceEventsQueryString(win, {}, cell);
  assert.ok(demoSliceQuery);
  const demoParams = new URLSearchParams(demoSliceQuery);
  assert.equal(demoParams.get('result'), 'all');
  assert.equal(demoParams.get('replay'), 'calendar');
  assert.equal(demoParams.get('from'), String(HOUR));
  assert.equal(demoParams.get('to'), String(2 * HOUR - 1));

  // Demo fallback derives failure groups (preserving truncation/cooldown overlap and capping rates)
  // and substitution pairs from raw usage events.
  const sampleEvents = [
    {
      id: 1, event_key: 'e1', timestamp_ms: HOUR, provider: 'codex', auth_index: 'cred-1',
      model: 'gpt-5', failed: true, fail_status_code: 502, fail_code: 'stream_truncated', generate: true, latency_ms: 100,
      tokens: { input: 0, output: 0, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 0 },
      has_request_log: false,
    },
    {
      id: 2, event_key: 'e2', timestamp_ms: HOUR + 1000, provider: 'codex', auth_index: 'cred-1',
      model: 'gpt-5', response_model: 'gpt-5-mini', model_substituted: true, failed: false, generate: true, latency_ms: 100,
      tokens: { input: 0, output: 0, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 0 },
      has_request_log: false,
    },
  ];
  const derived = deriveFailureGroupsFromEvents(sampleEvents);
  assert.equal(derived.length, 1);
  assert.equal(derived[0]!.failed_requests, 1);
  assert.equal(derived[0]!.total_requests, 2);
  assert.equal(derived[0]!.upstream_5xx, 1);
  assert.equal(derived[0]!.stream_truncated, 1);
  assert.equal(derived[0]!.other_failures, 0);

  const capped = deriveFailureGroupsFromEvents(sampleEvents, { isCapped: true });
  const cappedRows = aggregateStabilityFailures(capped, 'model', null);
  assert.equal(cappedRows[0]!.failures, 1);
  assert.equal(cappedRows[0]!.totalRequests, 0);
  assert.equal(cappedRows[0]!.failureRate, null);

  // Truncated live failure groups suppress potentially understated rates via isPartial.
  const partialLiveRows = aggregateStabilityFailures(groups, 'model', null, { isPartial: true });
  assert.equal(partialLiveRows[0]!.failures, 14);
  assert.equal(partialLiveRows[0]!.totalRequests, 0);
  assert.equal(partialLiveRows[0]!.failureRate, null);

  // When Demo list payloads omit fail_code, omitUncategorizedOther avoids misclassifying
  // uncoded failures (such as a status-less stream truncation) as other_failures.
  const uncodedDemo = deriveFailureGroupsFromEvents([
    {
      id: 3, event_key: 'e3', timestamp_ms: HOUR, provider: 'codex', auth_index: 'cred-1',
      model: 'gpt-5', failed: true, generate: true, latency_ms: 100,
      tokens: { input: 0, output: 0, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 0 },
      has_request_log: false,
    },
  ], { omitUncategorizedOther: true });
  assert.equal(uncodedDemo[0]!.failed_requests, 1);
  assert.equal(uncodedDemo[0]!.other_failures, 0);

  assert.deepEqual(deriveSubstitutionPairsFromEvents(sampleEvents), [
    { requested_model: 'gpt-5', served_model: 'gpt-5-mini', provider: 'codex', count: 1 },
  ]);

  // Live management target resolution avoids dead shortcuts for archived or redacted entities.
  const credentials = new Map([
    ['oauth-live', { name: 'team.json', provider: 'codex', auth_index: 'oauth-live' }],
    ['oauth-archived', { name: 'old.json', provider: 'codex', auth_index: 'oauth-archived', is_archived: true }],
  ]);
  const providers = [
    { id: 'prov-relay', family: 'openai-compatibility', name: 'Relay A', upstream_name: 'relay-a', auth_indexes: ['key-idx-1', 'shared-idx'] },
    { id: 'prov-alias', family: 'openai-compatibility', name: 'team-west', upstream_name: 'dup-upstream', auth_indexes: ['shared-idx'] },
    { id: 'team-west', family: 'openai-compatibility', name: 'West Exact', upstream_name: 'dup-upstream', auth_indexes: [] },
  ];
  assert.deepEqual(resolveTrendsManagementTarget('credential', 'oauth-live', credentials, providers), {
    target: 'oauth',
    href: '/oauth-management?q=oauth-live',
  });
  assert.deepEqual(resolveTrendsManagementTarget('credential', 'key-idx-1', credentials, providers), {
    target: 'provider',
    href: '/ai-providers?provider=prov-relay',
  });
  // Ambiguous credential index claimed by multiple configured providers must hide the shortcut.
  assert.equal(resolveTrendsManagementTarget('credential', 'shared-idx', credentials, providers), null);
  assert.equal(resolveTrendsManagementTarget('credential', 'oauth-archived', credentials, providers), null);
  assert.equal(resolveTrendsManagementTarget('credential', 'redacted:abc', credentials, providers), null);
  assert.deepEqual(resolveTrendsManagementTarget('provider', 'openai-compatible-relay-a', credentials, providers), {
    target: 'provider',
    href: '/ai-providers?provider=prov-relay',
  });
  // Exact provider ID match takes precedence over an earlier provider with that display name.
  assert.deepEqual(resolveTrendsManagementTarget('provider', 'team-west', credentials, providers), {
    target: 'provider',
    href: '/ai-providers?provider=team-west',
  });
  // Ambiguous upstream name shared by two providers hides the shortcut.
  assert.equal(resolveTrendsManagementTarget('provider', 'dup-upstream', credentials, providers), null);
  assert.deepEqual(resolveTrendsManagementTarget('provider', 'codex', credentials, providers), {
    target: 'oauth',
    href: '/oauth-management?provider=codex',
  });
  // Multiple configured providers sharing a family must return null rather than falling through to OAuth.
  const multiFamilyProviders = [
    ...providers,
    { id: 'codex-a', family: 'codex', name: 'Codex A', auth_indexes: [] },
    { id: 'codex-b', family: 'codex', name: 'Codex B', auth_indexes: [] },
  ];
  assert.equal(resolveTrendsManagementTarget('provider', 'codex', credentials, multiFamilyProviders), null);
});

test('quotaNoticeState distinguishes CPA unreachability from stale or expired observations', () => {
  const activeWin = quotaWindow({ cycle_start_ms: 0, cycle_reset_ms: 5 * HOUR });
  const activeCred = credential('cred-1', [activeWin]);

  assert.equal(quotaNoticeState(activeCred, activeWin, false, 2 * HOUR), null);
  assert.deepEqual(
    quotaNoticeState({ ...activeCred, status: 'stale' }, activeWin, true, 2 * HOUR),
    { kind: 'cpa_unreachable', canRefreshQuota: false },
  );
  assert.deepEqual(
    quotaNoticeState({ ...activeCred, status: 'stale' }, activeWin, false, 2 * HOUR),
    { kind: 'stale', canRefreshQuota: true },
  );
  assert.deepEqual(
    quotaNoticeState({ ...activeCred, status: 'error' }, activeWin, false, 2 * HOUR),
    { kind: 'stale', canRefreshQuota: true },
  );
  assert.deepEqual(
    quotaNoticeState(activeCred, activeWin, false, 5 * HOUR),
    { kind: 'stale', canRefreshQuota: true },
  );
  assert.deepEqual(
    quotaNoticeState({ ...activeCred, status: 'disabled' }, activeWin, false, 2 * HOUR),
    { kind: 'stale', canRefreshQuota: false },
  );
  assert.deepEqual(
    quotaNoticeState({ ...activeCred, auth_index: '  ', status: 'stale' }, activeWin, false, 2 * HOUR),
    { kind: 'stale', canRefreshQuota: false },
  );
});
