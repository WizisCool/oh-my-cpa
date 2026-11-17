import assert from 'node:assert/strict';
import {
  FOLDED_ID,
  attributeServingProviders,
  baselineMeasures,
  buildFlow,
  cubeMetric,
  buildMatrix,
  compareMetric,
  comparisonScale,
  decodeInsightsCube,
  emptyMeasures,
  facetValues,
  filterRows,
  groupBaselines,
  groupTotals,
  isOAuthRow,
  matrixCellKey,
  metricValue,
  normalizeMeasures,
  measuresAvgTtftMs,
  measuresCacheRate,
  measuresReasoningShare,
  rankGroups,
  robustBucketSum,
  scopeTokens,
  sumAnatomy,
  sumMeasures,
  tokenAnatomy,
  trendSeries,
  type Measures,
} from '../../src/types/insightsCube.ts';
import { canDrillUsageEvents, cleanValues, csvCell, insightsCsv, usageEventsHref } from '../../src/pages/insights/insightsDrill.ts';
import { MAX_USAGE_EVENT_FILTER_VALUES } from '../../src/types/usageEvents.ts';
import { clientCoverageShare, clientIconId, clientMeasures, clientProductName } from '../../src/types/clientAgents.ts';
import { readEventQuery } from '../../src/types/usageEventQuery.ts';
import { formatCountBaseline, formatMetric, metricReadout } from '../../src/types/insightsFormat.ts';
import { insightsRangeParams, parseInsightsRange } from '../../src/types/insights.ts';
import { canShowWeekView, peakHourSet, summarizeRhythm } from '../../src/pages/insights/insightsRhythm.ts';
import {
  DEFAULT_INSIGHTS_VIEW,
  readInsightsView,
  requestFilterValues,
  toggleFilter,
  writeInsightsView,
} from '../../src/pages/insights/insightsViewState.ts';
import type { InsightsCubeResponse } from '../../src/types/insights.ts';
import { buildReceiptLedger, receiptCubeParams } from '../../src/components/dashboard/receipt/receiptModel.ts';
import { isSlidingRange, requestListWindowParams } from '../../src/types/dashboard.ts';
import { test } from 'vitest';
import { buildSankeyLayout } from '../../src/pages/insights/charts/InsightsFlowChart.tsx';

test('insights cube', () => {
  const COLUMNS = [
    'bucket', 'key', 'call_point', 'model', 'provider', 'credential',
    'requests', 'failures', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens',
    'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'latency_sum_ms', 'ttft_sum_ms',
    'ttft_count', 'cost_nanos', 'priced_requests', 'costed_requests',
  ];

  /** One cube row: bucket and dimension indices, then requests, failures, tokens and cost. */
  function row(bucket: number, key: number, callPoint: number, model: number, provider: number, credential: number,
    requests: number, failures: number, tokens: number, costNanos: number, costed = requests): number[] {
    return [bucket, key, callPoint, model, provider, credential, requests, failures, tokens / 2, tokens / 2, 0, 0, 0, 0,
      tokens, requests * 100, 0, 0, costNanos, costed, costed];
  }

  const response: InsightsCubeResponse = {
    window: { preset: 'today', from: 0, to: 3 * 3_600_000 - 1, open_end: true, bucket: 'hour', timezone: 'UTC', widened: false },
    compare_window: { from: -3 * 3_600_000, to: -1 },
    bucket_starts: [0, 3_600_000, 7_200_000],
    dims: {
      keys: [{ id: 'hmac:a', alias: 'Ada', is_client_key: true }, { id: 'hmac:b', is_client_key: true }, { id: 'claude', is_client_key: false }],
      call_points: ['fast', 'smart'],
      models: ['gpt-5', 'sonnet'],
      providers: ['codex', 'claude'],
      credentials: [{ auth_index: 'c1', auth_type: 'oauth' }, { auth_index: 'c2', auth_type: 'apikey' }],
    },
    // The columns arrive in the order the server lists them; the decoder finds them by name.
    columns: COLUMNS,
    rows: [
      row(0, 0, 0, 0, 0, 0, 10, 1, 1000, 2_000_000_000),
      row(1, 0, 1, 1, 1, 1, 5, 0, 4000, 1_000_000_000),
      row(2, 1, 0, 0, 0, 0, 2, 2, 200, 0, 0),
      row(2, 2, 1, 1, 1, 1, 3, 0, 300, 500_000_000),
    ],
    previous_rows: [row(-1, 0, 0, 0, 0, 0, 4, 0, 500, 1_000_000_000).slice(1)],
    coverage: { fact_requests: 20, detail_requests: 0 },
  };

  const cube = decodeInsightsCube(response);

  // ── decoding ──────────────────────────────────────────────────────────────────

  assert.equal(cube.rows.length, 4);
  assert.equal(cube.rows[1].measures.totalTokens, 4000);
  assert.equal(cube.previous[0].bucket, -1, 'a comparison row has no bucket');
  assert.equal(cube.previous[0].measures.requests, 4, 'a comparison row is read one column to the left');
  assert.deepEqual(cube.values.credential, ['c1', 'c2']);
  assert.throws(() => decodeInsightsCube({ ...response, columns: COLUMNS.filter((name) => name !== 'cost_nanos') }), /cost_nanos/);
  assert.deepEqual(cube.rows.map((item) => isOAuthRow(cube, item)), [true, false, true, false], 'an OAuth sign-in serves a row; an API key does not');
  const unnamed = decodeInsightsCube({ ...response, dims: { ...response.dims, credentials: [{ auth_index: '', auth_type: 'oauth' }, response.dims.credentials[1]] } });
  assert.equal(isOAuthRow(unnamed, unnamed.rows[0]), false, 'a row naming no credential counts with its provider');

  // ── filters ───────────────────────────────────────────────────────────────────

  assert.equal(filterRows(cube, cube.rows, {}).length, 4);
  assert.equal(filterRows(cube, cube.rows, { key: ['hmac:a'] }).length, 2);
  assert.equal(filterRows(cube, cube.rows, { key: ['hmac:a'], model: ['sonnet'] }).length, 1, 'filters on two dimensions intersect');
  assert.equal(filterRows(cube, cube.rows, { key: ['hmac:a', 'hmac:b'] }).length, 3, 'values of one dimension unite');
  assert.equal(filterRows(cube, cube.rows, { key: ['hmac:a'] }, 'key').length, 4, 'a picker counts its own dimension unconstrained');
  assert.equal(filterRows(cube, cube.rows, { model: ['unseen'] }).length, 0);

  // ── metrics ───────────────────────────────────────────────────────────────────

  const whole = sumMeasures(cube.rows);
  assert.equal(metricValue(whole, 'requests'), 20);
  assert.equal(metricValue(whole, 'cost'), 3.5);
  assert.equal(metricValue(whole, 'latency'), 100);
  assert.equal(metricValue(emptyMeasures(), 'latency'), null, 'an average over no requests has no value');
  // Unpriced is not free: a group whose requests carry no cost has no spend rather than a zero one.
  const unpriced = sumMeasures(filterRows(cube, cube.rows, { key: ['hmac:b'] }));
  assert.equal(metricValue(unpriced, 'cost'), null);

  // A comparison weighs the requests behind it: the same ratio is noise on a few and a trend on many.
  const usage = (requests: number, totalTokens: number) => ({ ...emptyMeasures(), requests, totalTokens });
  assert.deepEqual(compareMetric(usage(12, 1200), usage(10, 1000), 'tokens'), { kind: 'change', change: 0.19999999999999996, isNoise: true });
  assert.deepEqual(compareMetric(usage(1200, 120000), usage(1000, 100000), 'tokens'), { kind: 'change', change: 0.19999999999999996, isNoise: false });
  assert.deepEqual(compareMetric(usage(5, 500), usage(0, 0), 'tokens'), { kind: 'new' }, 'growth from nothing has no ratio');
  // A baseline inside the current reading's sampling noise is an arrival, not a sixty-fold rise; the
  // same baseline against a smaller current reading is a measurable change.
  assert.deepEqual(compareMetric(usage(400, 6_100_000), usage(2, 100_000), 'tokens'), { kind: 'new' });
  assert.equal(compareMetric(usage(20, 150_000), usage(2, 100_000), 'tokens').kind, 'change');
  assert.deepEqual(compareMetric(usage(0, 0), usage(1, 100), 'tokens'), { kind: 'change', change: -1, isNoise: true }, 'one request gone is chance');
  assert.deepEqual(compareMetric(usage(0, 0), usage(40, 4000), 'tokens'), { kind: 'change', change: -1, isNoise: false }, 'a group that stopped has fallen');
  assert.deepEqual(compareMetric(emptyMeasures(), usage(10, 1000), 'latency'), { kind: 'none' });
  assert.deepEqual(compareMetric(usage(1, 100), usage(1, 100), 'requests'), { kind: 'change', change: 0, isNoise: true }, 'a request a side is no arrival');
  assert.deepEqual(compareMetric(usage(40, 0), usage(40, 4000), 'tokens'), { kind: 'change', change: -1, isNoise: false }, 'tokens that stopped fell, though requests ran on');
  const spend = (requests: number, costedRequests: number, costNanos: number) => ({ ...emptyMeasures(), requests, costedRequests, costNanos });
  assert.deepEqual(compareMetric(spend(5000, 1, 3e9), spend(5000, 1, 2e9), 'cost'), { kind: 'change', change: 0.5, isNoise: true }, 'one priced request a side is chance, however many ran');
  assert.deepEqual(compareMetric(spend(1000, 1000, 0), spend(5, 5, 1e9), 'cost'), { kind: 'change', change: -1, isNoise: false }, 'a thousand free requests are a firm fall');
  assert.deepEqual(compareMetric(spend(10, 10, 1e9), spend(10, 0, 0), 'cost'), { kind: 'none' }, 'an unpriced spend before is unknown, not new');

  // ── rankings ──────────────────────────────────────────────────────────────────

  const byKey = groupTotals(cube, cube.rows, 'key');
  const previousByKey = groupTotals(cube, cube.previous, 'key');
  const rankedByCost = rankGroups(byKey, 'cost', previousByKey);
  assert.deepEqual(rankedByCost.map((group) => group.id), ['hmac:a', 'claude', 'hmac:b'], 'unvalued groups rank last');
  assert.equal(rankedByCost[0].share, 3 / 3.5);
  assert.equal(rankedByCost[0].previous?.requests, 4);
  assert.equal(rankedByCost[1].previous?.requests, 0, 'a group absent before compares against nothing, not against itself');
  // A non-additive measure ranks by the request volume behind it, not by its own value.
  assert.deepEqual(rankGroups(byKey, 'latency').map((group) => group.id), ['hmac:a', 'claude', 'hmac:b']);
  assert.equal(rankGroups(byKey, 'latency')[0].share, 15 / 20);
  // Equal values keep a stable order by identity.
  const tied = new Map([['b', { ...emptyMeasures(), requests: 1 }], ['a', { ...emptyMeasures(), requests: 1 }]]);
  assert.deepEqual(rankGroups(tied, 'requests').map((group) => group.id), ['a', 'b']);

  // ── trend ─────────────────────────────────────────────────────────────────────

  const trend = trendSeries(cube, cube.rows, 'tokens', 'key', ['hmac:a']);
  assert.deepEqual(trend.map((group) => [group.id, group.folded]), [['hmac:a', false], [FOLDED_ID, true]]);
  assert.deepEqual(trend[0].values, [1000, 4000, 0], 'an additive series is zero-filled across the window');
  assert.deepEqual(trend[1].values, [0, 0, 500]);
  assert.equal(trendSeries(cube, cube.rows, 'tokens', 'key', ['hmac:a', 'hmac:b', 'claude']).length, 3,
    'an empty remainder is not drawn');
  const latencyTrend = trendSeries(cube, cube.rows, 'latency', null, []);
  assert.deepEqual(latencyTrend[0].values, [100, 100, 100], 'an ungrouped average is computed per bucket from its own sums');
  assert.deepEqual(latencyTrend[0].samples, [10, 5, 5], 'latency evidence is its requests per bucket');

  // ── matrix and flow ───────────────────────────────────────────────────────────

  const matrix = buildMatrix(cube, cube.rows, 'key', 'model', 'tokens', 2, 5);
  assert.deepEqual(matrix.rowIds, ['hmac:a', 'claude'], 'rows are the top groups; the rest is left out, not folded');
  assert.equal(matrix.cells.get(matrixCellKey('hmac:a', 'sonnet'))?.value, 4000);
  assert.equal(matrix.cells.get(matrixCellKey('hmac:a', 'gpt-5'))?.value, 1000);
  assert.equal(matrix.max, 4000);

  const flow = buildFlow(cube, cube.rows, ['key', 'call_point', 'provider'], 'requests', 1);
  assert.ok(flow.nodes.some((node) => node.id === '0:hmac:a'));
  assert.ok(flow.nodes.some((node) => node.folded && node.level === 0), 'keys past the limit fold into one node per level');
  const keyTotal = flow.links.filter((link) => link.source.startsWith('0:')).reduce((sum, link) => sum + link.value, 0);
  assert.equal(keyTotal, 20, 'every request flows out of the first level once');

  assert.deepEqual(facetValues(cube, cube.rows, 'model'), [{ id: 'gpt-5', requests: 12 }, { id: 'sonnet', requests: 8 }]);

  // ── provider attribution ──────────────────────────────────────────────────────

  // CPA labels every API-key request with its protocol family - the word it also writes for that
  // family's OAuth channel - so a provider the operator named AnyRouter arrives as `claude`, beside
  // the channel's own sign-in traffic. The credential that served the row is what names the
  // connection, and 'claude-key'/'relay-key' are the keys the configured providers publish.
  const attribution = decodeInsightsCube({
    ...response,
    dims: {
      ...response.dims,
      providers: ['claude', 'openai-compatible-relay'],
      credentials: [
        { auth_index: 'claude-key', auth_type: 'apikey' },
        { auth_index: 'claude-login', auth_type: 'oauth' },
        { auth_index: 'relay-key', auth_type: 'apikey' },
        { auth_index: 'rotated-key', auth_type: 'apikey' },
      ],
    },
    rows: [
      row(0, 0, 0, 1, 0, 0, 10, 0, 1000, 0),
      row(0, 0, 0, 1, 0, 1, 5, 0, 500, 0),
      row(0, 0, 0, 0, 1, 2, 3, 0, 300, 0),
      row(0, 0, 0, 1, 0, 3, 1, 0, 100, 0),
    ],
    previous_rows: [row(-1, 0, 0, 1, 0, 0, 4, 0, 400, 0).slice(1)],
  });
  // 'claude-login' is claimed by no provider key list, but asking for it must change nothing either:
  // an OAuth record's index is a sign-in, never a configured provider's credential.
  const claimedByID: Record<string, string> = { 'claude-key': 'claude-0', 'relay-key': 'openai-compat-0', 'claude-login': 'claude-0' };
  const attributed = attributeServingProviders(attribution, (authIndex) => claimedByID[authIndex]);
  assert.deepEqual(attributed.values.provider, ['claude', 'claude-0', 'openai-compat-0']);
  assert.equal(attributed.rows[0].dims[3], attributed.values.provider.indexOf('claude-0'), 'a claimed key names its provider');
  assert.equal(attributed.rows[1].dims[3], attributed.values.provider.indexOf('claude'), 'a sign-in keeps the family label');
  assert.equal(attributed.rows[2].dims[3], attributed.values.provider.indexOf('openai-compat-0'), 'a compatibility key names its provider');
  assert.equal(attributed.rows[3].dims[3], attributed.values.provider.indexOf('claude'), 'an unclaimed key keeps the label');
  assert.deepEqual(
    rankGroups(groupTotals(attributed, attributed.rows, 'provider'), 'requests').map((group) => [group.id, group.measures.requests]),
    [['claude-0', 10], ['claude', 6], ['openai-compat-0', 3]],
    'the connection and the family channel are two groups, and the rotated key counts with the label',
  );
  assert.equal(attributed.previous[0].dims[3], attributed.values.provider.indexOf('claude-0'), 'the comparison period is re-keyed the same way');
  assert.deepEqual(attribution.values.provider, ['claude', 'openai-compatible-relay'], 'the decoded cube is left as it was');
  assert.equal(filterRows(attributed, attributed.rows, { provider: ['claude-0'] }).length, 1, 'the attributed value is what a filter selects');
  assert.equal(filterRows(attributed, attributed.rows, { provider: ['claude'] }).length, 2, 'the label still selects the rows it names');
  // A catalog that claims nothing - unread, or every key rotated away - leaves the page as it was.
  const unclaimed = attributeServingProviders(attribution, () => undefined);
  assert.deepEqual(unclaimed.values.provider, attribution.values.provider);
  assert.deepEqual(unclaimed.rows.map((item) => item.dims[3]), attribution.rows.map((item) => item.dims[3]));

  // The rhythm read filters request records, where a connection is the credentials that served it.
  assert.deepEqual(requestFilterValues(attributed, {}), { provider: [], credential: [] });
  assert.deepEqual(requestFilterValues(attributed, { provider: ['claude-0'] }), { provider: [], credential: ['claude-key'] });
  assert.deepEqual(requestFilterValues(attributed, { provider: ['claude'] }), { provider: [], credential: ['claude-login', 'rotated-key'] });
  assert.deepEqual(requestFilterValues(attributed, { credential: ['rotated-key'] }), { provider: [], credential: ['rotated-key'] });
  assert.deepEqual(
    requestFilterValues(attributed, { provider: ['claude-0', 'openai-compat-0'] }),
    { provider: [], credential: ['claude-key', 'relay-key'] },
    'two connections are the credentials of both',
  );
  assert.deepEqual(
    requestFilterValues(attributed, { provider: ['claude-0'], credential: ['claude-key'] }),
    { provider: [], credential: ['claude-key'] },
    'both dimensions narrow the same column, so they intersect',
  );
  assert.deepEqual(
    requestFilterValues(attributed, { provider: ['claude-0'], credential: ['relay-key'] }),
    { provider: ['claude-0'], credential: ['relay-key'] },
    'a pair that shares no credential keeps both filters, which selects nothing rather than everything',
  );
  // A group whose rows name no credential can only be selected by the label CPA recorded for it.
  const keyless = decodeInsightsCube({
    ...response,
    dims: { ...response.dims, providers: ['relay'], credentials: [{ auth_index: '', auth_type: 'apikey' }] },
    rows: [row(0, 0, 0, 0, 0, 0, 2, 0, 200, 0)],
    previous_rows: [],
  });
  assert.deepEqual(requestFilterValues(keyless, { provider: ['relay'] }), { provider: ['relay'], credential: [] });
  assert.deepEqual(requestFilterValues(undefined, { provider: ['relay'] }), { provider: ['relay'], credential: [] }, 'a cube that has not arrived leaves the filter as it was');
  // The request list opens on exactly the page's records, or not at all: a connection whose traffic
  // partly named no credential cannot be spelled as its credentials, which would drop the rest.
  assert.equal(canDrillUsageEvents(keyless, { provider: ['relay'] }), true, 'a label alone selects keyless traffic exactly');
  assert.equal(canDrillUsageEvents(attributed, { provider: ['claude'] }), true, 'every record named a credential');
  const mixedCredentials = decodeInsightsCube({
    ...response,
    dims: { ...response.dims, providers: ['relay'], credentials: [{ auth_index: 'relay-key', auth_type: 'apikey' }, { auth_index: '', auth_type: 'apikey' }] },
    rows: [row(0, 0, 0, 0, 0, 0, 2, 0, 200, 0), row(0, 0, 0, 0, 0, 1, 1, 0, 100, 0)],
    previous_rows: [],
  });
  assert.equal(canDrillUsageEvents(mixedCredentials, { provider: ['relay'] }), false);
  assert.equal(canDrillUsageEvents(mixedCredentials, { provider: ['relay'], credential: ['relay-key'] }), true, 'a chosen credential already leaves the keyless traffic out of the page');
  assert.deepEqual(cleanValues([' gpt-5 ', 'gpt-5', '', '  ', 'sonnet']), ['gpt-5', 'sonnet']);

  // ── the stored window ─────────────────────────────────────────────────────────

  assert.deepEqual(parseInsightsRange({ preset: 'this_week' }), { preset: 'this_week' });
  assert.equal(parseInsightsRange({ preset: '15m' }), undefined, 'a dashboard-only preset is not an Insights window');
  assert.deepEqual(parseInsightsRange({ from: 10, to: null }), { from: 10, to: null });
  assert.equal(parseInsightsRange({ from: 10, to: 5 }), undefined);
  assert.equal(insightsRangeParams({ preset: 'today' }), 'preset=today');
  assert.equal(insightsRangeParams({ from: 1, to: null }, 'day'), 'from=1&bucket=day', 'an open range sends no end');

  // Robust baseline Winsorizes extreme single-bucket spikes while preserving normal skew and duty cycle,
  // and scales the previous period's rate to the current window's elapsed duration.
  assert.equal(robustBucketSum([]), 0);
  assert.equal(robustBucketSum([0, 50, 0, 5000, 0, 10]), 5060, 'fewer than 4 active buckets keep raw sum');
  assert.equal(robustBucketSum([1, 2, 5, 10, 20, 50, 100, 200]), 388, 'normal diurnal right-skew is untouched');
  assert.ok(Math.abs(robustBucketSum([1, 1, 1, 1000]) - 5.5) < 1e-6, 'k=4 extreme spike is Winsorized');
  assert.ok(Math.abs(robustBucketSum([20, 22, 18, 25, 20, 21, 19, 2000]) - 196.25) < 1e-6, 'extreme anomaly is Winsorized');

  const bucketedCube = decodeInsightsCube({
    ...response,
    window: { preset: 'today', from: 0, to: 12 * 3_600_000 - 1, open_end: true, bucket: 'hour', timezone: 'UTC', widened: false },
    compare_window: { from: -24 * 3_600_000, to: -1 },
    previous_rows: [
      row(0, 0, 0, 0, 0, 0, 10, 0, 1000, 1_000_000_000),
      row(1, 0, 0, 0, 0, 0, 10, 0, 1000, 1_000_000_000),
      row(2, 0, 0, 0, 0, 0, 10, 0, 1000, 1_000_000_000),
      row(3, 0, 0, 0, 0, 0, 10, 0, 1000, 1_000_000_000),
      // Extreme single-hour runaway spike in hour 4.
      row(4, 0, 0, 0, 0, 0, 500, 0, 50_000, 50_000_000_000),
    ],
  });
  const scale = comparisonScale(bucketedCube);
  assert.equal(scale, 0.5);
  const { baseline: prevBaseline, raw: prevRaw } = baselineMeasures(bucketedCube.previous, scale);
  assert.equal(prevRaw.requests, 540);
  // 4 buckets * 10 + 1 bucket capped at 2.5*10 = 65 -> * 0.5 = 32.5 requests.
  assert.equal(prevBaseline.requests, 32.5);
  assert.equal(prevBaseline.totalTokens, 3250);
  const byKeyBase = groupBaselines(bucketedCube, bucketedCube.previous, 'key', scale);
  assert.equal(byKeyBase.baseline.get('hmac:a')?.requests, 32.5);
  assert.equal(byKeyBase.raw.get('hmac:a')?.requests, 540);
  // Noise testing uses unscaled raw evidence counts rather than scaled baseline counts:
  // with 100 current vs 100 raw previous (scaled to 1.0 baseline -> +9900% ratio), vs 1 raw previous.
  const scaledWithFirmEvidence = compareMetric(usage(100, 10_000), usage(1, 5_000), 'tokens', usage(100, 100_000));
  const scaledWithThinEvidence = compareMetric(usage(100, 10_000), usage(1, 5_000), 'tokens', usage(1, 5_000));
  assert.deepEqual(scaledWithFirmEvidence, { kind: 'change', change: 1, isNoise: false });
  assert.deepEqual(scaledWithThinEvidence, { kind: 'change', change: 1, isNoise: true });

  // Fractional baseline counts format cleanly without dropping below visibility.
  assert.equal(formatCountBaseline(1234.6), '1,235');
  assert.equal(formatCountBaseline(32.5), '32.5');
  assert.equal(formatCountBaseline(3.47), '3.47');
  assert.equal(formatCountBaseline(0.004), '<0.01');

  // A tile's rolling figure prints exactly what its static form prints, at every magnitude.
  const printReadout = (readout: NonNullable<ReturnType<typeof metricReadout>>) =>
    `${readout.prefix ?? ''}${new Intl.NumberFormat('en', readout.format).format(readout.number)}${readout.suffix}`;
  for (const value of [0, 0.4, 7, 999.4, 999.6, 1000, 1004.9, 1005, 12_345.678, 999_949, 1_234_567, 98_765_432_101]) {
    for (const metric of ['tokens', 'net_tokens', 'cost', 'requests', 'latency'] as const) {
      for (const style of ['en-compact', 'zh', 'full'] as const) {
        const whole = metric === 'requests' ? Math.round(value) : value;
        const readout = metricReadout(metric, whole, style);
        assert.ok(readout, `${metric} ${whole} has a readout`);
        assert.equal(printReadout(readout), formatMetric(metric, whole, style), `${metric} ${whole} (${style}) rolls to its printed form`);
      }
    }
  }
  assert.equal(metricReadout('tokens', null, 'en-compact'), undefined, 'a missing reading has no readout');

  // ── the view in the URL ───────────────────────────────────────────────────────

  assert.equal(writeInsightsView(DEFAULT_INSIGHTS_VIEW).toString(), '', 'a default view is a plain link');
  const sharedView = { ...DEFAULT_INSIGHTS_VIEW, metric: 'cost' as const, isComparing: false, filters: { key: ['hmac:a', 'hmac:b'], provider: ['codex'], client: ['claude-code'] } };
  assert.deepEqual(readInsightsView(writeInsightsView(sharedView)), sharedView, 'a written view reads back as it was');
  assert.deepEqual(readInsightsView(new URLSearchParams('metric=nonsense&group=x&key=hmac:a&key=hmac:a')),
    { ...DEFAULT_INSIGHTS_VIEW, filters: { key: ['hmac:a'] } }, 'an unknown value falls back and a repeated filter is one value');
  assert.deepEqual(readInsightsView(new URLSearchParams('metric=cache_rate')), DEFAULT_INSIGHTS_VIEW,
    'a retired metric falls back to the default view');
  assert.deepEqual(readInsightsView(new URLSearchParams('metric=success_rate')), DEFAULT_INSIGHTS_VIEW,
    'the retired success-rate metric also falls back');
  assert.deepEqual(toggleFilter({ key: ['hmac:a'] }, 'key', 'hmac:a'), {}, 'removing the last value drops the dimension');
  assert.deepEqual(toggleFilter({}, 'model', 'gpt-5'), { model: ['gpt-5'] });

  // ── the rhythm's summary ──────────────────────────────────────────────────────

  const rhythmCell = (weekday: number, hour: number, requests: number) => ({ weekday, hour, requests, total_tokens: 0, cost_nanos: 0 });
  const rhythm = summarizeRhythm([
    rhythmCell(0, 9, 10), rhythmCell(1, 10, 20), rhythmCell(2, 11, 30), rhythmCell(5, 23, 25), rhythmCell(6, 0, 15),
  ], (cell) => cell.requests);
  assert.equal(rhythm.total, 100);
  assert.equal(rhythm.peakStart, 9, 'the busiest three-hour stretch is named by its first hour');
  assert.equal(rhythm.peakShare, 0.6);
  assert.deepEqual([...peakHourSet(summarizeRhythm([rhythmCell(5, 23, 9), rhythmCell(6, 0, 9), rhythmCell(6, 1, 5), rhythmCell(0, 12, 1)], (cell) => cell.requests))].sort((a, b) => a - b),
    [0, 1, 23], 'a stretch over midnight wraps');
  assert.equal(peakHourSet(summarizeRhythm([], (cell) => cell.requests)).size, 0, 'an empty window marks no peak');

  const DAY = 86_400_000;
  assert.equal(canShowWeekView({ from: 0, to: DAY - 1 }), false, 'a day cannot show a weekday pattern');
  assert.equal(canShowWeekView({ from: 0, to: 7 * DAY - 1 }), true, 'a whole week can');

  // When no API-key credential maps to a configured provider, attributeServingProviders
  // preserves the decoded cube identity without mutating dictionaries.
  const unchanged = attributeServingProviders(cube, () => undefined);
  assert.equal(unchanged, cube);

  // Re-attributed dictionary entries that map two credentials onto the same provider
  // merge cleanly across groupTotals, buildMatrix, and buildFlow.
  const mergedAttr = attributeServingProviders(
    decodeInsightsCube({
      ...response,
      dims: {
        ...response.dims,
        credentials: [
          { auth_index: 'k1', auth_type: 'apikey' },
          { auth_index: 'k2', auth_type: 'apikey' },
        ],
      },
    }),
    () => 'openai-compat-shared',
  );
  const providerTotals = groupTotals(mergedAttr, mergedAttr.rows, 'provider');
  assert.deepEqual([...providerTotals.keys()], ['openai-compat-shared']);
  assert.equal(providerTotals.get('openai-compat-shared')?.requests, 20);
  const mergedMatrix = buildMatrix(mergedAttr, mergedAttr.rows, 'key', 'provider', 'requests', 5, 5);
  assert.equal(mergedMatrix.cells.get(matrixCellKey('hmac:a', 'openai-compat-shared'))?.value, 15);
  const mergedFlow = buildFlow(mergedAttr, mergedAttr.rows, ['key', 'model', 'provider'], 'requests', 5);
  assert.equal(mergedFlow.links.filter((l) => l.target === '2:openai-compat-shared').reduce((s, l) => s + l.value, 0), 20);
});

test('dashboard receipt ledger and calendar windows', () => {
  const columns = [
    'bucket', 'key', 'call_point', 'model', 'provider', 'credential',
    'requests', 'failures', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens',
    'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'latency_sum_ms', 'ttft_sum_ms',
    'ttft_count', 'cost_nanos', 'priced_requests', 'costed_requests',
  ];
  const cell = (bucket: number, key: number, model: number, requests: number, costNanos: number, costed = requests) =>
    [bucket, key, 0, model, 0, 0, requests, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, costNanos, costed, costed];
  const cube = decodeInsightsCube({
    window: { preset: 'yesterday', from: 0, to: 86_399_999, open_end: false, bucket: 'hour', timezone: 'UTC', widened: false },
    compare_window: { from: -86_400_000, to: -1 },
    bucket_starts: [0, 3_600_000],
    dims: {
      keys: [{ id: 'hmac:a', is_client_key: true }, { id: 'hmac:b', is_client_key: true }, { id: 'hmac:c', is_client_key: true }],
      call_points: ['x'],
      models: ['m0', 'm1', 'm2'],
      providers: ['p'],
      credentials: [{ auth_index: 'c', auth_type: 'apikey' }],
    },
    columns,
    rows: [
      // Key a spreads one model over two buckets; the buckets must sum into one line.
      cell(0, 0, 0, 2, 1_000_000_000),
      cell(1, 0, 0, 3, 2_000_000_000),
      cell(0, 0, 1, 1, 500_000_000),
      cell(0, 0, 2, 9, 0, 0),
      cell(0, 1, 0, 4, 5_000_000_000),
      cell(0, 2, 1, 1, 100_000_000),
    ],
    previous_rows: [cell(-1, 0, 0, 5, 4_000_000_000).slice(1)],
    coverage: { fact_requests: 20, detail_requests: 0 },
  });

  const ledger = buildReceiptLedger(cube, undefined, { keys: 2, models: 2 });
  assert.deepEqual(ledger.keys.map((line) => line.key), ['hmac:b', 'hmac:a'], 'keys rank by spend');
  const keyA = ledger.keys[1];
  assert.deepEqual(keyA.models.map((line) => [line.model, line.requests, line.costNanos]), [['m0', 5, 3_000_000_000], ['m1', 1, 500_000_000]]);
  assert.deepEqual(keyA.otherModels, { count: 1, requests: 9, costNanos: 0, costedRequests: 0 }, 'an unpriced tail folds without becoming free');
  assert.deepEqual(ledger.otherKeys, { count: 1, requests: 1, costNanos: 100_000_000, costedRequests: 1 });
  assert.equal(ledger.current.requests, 20);

  const filtered = buildReceiptLedger(cube, 'hmac:a');
  assert.deepEqual(filtered.keys.map((line) => line.key), ['hmac:a'], 'a key filter narrows the receipt to that key');
  assert.equal(filtered.previous.requests, 5);
  assert.equal(filtered.costChange.kind, 'change');

  const window = { from: 1_000, to: 9_000, bucket_ms: 60_000, minutes: 0, complete: true, open_end: false };
  assert.equal(receiptCubeParams({ preset: 'today' }, window), 'preset=today', 'a preset both pages know keeps its own comparison');
  assert.equal(receiptCubeParams({ preset: '1h' }, window), 'from=1000', 'a dashboard-only span reads its bounds, open-ended');
  assert.equal(receiptCubeParams({ from: 1_000, to: 9_000 }, window), 'from=1000&to=9000');

  assert.equal(isSlidingRange({ preset: 'today' }), true);
  assert.equal(isSlidingRange({ preset: 'last_week' }), false, 'a previous calendar unit is closed');
  assert.equal(requestListWindowParams({ preset: 'yesterday' }, window).toString(), 'from=1000&to=9000', 'a calendar drill-down carries its resolved bounds');
  assert.equal(requestListWindowParams({ preset: 'this_month' }, window).toString(), 'from=1000', 'the current unit stays open');
  assert.equal(requestListWindowParams({ preset: 'all' }, window).toString(), 'preset=90d');

  // Skewed 7-node Sankey column reserves minimum node heights within chart bounds.
  const skewedWeights = [100_000, 1, 1, 1, 1, 1, 1];
  const skewedNodes = [
    ...skewedWeights.map((_, idx) => ({
      id: `0:k${idx}`,
      level: 0,
      dimension: 'key' as const,
      value: `k${idx}`,
      folded: idx === skewedWeights.length - 1,
      foldedCount: idx === skewedWeights.length - 1 ? 3 : 0,
    })),
    { id: '1:claude', level: 1, dimension: 'provider' as const, value: 'claude', folded: false, foldedCount: 0 },
  ];
  const skewedLinks = skewedWeights.map((weight, idx) => ({
    source: `0:k${idx}`,
    target: '1:claude',
    value: weight,
  }));
  const chartHeight = 320;
  const { layoutNodes } = buildSankeyLayout(
    skewedNodes,
    skewedLinks,
    640,
    chartHeight,
    () => '#00a2fb',
    (node) => node.value,
  );
  const col0 = layoutNodes.filter((item) => item.node.level === 0);
  assert.equal(col0.length, 7);
  assert.ok(col0.every((item) => item.h >= 4), 'every small node retains the 4px floor');
  const col0Bottom = Math.max(...col0.map((item) => item.y + item.h));
  assert.ok(col0Bottom <= chartHeight - 10 + 1e-6, `skewed column fits inside innerHeight (bottom=${col0Bottom})`);
});

test('a tooltip card travels as one fact per line plus its structure, and an empty card adds no hint', async () => {
  const { readTipCard, tipCard } = await import('../../src/components/common/tipCard.ts');
  const card = { heading: 'Versus the previous period', rows: [{ label: 'Change', value: '+230%', tone: 'up' as const }, { label: 'Previous average', value: '867' }], notes: [false, 'Scaled from the previous period'] };
  const attributes = tipCard(card);
  assert.equal(attributes['data-tip'], 'Versus the previous period\nChange: +230%\nPrevious average: 867\nScaled from the previous period');
  assert.deepEqual(readTipCard(attributes['data-tip-card']), card);
  assert.deepEqual(tipCard({ rows: [], notes: [null] }), {});
  assert.equal(readTipCard('{not json'), null);
});

test('insights label resolver handles deleted OAuth credentials, deleted OpenAI-compatible providers, and live ambiguity', async () => {
  const { createInsightsLabelResolver } = await import('../../src/hooks/useInsightsLabels.ts');
  const { createServingProviderResolver, indexCredentialFiles } = await import('../../src/types/usageEventIdentity.ts');

  const archivedCredentials = [
    {
      auth_index: 'aaaa1111bbbb2222',
      kind: 'oauth' as const,
      provider_key: 'codex',
      provider_family: 'codex',
      masked_account: 'op•••r@acme.test',
      file_name: 'codex-op•••r@acme.test.json',
    },
    {
      auth_index: 'idx-inception-1',
      kind: 'apikey' as const,
      provider_key: 'openai-compatible-inception',
      provider_family: 'openai-compatibility',
      provider_name: 'Inception',
      upstream_name: 'inception',
      key_mask: 'test-key••••••••1111',
    },
  ];
  const archivedCredentialsByIndex = new Map(archivedCredentials.map((item) => [item.auth_index, item]));
  const archivedProvidersByKey = new Map([
    [
      'openai-compatible-inception',
      {
        provider_key: 'openai-compatible-inception',
        kind: 'ai_provider' as const,
        name: 'Inception',
        upstream_name: 'inception',
        family: 'openai-compatibility',
      },
    ],
  ]);

  const rawCube: InsightsCubeResponse = {
    window: { preset: '7d', from: 0, to: 86_400_000, open_end: true, bucket: 'day', timezone: 'UTC', widened: false },
    compare_window: { from: -86_400_000, to: -1 },
    bucket_starts: [0],
    dims: {
      keys: [{ id: 'hmac:a', alias: 'Team', is_client_key: true }],
      call_points: ['gpt-5', 'mercury'],
      models: ['gpt-5', 'mercury'],
      providers: ['codex', 'openai-compatible-inception'],
      credentials: [
        { auth_index: 'aaaa1111bbbb2222', auth_type: 'oauth' },
        { auth_index: 'idx-inception-1', auth_type: 'apikey' },
        { auth_index: 'cccc3333dddd4444', auth_type: 'oauth' },
      ],
    },
    columns: [
      'bucket', 'key', 'call_point', 'model', 'provider', 'credential',
      'requests', 'failures', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens',
      'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'latency_sum_ms', 'ttft_sum_ms',
      'ttft_count', 'cost_nanos', 'priced_requests', 'costed_requests',
    ],
    rows: [
      [0, 0, 0, 0, 0, 0, 25, 0, 2500, 0, 0, 0, 0, 0, 2500, 2000, 0, 0, 1_000_000, 25, 25],
      [0, 0, 1, 1, 1, 1, 15, 0, 1500, 0, 0, 0, 0, 0, 1500, 1200, 0, 0, 1_000_000, 15, 15],
      [0, 0, 0, 0, 0, 2, 5, 0, 500, 0, 0, 0, 0, 0, 500, 400, 0, 0, 500_000, 5, 5],
    ],
    previous_rows: [],
    coverage: { fact_requests: 45, detail_requests: 0 },
  };

  const serving = createServingProviderResolver([], archivedCredentialsByIndex);
  const cube = attributeServingProviders(decodeInsightsCube(rawCube), serving);
  const labels = createInsightsLabelResolver({
    cube,
    credentialFiles: indexCredentialFiles([], archivedCredentials),
    configuredProviders: [],
    archivedCredentialsByIndex,
    archivedProvidersByKey,
    t: (key) => key,
  });

  assert.equal(labels.label('credential', 'aaaa1111bbbb2222'), 'op•••r@acme.test');
  assert.equal(labels.detail('credential', 'aaaa1111bbbb2222'), 'Codex');
  assert.equal(labels.label('credential', 'cccc3333dddd4444'), 'Codex (#cccc3333)');
  assert.equal(labels.label('provider', 'openai-compatible-inception'), 'Inception');
  assert.equal(labels.label('credential', 'idx-inception-1'), 'Inception test-key••••••••1111');

  // If two live configured providers share idx-inception-1, live ambiguity blocks archive fallback.
  const conflictingLive = [
    { id: 'openai-compat-0', name: 'Relay One', auth_indexes: ['idx-inception-1'] },
    { id: 'openai-compat-1', name: 'Relay Two', auth_indexes: ['idx-inception-1'] },
  ];
  assert.equal(createServingProviderResolver(conflictingLive, archivedCredentialsByIndex)('idx-inception-1'), undefined);
  const ambiguousLabels = createInsightsLabelResolver({
    cube,
    credentialFiles: indexCredentialFiles([], archivedCredentials),
    configuredProviders: conflictingLive,
    archivedCredentialsByIndex,
    archivedProvidersByKey,
    t: (key) => key,
  });
  assert.equal(ambiguousLabels.label('credential', 'idx-inception-1'), 'idx-inception-1');

  // Comparison rows (previous_rows) also participate in provider claim attribution and conflict detection.
  const compareConflictCube = decodeInsightsCube({
    ...rawCube,
    dims: {
      ...rawCube.dims,
      providers: ['codex', 'claude'],
      credentials: [
        ...rawCube.dims.credentials,
        { auth_index: 'eeee5555ffff6666', auth_type: 'oauth' },
      ],
    },
    rows: [
      [0, 0, 0, 0, 0, 2, 5, 0, 500, 0, 0, 0, 0, 0, 500, 400, 0, 0, 500_000, 5, 5],
    ],
    previous_rows: [
      [-1, 0, 0, 0, 1, 2, 3, 0, 300, 0, 0, 0, 0, 0, 300, 200, 0, 0, 300_000, 3, 3],
      [-1, 0, 0, 0, 1, 3, 2, 0, 200, 0, 0, 0, 0, 0, 200, 100, 0, 0, 200_000, 2, 2],
    ],
  });
  const compareLabels = createInsightsLabelResolver({
    cube: compareConflictCube,
    credentialFiles: new Map(),
    configuredProviders: [],
    t: (key) => key,
  });
  assert.equal(
    compareLabels.label('credential', 'cccc3333dddd4444'),
    '#cccc3333',
    'conflicting providers across current and previous windows drop provider attribution',
  );
  assert.equal(
    compareLabels.label('credential', 'eeee5555ffff6666'),
    'Claude (#eeee5555)',
    'credential present only in comparison window still resolves its unambiguous provider',
  );
});

test('insights token anatomy, net scope, request drill-down and export', () => {
  const measures = (patch: Partial<Measures>): Measures => ({ ...emptyMeasures(), ...patch });

  // OpenAI style: the cache read sits inside the input count and in `cached_tokens`.
  const openai = tokenAnatomy(measures({ inputTokens: 1000, cachedTokens: 600, outputTokens: 300, reasoningTokens: 100, totalTokens: 1300 }));
  assert.deepEqual(
    [openai.cacheRead, openai.cacheWrite, openai.uncachedInput, openai.regularOutput, openai.reasoningOutput, openai.netTokens],
    [600, 0, 400, 200, 100, 700],
  );
  // The five parts never overlap: they add back to the prompt and the completion.
  assert.equal(openai.cacheRead + openai.cacheWrite + openai.uncachedInput, openai.promptTotal);
  assert.equal(openai.regularOutput + openai.reasoningOutput, openai.completionTotal);
  // Both cache fields present: the explicit read wins, they are never added together.
  assert.equal(tokenAnatomy(measures({ inputTokens: 1000, cachedTokens: 600, cacheReadTokens: 500 })).cacheRead, 500);
  // Anthropic style: the input is reported beside the cache parts, so the prompt is all three and the
  // input survives as the uncached part - whether the total counted the cache or was never reported.
  for (const totalTokens of [1070, 0, 70]) {
    const anthropic = tokenAnatomy(measures({ inputTokens: 50, cacheReadTokens: 900, cacheCreationTokens: 100, outputTokens: 20, totalTokens }));
    assert.deepEqual([anthropic.promptTotal, anthropic.uncachedInput, anthropic.netTokens], [1050, 50, 70], `total ${totalTokens}`);
  }
  // Without an input count the prompt is what the total leaves after the output.
  assert.equal(tokenAnatomy(measures({ totalTokens: 500, outputTokens: 100 })).promptTotal, 400);

  assert.equal(measuresCacheRate(measures({ inputTokens: 1000, cachedTokens: 600 })), 60);
  assert.equal(measuresCacheRate(measures({ inputTokens: 1000, cacheReadTokens: 1000 })), 99.9);
  assert.equal(measuresCacheRate(emptyMeasures()), null);
  assert.equal(measuresReasoningShare(measures({ outputTokens: 400, reasoningTokens: 100 })), 25);
  assert.equal(measuresReasoningShare(emptyMeasures()), null);
  assert.equal(measuresAvgTtftMs(measures({ ttftSumMs: 900, ttftCount: 3 })), 300);
  assert.equal(measuresAvgTtftMs(emptyMeasures()), null);

  const COLUMNS = [
    'bucket', 'key', 'call_point', 'model', 'provider', 'credential', 'requests', 'failures', 'input_tokens',
    'output_tokens', 'reasoning_tokens', 'cached_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens',
    'latency_sum_ms', 'ttft_sum_ms', 'ttft_count', 'cost_nanos', 'priced_requests', 'costed_requests',
  ];
  const row = (bucket: number, key: number, input: number, cacheRead: number, output: number) =>
    [bucket, key, 0, 0, 0, 0, 1, 0, input, output, 0, 0, cacheRead, 0, input + output, 100, 0, 0, 0, 0, 0];
  const cube = decodeInsightsCube({
    window: { preset: 'custom', from: 1_000, to: 9_999, open_end: false, bucket: 'hour', timezone: 'UTC', widened: false },
    compare_window: { from: -8_000, to: 999 },
    bucket_starts: [1_000, 5_000],
    dims: {
      keys: [{ id: 'hmac:a', is_client_key: true }, { id: 'hmac:b', is_client_key: true }, { id: 'claude', is_client_key: false }],
      call_points: ['fast'], models: ['gpt-5'], providers: ['codex'], credentials: [{ auth_index: 'c1', auth_type: 'oauth' }],
    },
    columns: COLUMNS,
    // Key A sends large, mostly cached prompts; key B small uncached ones.
    rows: [row(0, 0, 10_000, 9_000, 100), row(1, 1, 3_000, 0, 100)],
    previous_rows: [row(0, 0, 5_000, 4_000, 100), row(1, 1, 1_000, 0, 100)],
    coverage: { fact_requests: 2, detail_requests: 2 },
  });
  assert.equal(cube.rows[0].measures.cacheReadTokens, 9_000);

  // All tokens rank key A first; net tokens rank key B first. The page reads `net_tokens` off the sums
  // it already makes, and that agrees with rewriting every row (`scopeTokens`) and summing.
  assert.equal(cubeMetric('tokens', 'net'), 'net_tokens');
  assert.equal(cubeMetric('cost', 'net'), 'cost');
  assert.deepEqual(rankGroups(groupTotals(cube, cube.rows, 'key'), 'tokens').map((group) => group.id), ['hmac:a', 'hmac:b']);
  assert.deepEqual(rankGroups(groupTotals(cube, cube.rows, 'key'), 'net_tokens').map((group) => group.id), ['hmac:b', 'hmac:a']);
  const net = scopeTokens(cube, 'net');
  assert.equal(scopeTokens(cube, 'all'), cube);
  assert.deepEqual(rankGroups(groupTotals(net, net.rows, 'key'), 'tokens').map((group) => group.id), ['hmac:b', 'hmac:a']);
  assert.equal(metricValue(sumMeasures(cube.rows), 'net_tokens'), sumMeasures(net.rows).totalTokens);
  assert.equal(metricValue(sumMeasures(cube.rows), 'net_tokens'), 1_100 + 3_100);
  assert.deepEqual(
    trendSeries(cube, cube.rows, 'net_tokens', 'key', ['hmac:a', 'hmac:b']).map((group) => group.values),
    trendSeries(net, net.rows, 'tokens', 'key', ['hmac:a', 'hmac:b']).map((group) => group.values),
  );
  // The comparison baseline reads the net tokens of the rows it is compared to.
  assert.equal(metricValue(baselineMeasures(cube.previous, 1).raw, 'net_tokens'), 1_100 + 1_100);
  assert.equal(metricValue(baselineMeasures(cube.previous, 1).baseline, 'net_tokens'), baselineMeasures(net.previous, 1).baseline.totalTokens);
  assert.equal(baselineMeasures(cube.previous, 1).raw.totalTokens, 5_100 + 1_100);

  // Rows that count the cache three different ways decode into one accounting, each by its provider's
  // protocol, so their sum cuts into the same parts as the rows cut one by one.
  const mixed = decodeInsightsCube({
    window: cube.window, compare_window: null, bucket_starts: [1_000],
    dims: { keys: [{ id: 'hmac:a', is_client_key: true }], call_points: ['fast'], models: ['gpt-5'], providers: ['codex', 'claude'], credentials: [{ auth_index: 'c1', auth_type: 'oauth' }] },
    columns: COLUMNS,
    rows: [
      // input inclusive, read reported as cached_tokens
      [0, 0, 0, 0, 0, 0, 1, 0, 1_000, 300, 100, 600, 0, 0, 1_300, 100, 0, 0, 0, 0, 0],
      // input inclusive, read reported as cache_read_tokens
      [0, 0, 0, 0, 0, 0, 1, 0, 2_000, 100, 0, 0, 1_500, 0, 2_100, 100, 0, 0, 0, 0, 0],
      // Anthropic: input reported beside the cache, no total
      [0, 0, 0, 0, 1, 0, 1, 0, 50, 20, 0, 0, 900, 100, 0, 100, 0, 0, 0, 0, 0],
    ],
    previous_rows: [],
    coverage: { fact_requests: 3, detail_requests: 3 },
  });
  const parts = sumAnatomy(mixed.rows);
  const whole = tokenAnatomy(sumMeasures(mixed.rows));
  assert.deepEqual(whole, parts);
  assert.equal(parts.netTokens, (400 + 300) + (500 + 100) + (50 + 20));
  assert.equal(sumMeasures(mixed.rows).netTokens, parts.netTokens);

  // Normalising is idempotent: a normalised record is never read as raw again. A total that balances
  // input, cache and output exactly says the input was reported apart from the cache.
  const once = normalizeMeasures(measures({ inputTokens: 100, cacheReadTokens: 50, outputTokens: 10, totalTokens: 160 }));
  assert.deepEqual(normalizeMeasures(once), once);
  assert.deepEqual([tokenAnatomy(once).promptTotal, tokenAnatomy(once).netTokens], [150, 110]);
  // Slack a total does not account for is never guessed into a cache reported apart.
  const slack = normalizeMeasures(measures({ inputTokens: 100, cacheReadTokens: 50, outputTokens: 10, totalTokens: 1000 }));
  assert.deepEqual(normalizeMeasures(slack), slack);
  assert.deepEqual(
    [tokenAnatomy(slack).promptTotal, tokenAnatomy(slack).uncachedInput, tokenAnatomy(slack).netTokens, slack.totalTokens],
    [100, 50, 60, 1000],
  );
  // A sum's total spans rows: it cannot make one row's inclusive input read as reported apart.
  const rowA = { bucket: 0, dims: [0, 0, 0, 0, 0], measures: normalizeMeasures(measures({ requests: 1, inputTokens: 100, outputTokens: 10, totalTokens: 1000 })) };
  const rowB = { bucket: 0, dims: [0, 0, 0, 0, 0], measures: normalizeMeasures(measures({ requests: 1, inputTokens: 100, cacheReadTokens: 50, outputTokens: 10, totalTokens: 110 })) };
  const summed = tokenAnatomy(sumMeasures([rowA, rowB]));
  assert.deepEqual(summed, sumAnatomy([rowA, rowB]));
  assert.deepEqual([summed.promptTotal, summed.uncachedInput, summed.netTokens], [200, 150, 170]);
  // A raw record mixed into a sum keeps the sum raw.
  assert.equal(sumMeasures([rowA, { ...rowB, measures: measures({ requests: 1 }) }]).isNormalized, false);
  assert.equal(sumMeasures([rowA, rowB]).isNormalized, true);

  // Reasoning reported beside the output: the total has room for both, so the completion is their sum.
  const reasoning = tokenAnatomy(measures({ inputTokens: 100, outputTokens: 20, reasoningTokens: 30, totalTokens: 150 }));
  assert.deepEqual(
    [reasoning.completionTotal, reasoning.regularOutput, reasoning.reasoningOutput, reasoning.netTokens],
    [50, 20, 30, 150],
  );

  // Anthropic reports the input apart from the cache and the thinking inside the output; the prompt is
  // settled before reasoning, so room the cache leaves in the total is not extra completion.
  const cacheRoom = tokenAnatomy(measures({ inputTokens: 50, cacheReadTokens: 900, outputTokens: 100, reasoningTokens: 20, totalTokens: 1050 }), 'claude');
  assert.deepEqual(
    [cacheRoom.promptTotal, cacheRoom.completionTotal, cacheRoom.regularOutput, cacheRoom.reasoningOutput, cacheRoom.netTokens],
    [950, 100, 80, 20, 150],
  );
  const inclusiveReasoning = tokenAnatomy(measures({ inputTokens: 1000, cacheReadTokens: 100, outputTokens: 200, reasoningTokens: 50, totalTokens: 1300 }), 'claude');
  assert.deepEqual([inclusiveReasoning.promptTotal, inclusiveReasoning.completionTotal, inclusiveReasoning.netTokens], [1100, 200, 1200]);

  const anatomyOfPrompt = (anatomy: ReturnType<typeof tokenAnatomy>) =>
    [anatomy.promptTotal, anatomy.completionTotal, anatomy.uncachedInput, anatomy.netTokens];
  // Each provider has one reading: Anthropic's thinking stays inside the output whatever slack the
  // total has, and a custom provider named for Claude is read as Anthropic.
  for (const [provider, totalTokens] of [['claude', 150], ['plugin-claude', 140]] as const) {
    const thinking = tokenAnatomy(measures({ inputTokens: 100, cacheReadTokens: 10, cachedTokens: 10, outputTokens: 30, reasoningTokens: 10, totalTokens }), provider);
    assert.deepEqual([thinking.promptTotal, thinking.completionTotal, thinking.netTokens], [110, 30, 130], provider);
  }

  // A known protocol's prompt is its columns: slack in Anthropic's total never becomes uncached input,
  // and its explicit cache sits beside the input whatever the total says.
  const anthropicSlack = measures({ requests: 1, inputTokens: 0, outputTokens: 30, reasoningTokens: 10, cachedTokens: 100, cacheReadTokens: 100, cacheCreationTokens: 50, totalTokens: 200 });
  assert.deepEqual(anatomyOfPrompt(tokenAnatomy(anthropicSlack, 'claude')), [150, 30, 0, 30]);
  assert.equal(normalizeMeasures(anthropicSlack, 'claude').totalTokens, 200);
  const anthropicShort = measures({ requests: 1, inputTokens: 100, outputTokens: 30, reasoningTokens: 10, cachedTokens: 100, cacheReadTokens: 100, cacheCreationTokens: 50, totalTokens: 180 });
  assert.deepEqual(anatomyOfPrompt(tokenAnatomy(anthropicShort, 'claude')), [250, 30, 100, 130]);

  // OpenAI counts the cache inside the input; slack in its total is not a second prompt.
  const anatomyOf = (anatomy: ReturnType<typeof tokenAnatomy>) =>
    [anatomy.promptTotal, anatomy.completionTotal, anatomy.uncachedInput, anatomy.regularOutput, anatomy.reasoningOutput, anatomy.netTokens];
  const openAISlack = measures({ inputTokens: 100, cachedTokens: 80, outputTokens: 20, totalTokens: 1000 });
  assert.deepEqual(anatomyOf(tokenAnatomy(openAISlack, 'openai')), [100, 20, 20, 20, 0, 40]);
  assert.deepEqual(anatomyOf(tokenAnatomy(openAISlack)), [100, 20, 20, 20, 0, 40]);
  // Gemini counts the cache inside the input and the thinking beside the output, whatever the figures coincide with.
  const geminiEqualCache = measures({ inputTokens: 100, cachedTokens: 10, cacheReadTokens: 10, outputTokens: 30, reasoningTokens: 10, totalTokens: 140 });
  assert.deepEqual(anatomyOf(tokenAnatomy(geminiEqualCache, 'gemini')), [100, 40, 90, 30, 10, 130]);
  assert.deepEqual(anatomyOf(tokenAnatomy(geminiEqualCache)), [100, 40, 90, 30, 10, 130]);
  const geminiOutputCache = tokenAnatomy(measures({ inputTokens: 100, cachedTokens: 25, cacheReadTokens: 25, outputTokens: 25, reasoningTokens: 10, totalTokens: 135 }), 'gemini');
  assert.deepEqual([geminiOutputCache.promptTotal, geminiOutputCache.completionTotal, geminiOutputCache.netTokens], [100, 35, 110]);

  // A connection drills into the credentials that served it, up to the server's ceiling on one filter;
  // past it the link is withheld rather than cut short.
  const servedBy = (credentials: number) => decodeInsightsCube({
    window: cube.window, compare_window: null, bucket_starts: [1_000],
    dims: {
      keys: [{ id: 'hmac:a', is_client_key: true }], call_points: ['fast'], models: ['gpt-5'], providers: ['connection-id'],
      credentials: Array.from({ length: credentials }, (_, index) => ({ auth_index: `c${String(index).padStart(3, '0')}`, auth_type: 'oauth' })),
    },
    columns: COLUMNS,
    rows: Array.from({ length: credentials }, (_, index) => [0, 0, 0, 0, 0, index, 1, 0, 10, 1, 0, 0, 0, 0, 11, 100, 0, 0, 0, 0, 0]),
    previous_rows: [],
    coverage: { fact_requests: credentials, detail_requests: credentials },
  });
  for (const credentials of [65, MAX_USAGE_EVENT_FILTER_VALUES]) {
    const served = servedBy(credentials);
    assert.equal(canDrillUsageEvents(served, { provider: ['connection-id'] }), true);
    const drill = new URLSearchParams(usageEventsHref(served, { provider: ['connection-id'] }).split('?')[1]);
    assert.equal(drill.getAll('auth_index').length, credentials);
    assert.equal(drill.has('provider'), false);
  }
  assert.equal(canDrillUsageEvents(servedBy(MAX_USAGE_EVENT_FILTER_VALUES + 1), { provider: ['connection-id'] }), false);
  assert.equal(canDrillUsageEvents(cube, { key: Array.from({ length: 300 }, () => 'hmac:a') }), true);

  // A server that partitions the columns sends `net_tokens`; its rows are taken as they are.
  const partitioned = decodeInsightsCube({
    window: cube.window, compare_window: null, bucket_starts: [1_000],
    dims: { keys: [{ id: 'hmac:a', is_client_key: true }], call_points: ['fast'], models: ['gpt-5'], providers: ['codex'], credentials: [{ auth_index: 'c1', auth_type: 'oauth' }] },
    columns: [...COLUMNS, 'net_tokens'],
    rows: [[0, 0, 0, 0, 0, 0, 1, 0, 1_050, 20, 0, 900, 900, 100, 1_070, 100, 0, 0, 0, 0, 0, 70]],
    previous_rows: [],
    coverage: { fact_requests: 1, detail_requests: 1 },
  });
  assert.equal(partitioned.rows[0].measures.isNormalized, true);
  assert.equal(partitioned.rows[0].measures.inputTokens, 1_050);
  assert.equal(metricValue(sumMeasures(partitioned.rows), 'net_tokens'), 70);
  assert.deepEqual(
    clientMeasures({
      id: 'x', category: 'agent', requests: 1, failures: 0, input_tokens: 1_050, output_tokens: 20, reasoning_tokens: 0,
      cached_tokens: 900, cache_read_tokens: 900, cache_creation_tokens: 100, total_tokens: 1_070, net_tokens: 70,
      latency_sum_ms: 0, ttft_sum_ms: 0, ttft_count: 0, cost_nanos: 0, priced_requests: 0, costed_requests: 0,
    }).netTokens,
    70,
  );

  // The request list reads back the view: window, every chosen key group - even one this window never
  // saw, so the list opens empty as the page reads zero - the model vocabulary and the client.
  const href = usageEventsHref(cube, { key: ['hmac:a', 'claude', 'hmac:gone'], call_point: ['fast'], model: ['gpt-5'] }, 'claude-code');
  assert.ok(href.startsWith('/usage/events?'));
  const query = readEventQuery(new URLSearchParams(href.slice(href.indexOf('?') + 1)));
  assert.deepEqual([query.from, query.to], [1_000, 9_999]);
  assert.deepEqual(query.filters, { model: ['gpt-5'], model_alias: ['fast'], api_key: ['hmac:a', 'claude', 'hmac:gone'], client_agent: ['claude-code'] });
  assert.deepEqual(new URLSearchParams(usageEventsHref(cube, { key: ['hmac:absent'] }).split('?')[1]).getAll('api_key'), ['hmac:absent']);
  assert.deepEqual(
    new URLSearchParams(usageEventsHref(cube, { call_point: [' fast ', 'fast'], model: ['gpt-5', ''] }).split('?')[1]).toString(),
    'from=1000&to=9999&model_alias=fast&model=gpt-5',
    'the link carries the values the check counted: trimmed, each once, none blank',
  );
  // The client ranking passes the window its own read was answered for.
  const clientWindow = { ...cube.window, from: 2_000, to: 3_000 };
  const windowed = new URLSearchParams(usageEventsHref(cube, {}, 'claude-code', clientWindow).split('?')[1]);
  assert.deepEqual([windowed.get('from'), windowed.get('to')], ['2000', '3000']);
  assert.equal(query.text, undefined);
  // The `other` bucket names no one program, so it narrows nothing.
  assert.ok(!usageEventsHref(cube, {}, 'other').includes('client_agent'));
  // The page's client filter reaches the list; one program's own link replaces it rather than adding.
  assert.deepEqual(new URLSearchParams(usageEventsHref(cube, { client: ['claude-code', 'opencode'] }).split('?')[1]).getAll('client_agent'), ['claude-code', 'opencode']);
  assert.deepEqual(new URLSearchParams(usageEventsHref(cube, { client: ['claude-code'] }, 'opencode').split('?')[1]).getAll('client_agent'), ['opencode']);
  // A provider filter becomes the credentials that served it; a window following the clock stays open.
  const open = { ...cube, window: { ...cube.window, open_end: true } };
  const providerQuery = new URLSearchParams(usageEventsHref(open, { provider: ['codex'] }).split('?')[1]);
  assert.deepEqual([providerQuery.getAll('auth_index'), providerQuery.has('to'), providerQuery.has('client_agent')], [['c1'], false, false]);

  // Export: BOM, quoted text, formula-looking text defused even behind blanks.
  assert.equal(csvCell('=SUM(A1)'), `"'=SUM(A1)"`);
  assert.equal(csvCell('  @cmd'), `"'  @cmd"`);
  assert.equal(csvCell('-1+2'), `"'-1+2"`);
  assert.equal(csvCell('\tx'), `"'\tx"`);
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell(12), '12');
  assert.equal(csvCell(null), '');
  const csv = insightsCsv(['Name'], [{
    dimension: 'Key', name: '+Ada', detail: 'sk-…aaaa',
    measures: measures({ requests: 2, inputTokens: 1000, cachedTokens: 600, outputTokens: 300, totalTokens: 1300, latencySumMs: 400 }),
    anatomy: openai,
  }]);
  assert.ok(csv.startsWith('﻿"Name"\r\n'));
  assert.equal(csv.split('\r\n')[1], `"Key","'+Ada","sk-…aaaa",2,0,400,600,0,200,100,1300,700,60,,200,`);

  assert.equal(clientProductName('claude-code'), 'Claude Code');
  assert.equal(clientProductName('oh-my-pi'), 'Oh My Pi (omp)');
  assert.equal(clientProductName('new-agent'), 'New Agent');
  assert.equal(clientProductName('oh-my-cpa'), 'Oh My CPA');
  assert.equal(clientProductName('hindsight'), 'Hindsight');
  assert.equal(clientProductName('node-http'), 'Node HTTP');
  assert.equal(clientProductName('google-genai-sdk'), 'Google GenAI SDK');
  assert.equal(clientProductName('unknown'), undefined);
  // Identifiers come from request headers; one that names an `Object.prototype` member is still just a word.
  assert.equal(clientProductName('constructor'), 'Constructor');
  assert.equal(clientIconId('constructor'), undefined);
  assert.equal(clientIconId('claude-code'), 'ClaudeCode');
  assert.equal(clientCoverageShare({ total_requests: 40, retained_requests: 10 }), 25);
  assert.equal(clientCoverageShare({ total_requests: 40, retained_requests: 40 }), null);
  assert.equal(clientCoverageShare({ total_requests: 0, retained_requests: 0 }), null);
});
