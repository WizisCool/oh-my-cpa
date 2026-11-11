/**
 * The Insights cube, pivoted in the browser.
 *
 * One response holds the window's usage per bucket and per dimension tuple (client key, call point,
 * model, provider, credential). Every panel on the page is a projection of it: the tiles sum it, the
 * trend groups it per bucket, the rankings group it per value, the matrix crosses two dimensions and
 * the flow chains three. Doing that here rather than asking the server again is what lets a filter or
 * a regrouping answer on the frame it was asked, and what keeps every panel describing one snapshot -
 * a key's rank and colour cannot differ between two panels that read the same rows.
 *
 * Pure: no React, no DOM. `web/tests/logic/insights-cube.test.ts` holds its claims.
 */

import type { InsightsCompareWindow, InsightsCubeResponse, InsightsKey, InsightsWindow } from './insights';

export const INSIGHTS_DIMENSIONS = ['key', 'call_point', 'model', 'provider', 'credential'] as const;
export type InsightsDimension = (typeof INSIGHTS_DIMENSIONS)[number];

export const INSIGHTS_METRICS = ['tokens', 'cost', 'requests', 'latency'] as const;
export type InsightsMetric = (typeof INSIGHTS_METRICS)[number];

/** Metrics that add up across groups, and so can be stacked and shared out. */
export function isAdditiveMetric(metric: InsightsMetric): boolean {
  return metric === 'cost' || metric === 'tokens' || metric === 'requests';
}

/** Selected values per dimension. A dimension absent or empty is no constraint. */
export type InsightsFilters = Partial<Record<InsightsDimension, readonly string[]>>;

export interface Measures {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  latencySumMs: number;
  ttftSumMs: number;
  ttftCount: number;
  costNanos: number;
  pricedRequests: number;
  costedRequests: number;
}

export function emptyMeasures(): Measures {
  return {
    requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    totalTokens: 0, latencySumMs: 0, ttftSumMs: 0, ttftCount: 0,
    costNanos: 0, pricedRequests: 0, costedRequests: 0,
  };
}

function addInto(target: Measures, source: Measures): void {
  target.requests += source.requests;
  target.failures += source.failures;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.totalTokens += source.totalTokens;
  target.latencySumMs += source.latencySumMs;
  target.ttftSumMs += source.ttftSumMs;
  target.ttftCount += source.ttftCount;
  target.costNanos += source.costNanos;
  target.pricedRequests += source.pricedRequests;
  target.costedRequests += source.costedRequests;
}

export interface CubeRow {
  /** Index into `bucketStarts`; -1 on a comparison row, which has no bucket. */
  bucket: number;
  /** Dictionary indices, in `INSIGHTS_DIMENSIONS` order. */
  dims: readonly number[];
  measures: Measures;
}

export interface InsightsCube {
  window: InsightsWindow;
  compare: InsightsCompareWindow | null;
  bucketStarts: readonly number[];
  keys: readonly InsightsKey[];
  /** The string identity of each dictionary entry, per dimension. */
  values: Readonly<Record<InsightsDimension, readonly string[]>>;
  /** The auth type of each credential entry, parallel to `values.credential`. */
  credentialTypes: readonly string[];
  rows: readonly CubeRow[];
  previous: readonly CubeRow[];
}

/**
 * Decodes the wire cube. Columns are found by name rather than by position, so a measure the server
 * adds later does not shift the ones read here.
 */
export function decodeInsightsCube(response: InsightsCubeResponse): InsightsCube {
  const position = new Map(response.columns.map((name, index) => [name, index]));
  const require = (name: string) => {
    const index = position.get(name);
    if (index === undefined) throw new Error(`insights cube is missing the ${name} column`);
    return index;
  };
  const [d0, d1, d2, d3, d4] = INSIGHTS_DIMENSIONS.map(require);
  const cRequests = require('requests');
  const cFailures = require('failures');
  const cInput = require('input_tokens');
  const cOutput = require('output_tokens');
  const cReasoning = require('reasoning_tokens');
  const cTotal = require('total_tokens');
  const cLatency = require('latency_sum_ms');
  const cTtftSum = require('ttft_sum_ms');
  const cTtftCount = require('ttft_count');
  const cCost = require('cost_nanos');
  const cPriced = require('priced_requests');
  const cCosted = require('costed_requests');
  const bucketColumn = require('bucket');
  const decode = (cells: readonly number[], offset: number, bucket: number): CubeRow => ({
    bucket,
    dims: [
      cells[d0 - offset] ?? 0,
      cells[d1 - offset] ?? 0,
      cells[d2 - offset] ?? 0,
      cells[d3 - offset] ?? 0,
      cells[d4 - offset] ?? 0,
    ],
    measures: {
      requests: cells[cRequests - offset] ?? 0,
      failures: cells[cFailures - offset] ?? 0,
      inputTokens: cells[cInput - offset] ?? 0,
      outputTokens: cells[cOutput - offset] ?? 0,
      reasoningTokens: cells[cReasoning - offset] ?? 0,
      totalTokens: cells[cTotal - offset] ?? 0,
      latencySumMs: cells[cLatency - offset] ?? 0,
      ttftSumMs: cells[cTtftSum - offset] ?? 0,
      ttftCount: cells[cTtftCount - offset] ?? 0,
      costNanos: cells[cCost - offset] ?? 0,
      pricedRequests: cells[cPriced - offset] ?? 0,
      costedRequests: cells[cCosted - offset] ?? 0,
    },
  });
  return {
    window: response.window,
    compare: response.compare_window,
    bucketStarts: response.bucket_starts,
    keys: response.dims.keys,
    values: {
      key: response.dims.keys.map((key) => key.id),
      call_point: response.dims.call_points,
      model: response.dims.models,
      provider: response.dims.providers,
      credential: response.dims.credentials.map((credential) => credential.auth_index),
    },
    credentialTypes: response.dims.credentials.map((credential) => credential.auth_type),
    rows: response.rows.map((cells) => decode(cells, 0, cells[bucketColumn] ?? 0)),
    // A comparison row carries the same cells without the leading bucket column.
    previous: response.previous_rows.map((cells) => decode(cells, 1, -1)),
  };
}

const DIMENSION_POSITION: Record<InsightsDimension, number> = {
  key: 0, call_point: 1, model: 2, provider: 3, credential: 4,
};

export function rowValue(cube: InsightsCube, row: CubeRow, dimension: InsightsDimension): string {
  return cube.values[dimension][row.dims[DIMENSION_POSITION[dimension]]] ?? '';
}

/**
 * Whether a row was served through an OAuth sign-in rather than a configured API key - the
 * dashboard's split between OAuth channels and AI providers. A row that names no credential has no
 * sign-in to credit, so it counts with its provider.
 */
export function isOAuthRow(cube: InsightsCube, row: CubeRow): boolean {
  const index = row.dims[DIMENSION_POSITION.credential];
  return cube.credentialTypes[index] === 'oauth' && (cube.values.credential[index] ?? '') !== '';
}

/** Whether a credential is an API key, whose runtime index a configured provider publishes. */
function isAPIKeyCredential(authType: string | undefined): boolean {
  const type = (authType || '').trim().toLowerCase();
  return type === 'apikey' || type === 'api_key';
}

/**
 * Re-keys the provider dimension by the provider that answered each row.
 *
 * CPA labels every API-key request with its protocol family - `claude`, `codex` - and writes the same
 * word for that family's OAuth channel, so the recorded label names a dialect several unrelated
 * connections speak. A provider the operator named AnyRouter therefore reads under the family's
 * brand, beside the channel's own traffic. The credential that served the row is what identifies the
 * connection: the configured provider publishing that runtime auth index in its credential list
 * claims the row.
 *
 * A row no provider claims keeps CPA's label, which is then the truest thing known about it: a
 * rotated, removed or twice-published credential cannot be replaced by a weaker guess without moving
 * history. Only an API-key credential is asked: an OAuth record's index sits in the same column but
 * belongs to a sign-in.
 */
export function attributeServingProviders(
  cube: InsightsCube,
  providerIDOf: (authIndex: string) => string | undefined,
): InsightsCube {
  // One lookup per credential dictionary entry, not per row: a window holds far more rows than
  // credentials, and the answer is the credential's alone.
  const claimed = cube.values.credential.map((authIndex, index) =>
    authIndex && isAPIKeyCredential(cube.credentialTypes[index]) ? providerIDOf(authIndex) : undefined);
  if (!claimed.some((id) => id !== undefined)) {
    return cube;
  }
  const identityOf = (row: CubeRow): string =>
    claimed[row.dims[DIMENSION_POSITION.credential]] ?? rowValue(cube, row, 'provider');

  const identities = new Set<string>();
  for (const row of cube.rows) identities.add(identityOf(row));
  for (const row of cube.previous) identities.add(identityOf(row));
  // Sorted like every other dictionary, so two responses over the same traffic list their providers
  // in one order.
  const provider = [...identities].sort();
  const position = new Map(provider.map((value, index) => [value, index]));
  const rekey = (rows: readonly CubeRow[]) => rows.map((row) => {
    const dims = row.dims.slice();
    dims[DIMENSION_POSITION.provider] = position.get(identityOf(row))!;
    return { ...row, dims };
  });
  return { ...cube, values: { ...cube.values, provider }, rows: rekey(cube.rows), previous: rekey(cube.previous) };
}

/**
 * The rows every selected value admits. `except` leaves dimensions unconstrained: a filter's own
 * picker counts the values it could switch to that way, and a figure that is itself a control over a
 * dimension keeps showing that dimension's other values beside the chosen ones.
 */
export function filterRows(
  cube: InsightsCube,
  rows: readonly CubeRow[],
  filters: InsightsFilters,
  except?: InsightsDimension | readonly InsightsDimension[],
): CubeRow[] {
  const exempt: readonly InsightsDimension[] = except === undefined ? [] : typeof except === 'string' ? [except] : except;
  const active: Array<readonly [number, Uint8Array]> = [];
  for (const dimension of INSIGHTS_DIMENSIONS) {
    const selected = filters[dimension];
    if (exempt.includes(dimension) || !selected || selected.length === 0) continue;
    const dict = cube.values[dimension];
    const wanted = new Set(selected);
    const mask = new Uint8Array(dict.length);
    let anyMatch = false;
    for (let i = 0; i < dict.length; i += 1) {
      if (wanted.has(dict[i])) {
        mask[i] = 1;
        anyMatch = true;
      }
    }
    if (!anyMatch) return [];
    active.push([DIMENSION_POSITION[dimension], mask] as const);
  }
  if (active.length === 0) return rows as CubeRow[];
  const activeCount = active.length;
  const out: CubeRow[] = [];
  outer: for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const dims = row.dims;
    for (let a = 0; a < activeCount; a += 1) {
      const [pos, mask] = active[a];
      const idx = dims[pos];
      if (idx < 0 || idx >= mask.length || mask[idx] === 0) continue outer;
    }
    out.push(row);
  }
  return out;
}

export function sumMeasures(rows: readonly CubeRow[]): Measures {
  const total = emptyMeasures();
  for (const row of rows) addInto(total, row.measures);
  return total;
}

/**
 * One metric of a set of measures, or null where it has no value: a spend with nothing priced, an
 * average over no requests. Null is not zero - "unpriced" and "free" are different readings.
 */
export function metricValue(measures: Measures, metric: InsightsMetric): number | null {
  switch (metric) {
    case 'cost':
      return measures.costedRequests > 0 ? measures.costNanos / 1e9 : null;
    case 'tokens':
      return measures.totalTokens;
    case 'requests':
      return measures.requests;
    case 'latency':
      return measures.requests > 0 ? measures.latencySumMs / measures.requests : null;
  }
}

/** The two-sided 95% normal quantile: how far a reading may wander by chance alone. */
const CONFIDENCE_Z = 1.96;

/**
 * A metric compared with the previous window. `new` is growth from a baseline too small to divide
 * by; `isNoise` marks a change the request counts behind it cannot tell from chance.
 */
export type MetricComparison =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'change'; change: number; isNoise: boolean };

export const NO_COMPARISON: MetricComparison = { kind: 'none' };

/**
 * Compares a metric across the two windows by the evidence behind it, so neither a negligible
 * baseline nor ordinary wobble reads as a trend. Both windows span the same length, and requests are
 * the independent events every metric sums or averages, so each window's count of requests carrying
 * the metric is a Poisson draw and the evidence scales with it - no fixed floor in tokens, spend or
 * requests.
 *
 * - A baseline below the current reading's own sampling noise (z/√n of it), under a rise outside
 *   chance, cannot be told apart from absence at today's scale, so the group arrived rather than
 *   grew: dividing by it only measures the baseline's smallness. The largest ratio this lets through
 *   is √n/z, so the bar rises with evidence.
 * - A change whose log ratio lies within z standard errors, √(1/n + 1/m) with Haldane's ½
 *   correction, is within chance. It still prints, but carries no trend. The error is the Poisson one
 *   for counts; for tokens and spend it is a lower bound (per-request size adds variance), and for a
 *   mean latency it assumes a spread about as wide as the mean.
 */
export function compareMetric(current: Measures, previous: Measures, metric: InsightsMetric): MetricComparison {
  const now = metricValue(current, metric);
  const before = metricValue(previous, metric);
  if (now === null) return NO_COMPARISON;
  // Only a group absent before is new; an unpriced spend is unknown, not zero.
  if (before === null) return previous.requests === 0 && now > 0 ? { kind: 'new' } : NO_COMPARISON;
  if (before <= 0) return now > 0 ? { kind: 'new' } : NO_COMPARISON;
  // Only priced requests say anything about spend. A reading that fell to zero is still measured by
  // every request that ran: a thousand that cost nothing are a firm fall, one that did is not.
  const evidence = (measures: Measures) => (metric === 'cost' ? measures.costedRequests : measures.requests);
  const n = evidence(current);
  const m = evidence(previous);
  const logRatio = now > 0 ? Math.log(now / before) : Math.log(0.5 / (m + 0.5));
  const standardError = Math.sqrt(1 / (n + 0.5) + 1 / (m + 0.5));
  const isNoise = Math.abs(logRatio) < CONFIDENCE_Z * standardError;
  // Below z² requests the noise floor exceeds the reading itself, so an arrival must first be a rise
  // the evidence supports; otherwise a single request a side would read as new.
  if (!isNoise && logRatio > 0 && isAdditiveMetric(metric) && before / now < CONFIDENCE_Z / Math.sqrt(n)) return { kind: 'new' };
  return { kind: 'change', change: now / before - 1, isNoise };
}

export interface GroupTotal {
  id: string;
  measures: Measures;
}

export function groupTotals(cube: InsightsCube, rows: readonly CubeRow[], dimension: InsightsDimension): Map<string, Measures> {
  const dimPos = DIMENSION_POSITION[dimension];
  const dict = cube.values[dimension];
  const byIndex: Array<Measures | undefined> = new Array(dict.length);
  let fallbackEmpty: Measures | undefined;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const idx = row.dims[dimPos];
    if (idx >= 0 && idx < dict.length) {
      let acc = byIndex[idx];
      if (!acc) {
        acc = emptyMeasures();
        byIndex[idx] = acc;
      }
      addInto(acc, row.measures);
    } else {
      if (!fallbackEmpty) fallbackEmpty = emptyMeasures();
      addInto(fallbackEmpty, row.measures);
    }
  }
  const groups = new Map<string, Measures>();
  for (let idx = 0; idx < byIndex.length; idx += 1) {
    const acc = byIndex[idx];
    if (!acc) continue;
    const id = dict[idx] ?? '';
    const existing = groups.get(id);
    if (existing) addInto(existing, acc);
    else groups.set(id, acc);
  }
  if (fallbackEmpty) {
    const existing = groups.get('');
    if (existing) addInto(existing, fallbackEmpty);
    else groups.set('', fallbackEmpty);
  }
  return groups;
}

/**
 * The value a ranking orders by. A non-additive measure is ordered by the requests behind it rather
 * than by its own value, so only additive metrics rank by themselves.
 */
export function rankingMetric(metric: InsightsMetric): InsightsMetric {
  return isAdditiveMetric(metric) ? metric : 'requests';
}

export interface RankedGroup {
  id: string;
  measures: Measures;
  previous: Measures | null;
  /** The group's value of the ranking metric, null when it has none. */
  value: number | null;
  /** The group's part of the whole, for an additive metric; null otherwise. */
  share: number | null;
}

export function rankGroups(
  totals: Map<string, Measures>,
  metric: InsightsMetric,
  previous?: Map<string, Measures>,
): RankedGroup[] {
  const ranking = rankingMetric(metric);
  let whole = 0;
  for (const measures of totals.values()) whole += metricValue(measures, ranking) ?? 0;
  const ranked = [...totals.entries()].map(([id, measures]) => {
    const value = metricValue(measures, ranking);
    return {
      id,
      measures,
      previous: previous?.get(id) ?? (previous ? emptyMeasures() : null),
      value,
      share: whole > 0 && value !== null ? value / whole : null,
    };
  });
  // Descending, unvalued last, ties by identity so two equal groups never swap places between polls.
  ranked.sort((left, right) => {
    const difference = (right.value ?? -Infinity) - (left.value ?? -Infinity);
    if (difference !== 0 && Number.isFinite(difference)) return difference;
    if (left.value === null && right.value !== null) return 1;
    if (right.value === null && left.value !== null) return -1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return ranked;
}

/** The discriminator of the folded remainder. A separate flag, never a reserved name. */
export const FOLDED_ID = '\u0000folded';

export interface TrendGroup {
  id: string;
  folded: boolean;
  /** One value per bucket; null where the metric has no value in that bucket. */
  values: Array<number | null>;
  /** Requests behind each value: one request is a measured average, but not an equally settled one. */
  samples: number[];
}

/**
 * The trend: the metric per bucket, one series per top group plus a remainder, or one series for the
 * whole selection when the trend is not grouped. Every series spans every bucket, zero-filled for an
 * additive metric, so a quiet stretch reads as measured quiet rather than as a gap.
 */
export function trendSeries(
  cube: InsightsCube,
  rows: readonly CubeRow[],
  metric: InsightsMetric,
  dimension: InsightsDimension | null,
  topIds: readonly string[],
): TrendGroup[] {
  const bucketCount = cube.bucketStarts.length;
  const order = dimension === null ? ['all'] : [...topIds, FOLDED_ID];
  const foldedIndex = order.length - 1;
  const cells: Measures[][] = order.map(() => Array.from({ length: bucketCount }, emptyMeasures));
  if (dimension === null) {
    const allSeries = cells[0];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const b = row.bucket;
      if (b < 0 || b >= bucketCount) continue;
      addInto(allSeries[b], row.measures);
    }
  } else {
    const dimPos = DIMENSION_POSITION[dimension];
    const dict = cube.values[dimension];
    const positionById = new Map(order.map((id, index) => [id, index]));
    const slotByDictIndex = new Int32Array(dict.length);
    for (let idx = 0; idx < dict.length; idx += 1) {
      slotByDictIndex[idx] = positionById.get(dict[idx] ?? '') ?? foldedIndex;
    }
    const emptySlot = positionById.get('') ?? foldedIndex;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const b = row.bucket;
      if (b < 0 || b >= bucketCount) continue;
      const dIdx = row.dims[dimPos];
      const slot = dIdx >= 0 && dIdx < slotByDictIndex.length ? slotByDictIndex[dIdx] : emptySlot;
      addInto(cells[slot][b], row.measures);
    }
  }
  const isAdditive = isAdditiveMetric(metric);
  return order.map((id, index) => ({
    id,
    folded: id === FOLDED_ID,
    values: cells[index].map((measures) => {
      const value = metricValue(measures, metric);
      return isAdditive ? (value ?? 0) : value;
    }),
    samples: cells[index].map((measures) => measures.requests),
  })).filter((group) => !group.folded || group.values.some((value) => value !== null && value !== 0));
}

/** Per-group series of an additive metric, for a ranking row's sparkline. */
export function groupSparklines(
  cube: InsightsCube,
  rows: readonly CubeRow[],
  dimension: InsightsDimension,
  metric: InsightsMetric,
): Map<string, number[]> {
  const ranking = rankingMetric(metric);
  const bucketCount = cube.bucketStarts.length;
  const dimPos = DIMENSION_POSITION[dimension];
  const dict = cube.values[dimension];
  const byDict: Array<Float64Array | undefined> = new Array(dict.length);
  let fallback: Float64Array | undefined;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const b = row.bucket;
    if (b < 0 || b >= bucketCount) continue;
    const v = metricValue(row.measures, ranking) ?? 0;
    const idx = row.dims[dimPos];
    if (idx >= 0 && idx < dict.length) {
      let series = byDict[idx];
      if (!series) {
        series = new Float64Array(bucketCount);
        byDict[idx] = series;
      }
      series[b] += v;
    } else {
      if (!fallback) fallback = new Float64Array(bucketCount);
      fallback[b] += v;
    }
  }
  const result = new Map<string, number[]>();
  const mergeSeries = (id: string, arr: Float64Array) => {
    const existing = result.get(id);
    if (existing) {
      for (let b = 0; b < bucketCount; b += 1) existing[b] += arr[b];
    } else {
      result.set(id, Array.from(arr));
    }
  };
  for (let idx = 0; idx < byDict.length; idx += 1) {
    const arr = byDict[idx];
    if (arr) mergeSeries(dict[idx] ?? '', arr);
  }
  if (fallback) mergeSeries('', fallback);
  return result;
}

/** The start of the last bucket a group was active in, or null. */
export function lastActiveBuckets(cube: InsightsCube, rows: readonly CubeRow[], dimension: InsightsDimension): Map<string, number> {
  const dimPos = DIMENSION_POSITION[dimension];
  const dict = cube.values[dimension];
  const maxBucketByDict = new Int32Array(dict.length).fill(-1);
  let fallbackBucket = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.measures.requests <= 0 || row.bucket < 0) continue;
    const idx = row.dims[dimPos];
    if (idx >= 0 && idx < dict.length) {
      if (row.bucket > maxBucketByDict[idx]) maxBucketByDict[idx] = row.bucket;
    } else if (row.bucket > fallbackBucket) {
      fallbackBucket = row.bucket;
    }
  }
  const last = new Map<string, number>();
  const recordStart = (id: string, bucketIdx: number) => {
    const start = cube.bucketStarts[bucketIdx];
    if (start !== undefined && start > (last.get(id) ?? -Infinity)) last.set(id, start);
  };
  for (let idx = 0; idx < maxBucketByDict.length; idx += 1) {
    if (maxBucketByDict[idx] >= 0) recordStart(dict[idx] ?? '', maxBucketByDict[idx]);
  }
  if (fallbackBucket >= 0) recordStart('', fallbackBucket);
  return last;
}

export interface MatrixCell {
  measures: Measures;
  value: number | null;
}

export interface InsightsMatrix {
  rowIds: string[];
  columnIds: string[];
  /** Keyed by `row\u0000column`. */
  cells: Map<string, MatrixCell>;
  rowTotals: Map<string, Measures>;
  columnTotals: Map<string, Measures>;
  /** The largest cell value, which the colour ramp is relative to. */
  max: number;
}

export function matrixCellKey(rowId: string, columnId: string): string {
  return `${rowId}\u0000${columnId}`;
}

/**
 * Two dimensions crossed. Rows and columns are the top groups of each by the ranking metric; the rest
 * is left out rather than folded, because a "remaining" row of a matrix names no one.
 */
export function buildMatrix(
  cube: InsightsCube,
  rows: readonly CubeRow[],
  rowDimension: InsightsDimension,
  columnDimension: InsightsDimension,
  metric: InsightsMetric,
  rowLimit: number,
  columnLimit: number,
): InsightsMatrix {
  const rowTotals = groupTotals(cube, rows, rowDimension);
  const columnTotals = groupTotals(cube, rows, columnDimension);
  const rowIds = rankGroups(rowTotals, metric).slice(0, rowLimit).map((group) => group.id);
  const columnIds = rankGroups(columnTotals, metric).slice(0, columnLimit).map((group) => group.id);
  const rowSlotById = new Map(rowIds.map((id, idx) => [id, idx]));
  const colSlotById = new Map(columnIds.map((id, idx) => [id, idx]));
  const rowDimPos = DIMENSION_POSITION[rowDimension];
  const colDimPos = DIMENSION_POSITION[columnDimension];
  const rowDict = cube.values[rowDimension];
  const colDict = cube.values[columnDimension];
  const rowSlotByDict = new Int32Array(rowDict.length).fill(-1);
  for (let idx = 0; idx < rowDict.length; idx += 1) {
    rowSlotByDict[idx] = rowSlotById.get(rowDict[idx] ?? '') ?? -1;
  }
  const colSlotByDict = new Int32Array(colDict.length).fill(-1);
  for (let idx = 0; idx < colDict.length; idx += 1) {
    colSlotByDict[idx] = colSlotById.get(colDict[idx] ?? '') ?? -1;
  }
  const emptyRowSlot = rowSlotById.get('') ?? -1;
  const emptyColSlot = colSlotById.get('') ?? -1;
  const colLen = columnIds.length;
  const grid: Array<Measures | undefined> = new Array(rowIds.length * colLen);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rIdx = row.dims[rowDimPos];
    const rSlot = rIdx >= 0 && rIdx < rowSlotByDict.length ? rowSlotByDict[rIdx] : emptyRowSlot;
    if (rSlot < 0) continue;
    const cIdx = row.dims[colDimPos];
    const cSlot = cIdx >= 0 && cIdx < colSlotByDict.length ? colSlotByDict[cIdx] : emptyColSlot;
    if (cSlot < 0) continue;
    const cellIdx = rSlot * colLen + cSlot;
    let measures = grid[cellIdx];
    if (!measures) {
      measures = emptyMeasures();
      grid[cellIdx] = measures;
    }
    addInto(measures, row.measures);
  }
  const cells = new Map<string, MatrixCell>();
  let max = 0;
  for (let r = 0; r < rowIds.length; r += 1) {
    for (let c = 0; c < colLen; c += 1) {
      const measures = grid[r * colLen + c];
      if (!measures) continue;
      const value = metricValue(measures, metric);
      cells.set(matrixCellKey(rowIds[r], columnIds[c]), { measures, value });
      if (value !== null && value > max) max = value;
    }
  }
  return { rowIds, columnIds, cells, rowTotals, columnTotals, max };
}

export interface FlowNode {
  /** `${level}:${value}`, or `${level}:` + FOLDED_ID for a level's remainder. */
  id: string;
  level: number;
  dimension: InsightsDimension;
  value: string;
  folded: boolean;
}

export interface FlowLink {
  source: string;
  target: string;
  value: number;
}

/**
 * Where traffic goes: a chain of dimensions (key → call point → provider, say), each level kept to its
 * top groups with the rest folded, and the links between adjacent levels weighted by an additive
 * metric.
 */
export function buildFlow(
  cube: InsightsCube,
  rows: readonly CubeRow[],
  levels: readonly InsightsDimension[],
  metric: InsightsMetric,
  limitPerLevel: number,
): { nodes: FlowNode[]; links: FlowLink[] } {
  const levelCount = levels.length;
  if (levelCount < 2) return { nodes: [], links: [] };
  const weight = rankingMetric(metric);
  const levelNodeIds: string[][] = [];
  const levelDimPos = new Int32Array(levelCount);
  const levelSlotsByDict: Int32Array[] = [];
  const levelEmptySlot = new Int32Array(levelCount);
  for (let level = 0; level < levelCount; level += 1) {
    const dimension = levels[level];
    levelDimPos[level] = DIMENSION_POSITION[dimension];
    const topValues = rankGroups(groupTotals(cube, rows, dimension), weight)
      .slice(0, limitPerLevel)
      .map((group) => group.id);
    const nodeIds = [...topValues.map((value) => `${level}:${value}`), `${level}:${FOLDED_ID}`];
    const foldedSlot = nodeIds.length - 1;
    const slotByValue = new Map(topValues.map((value, idx) => [value, idx]));
    const dict = cube.values[dimension];
    const slots = new Int32Array(dict.length);
    for (let idx = 0; idx < dict.length; idx += 1) {
      slots[idx] = slotByValue.get(dict[idx] ?? '') ?? foldedSlot;
    }
    levelNodeIds.push(nodeIds);
    levelSlotsByDict.push(slots);
    levelEmptySlot[level] = slotByValue.get('') ?? foldedSlot;
  }

  const seenNodeMasks = levelNodeIds.map((ids) => new Uint8Array(ids.length));
  const linkGrids = levelNodeIds.slice(0, -1).map((ids, level) => new Float64Array(ids.length * levelNodeIds[level + 1].length));
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const amount = metricValue(row.measures, weight) ?? 0;
    if (amount <= 0) continue;
    const d0 = row.dims[levelDimPos[0]];
    const s0Map = levelSlotsByDict[0];
    let prevSlot = d0 >= 0 && d0 < s0Map.length ? s0Map[d0] : levelEmptySlot[0];
    seenNodeMasks[0][prevSlot] = 1;
    for (let level = 0; level < levelCount - 1; level += 1) {
      const nextPos = levelDimPos[level + 1];
      const nextDictIdx = row.dims[nextPos];
      const nextSlots = levelSlotsByDict[level + 1];
      const nextSlot = nextDictIdx >= 0 && nextDictIdx < nextSlots.length ? nextSlots[nextDictIdx] : levelEmptySlot[level + 1];
      seenNodeMasks[level + 1][nextSlot] = 1;
      linkGrids[level][prevSlot * levelNodeIds[level + 1].length + nextSlot] += amount;
      prevSlot = nextSlot;
    }
  }

  const nodes: FlowNode[] = [];
  for (let level = 0; level < levelCount; level += 1) {
    const ids = levelNodeIds[level];
    const mask = seenNodeMasks[level];
    const levelNodes: FlowNode[] = [];
    for (let slot = 0; slot < ids.length; slot += 1) {
      if (mask[slot] === 0) continue;
      const id = ids[slot];
      const separator = id.indexOf(':');
      const value = id.slice(separator + 1);
      levelNodes.push({ id, level, dimension: levels[level], value, folded: value === FOLDED_ID });
    }
    levelNodes.sort((left, right) => left.id.localeCompare(right.id));
    nodes.push(...levelNodes);
  }

  const links: FlowLink[] = [];
  for (let level = 0; level < levelCount - 1; level += 1) {
    const srcIds = levelNodeIds[level];
    const dstIds = levelNodeIds[level + 1];
    const grid = linkGrids[level];
    for (let s = 0; s < srcIds.length; s += 1) {
      for (let t = 0; t < dstIds.length; t += 1) {
        const value = grid[s * dstIds.length + t];
        if (value > 0) links.push({ source: srcIds[s], target: dstIds[t], value });
      }
    }
  }
  return { nodes, links };
}

/** The distinct values a dimension takes in some rows, with their request counts, busiest first. */
export function facetValues(cube: InsightsCube, rows: readonly CubeRow[], dimension: InsightsDimension): Array<{ id: string; requests: number }> {
  return [...groupTotals(cube, rows, dimension).entries()]
    .map(([id, measures]) => ({ id, requests: measures.requests }))
    .sort((left, right) => right.requests - left.requests || (left.id < right.id ? -1 : 1));
}
