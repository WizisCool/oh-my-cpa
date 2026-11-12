import assert from 'node:assert/strict';
import {
  FOLDED_ID,
  attributeServingProviders,
  baselineMeasures,
  buildFlow,
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
  rankGroups,
  robustBucketSum,
  sumMeasures,
  trendSeries,
} from '../../src/types/insightsCube.ts';
import { formatCountBaseline } from '../../src/types/insightsFormat.ts';
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

  // ── the view in the URL ───────────────────────────────────────────────────────

  assert.equal(writeInsightsView(DEFAULT_INSIGHTS_VIEW).toString(), '', 'a default view is a plain link');
  const sharedView = { ...DEFAULT_INSIGHTS_VIEW, metric: 'cost' as const, isComparing: false, filters: { key: ['hmac:a', 'hmac:b'], provider: ['codex'] } };
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
