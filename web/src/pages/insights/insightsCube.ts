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
 * Pure: no React, no DOM. `scripts/test-insights-cube.ts` holds its claims.
 */

import type { InsightsCompareWindow, InsightsCubeResponse, InsightsKey, InsightsWindow } from '../../types/insights';

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

const MEASURE_COLUMNS: ReadonlyArray<[keyof Measures, string]> = [
  ['requests', 'requests'], ['failures', 'failures'], ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'], ['reasoningTokens', 'reasoning_tokens'],
  ['totalTokens', 'total_tokens'], ['latencySumMs', 'latency_sum_ms'], ['ttftSumMs', 'ttft_sum_ms'],
  ['ttftCount', 'ttft_count'], ['costNanos', 'cost_nanos'], ['pricedRequests', 'priced_requests'],
  ['costedRequests', 'costed_requests'],
];

export function emptyMeasures(): Measures {
  return {
    requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    totalTokens: 0, latencySumMs: 0, ttftSumMs: 0, ttftCount: 0,
    costNanos: 0, pricedRequests: 0, costedRequests: 0,
  };
}

function addInto(target: Measures, source: Measures): void {
  for (const [name] of MEASURE_COLUMNS) target[name] += source[name];
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
  const dimensionColumns = INSIGHTS_DIMENSIONS.map(require);
  const measureColumns = MEASURE_COLUMNS.map(([name, column]) => [name, require(column)] as const);
  const bucketColumn = require('bucket');
  const decode = (cells: readonly number[], offset: number, bucket: number): CubeRow => {
    const measures = emptyMeasures();
    for (const [name, column] of measureColumns) measures[name] = cells[column - offset] ?? 0;
    return { bucket, dims: dimensionColumns.map((column) => cells[column - offset] ?? 0), measures };
  };
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
  const active = INSIGHTS_DIMENSIONS.flatMap((dimension) => {
    const selected = filters[dimension];
    if (exempt.includes(dimension) || !selected || selected.length === 0) return [];
    const wanted = new Set(selected);
    const admitted = new Set<number>();
    cube.values[dimension].forEach((value, index) => { if (wanted.has(value)) admitted.add(index); });
    return [[DIMENSION_POSITION[dimension], admitted] as const];
  });
  if (active.length === 0) return rows.slice();
  return rows.filter((row) => active.every(([position, admitted]) => admitted.has(row.dims[position])));
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
  if (before === null || before <= 0) return now > 0 ? { kind: 'new' } : NO_COMPARISON;
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
  const groups = new Map<string, Measures>();
  for (const row of rows) {
    const id = rowValue(cube, row, dimension);
    let measures = groups.get(id);
    if (!measures) {
      measures = emptyMeasures();
      groups.set(id, measures);
    }
    addInto(measures, row.measures);
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
  const position = new Map(order.map((id, index) => [id, index]));
  const cells: Measures[][] = order.map(() => Array.from({ length: bucketCount }, emptyMeasures));
  for (const row of rows) {
    if (row.bucket < 0 || row.bucket >= bucketCount) continue;
    const id = dimension === null ? 'all' : rowValue(cube, row, dimension);
    const index = position.get(id) ?? position.get(FOLDED_ID)!;
    addInto(cells[index][row.bucket], row.measures);
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
  const measuresByGroup = new Map<string, Measures[]>();
  for (const row of rows) {
    if (row.bucket < 0 || row.bucket >= bucketCount) continue;
    const id = rowValue(cube, row, dimension);
    let series = measuresByGroup.get(id);
    if (!series) {
      series = Array.from({ length: bucketCount }, emptyMeasures);
      measuresByGroup.set(id, series);
    }
    addInto(series[row.bucket], row.measures);
  }
  const result = new Map<string, number[]>();
  for (const [id, series] of measuresByGroup) result.set(id, series.map((measures) => metricValue(measures, ranking) ?? 0));
  return result;
}

/** The start of the last bucket a group was active in, or null. */
export function lastActiveBuckets(cube: InsightsCube, rows: readonly CubeRow[], dimension: InsightsDimension): Map<string, number> {
  const last = new Map<string, number>();
  for (const row of rows) {
    if (row.measures.requests <= 0 || row.bucket < 0) continue;
    const id = rowValue(cube, row, dimension);
    const start = cube.bucketStarts[row.bucket];
    if (start !== undefined && start > (last.get(id) ?? -Infinity)) last.set(id, start);
  }
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
  const wantedRows = new Set(rowIds);
  const wantedColumns = new Set(columnIds);
  const cellMeasures = new Map<string, Measures>();
  for (const row of rows) {
    const rowId = rowValue(cube, row, rowDimension);
    const columnId = rowValue(cube, row, columnDimension);
    if (!wantedRows.has(rowId) || !wantedColumns.has(columnId)) continue;
    const key = matrixCellKey(rowId, columnId);
    let measures = cellMeasures.get(key);
    if (!measures) {
      measures = emptyMeasures();
      cellMeasures.set(key, measures);
    }
    addInto(measures, row.measures);
  }
  const cells = new Map<string, MatrixCell>();
  let max = 0;
  for (const [key, measures] of cellMeasures) {
    const value = metricValue(measures, metric);
    cells.set(key, { measures, value });
    if (value !== null && value > max) max = value;
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
  const weight = rankingMetric(metric);
  const tops = levels.map((dimension) =>
    new Set(rankGroups(groupTotals(cube, rows, dimension), weight).slice(0, limitPerLevel).map((group) => group.id)));
  const nodeOf = (level: number, row: CubeRow) => {
    const value = rowValue(cube, row, levels[level]);
    return tops[level].has(value) ? `${level}:${value}` : `${level}:${FOLDED_ID}`;
  };
  const linkWeights = new Map<string, number>();
  const seenNodes = new Set<string>();
  for (const row of rows) {
    const amount = metricValue(row.measures, weight) ?? 0;
    if (amount <= 0) continue;
    for (let level = 0; level < levels.length - 1; level += 1) {
      const source = nodeOf(level, row);
      const target = nodeOf(level + 1, row);
      seenNodes.add(source);
      seenNodes.add(target);
      const key = `${source}\u0001${target}`;
      linkWeights.set(key, (linkWeights.get(key) ?? 0) + amount);
    }
  }
  const nodes = [...seenNodes].map((id) => {
    const separator = id.indexOf(':');
    const level = Number(id.slice(0, separator));
    const value = id.slice(separator + 1);
    return { id, level, dimension: levels[level], value, folded: value === FOLDED_ID };
  }).sort((left, right) => left.level - right.level || left.id.localeCompare(right.id));
  const links = [...linkWeights.entries()].map(([key, value]) => {
    const [source, target] = key.split('\u0001');
    return { source, target, value };
  });
  return { nodes, links };
}

/** The distinct values a dimension takes in some rows, with their request counts, busiest first. */
export function facetValues(cube: InsightsCube, rows: readonly CubeRow[], dimension: InsightsDimension): Array<{ id: string; requests: number }> {
  return [...groupTotals(cube, rows, dimension).entries()]
    .map(([id, measures]) => ({ id, requests: measures.requests }))
    .sort((left, right) => right.requests - left.requests || (left.id < right.id ? -1 : 1));
}
