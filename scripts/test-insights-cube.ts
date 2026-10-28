import assert from 'node:assert/strict';
import {
  FOLDED_ID,
  buildFlow,
  buildMatrix,
  compareMetric,
  decodeInsightsCube,
  emptyMeasures,
  facetValues,
  filterRows,
  groupTotals,
  isOAuthRow,
  matrixCellKey,
  metricValue,
  rankGroups,
  sumMeasures,
  trendSeries,
} from '../web/src/pages/insights/insightsCube.ts';
import { comparesSameStretch, insightsRangeParams, parseInsightsRange } from '../web/src/types/insights.ts';
import { canShowWeekView, peakHourSet, summarizeRhythm } from '../web/src/pages/insights/insightsRhythm.ts';
import { DEFAULT_INSIGHTS_VIEW, readInsightsView, toggleFilter, writeInsightsView } from '../web/src/pages/insights/insightsViewState.ts';
import type { InsightsCubeResponse } from '../web/src/types/insights.ts';

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

// ── the stored window ─────────────────────────────────────────────────────────

assert.deepEqual(parseInsightsRange({ preset: 'this_week' }), { preset: 'this_week' });
assert.equal(parseInsightsRange({ preset: '15m' }), undefined, 'a dashboard-only preset is not an Insights window');
assert.deepEqual(parseInsightsRange({ from: 10, to: null }), { from: 10, to: null });
assert.equal(parseInsightsRange({ from: 10, to: 5 }), undefined);
assert.equal(insightsRangeParams({ preset: 'today' }), 'preset=today');
assert.equal(insightsRangeParams({ from: 1, to: null }, 'day'), 'from=1&bucket=day', 'an open range sends no end');

// A running calendar unit compares against the same stretch of the previous one; every other window
// compares against a whole period, so its figure is not a partial reading that needs saying.
const resolvedWindow = (preset: string, isOpen: boolean) => ({
  preset, from: 0, to: 1, open_end: isOpen, bucket: 'hour' as const, timezone: 'UTC', widened: false,
});
assert.equal(comparesSameStretch(resolvedWindow('today', true)), true);
assert.equal(comparesSameStretch(resolvedWindow('this_month', true)), true);
assert.equal(comparesSameStretch(resolvedWindow('yesterday', false)), false, 'a closed unit compares against a whole period');
assert.equal(comparesSameStretch(resolvedWindow('7d', true)), false, 'a relative window compares against a whole span');
assert.equal(comparesSameStretch(resolvedWindow('custom', true)), false, 'an open-ended range compares against the span before it');

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
