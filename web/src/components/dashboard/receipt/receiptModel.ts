/**
 * What a usage receipt says, before it is worded or drawn.
 *
 * The receipt itemises the dashboard's window by client key and, under each key, by upstream
 * model. The itemisation is read from the Insights cube, the console's one read that partitions a
 * window by both, so a key's line and its models always add up the way the cube does. The headline
 * figures stay the dashboard's own, so the receipt's total is the number on the cost tile.
 */
import {
  compareMetric,
  emptyMeasures,
  rowValue,
  sumMeasures,
  type CubeRow,
  type InsightsCube,
  type Measures,
  type MetricComparison,
} from '../../../types/insightsCube';
import { isSlidingRange, type DashboardRange, type DashboardWindow } from '../../../types/dashboard';
import { INSIGHTS_PRESETS } from '../../../types/insights';

/** Keys listed by name; the rest fold into one line so a long tail does not make a scroll. */
export const RECEIPT_KEY_LIMIT = 8;
/** Models listed under a key; the rest fold into one line under it. */
export const RECEIPT_MODEL_LIMIT = 4;

export interface ReceiptAmount {
  requests: number;
  costNanos: number;
  /** Requests that carried a price; zero means the amount is unknown rather than free. */
  costedRequests: number;
}

export interface ReceiptModelLine extends ReceiptAmount {
  model: string;
}

export interface ReceiptKeyLine extends ReceiptAmount {
  key: string;
  models: ReceiptModelLine[];
  /** Models of this key folded into one line, with their combined amount. */
  otherModels: (ReceiptAmount & { count: number }) | null;
}

export interface ReceiptLedger {
  keys: ReceiptKeyLine[];
  otherKeys: (ReceiptAmount & { count: number }) | null;
  current: Measures;
  previous: Measures;
  /** Spend against the period before; none for a window with no previous period. */
  costChange: MetricComparison;
}

function amountOf(measures: Measures): ReceiptAmount {
  return { requests: measures.requests, costNanos: measures.costNanos, costedRequests: measures.costedRequests };
}

function addAmount(target: ReceiptAmount, source: ReceiptAmount): void {
  target.requests += source.requests;
  target.costNanos += source.costNanos;
  target.costedRequests += source.costedRequests;
}

/** Spend first, then volume: a receipt is read for what cost the most. */
function byAmount(left: ReceiptAmount, right: ReceiptAmount): number {
  return right.costNanos - left.costNanos || right.requests - left.requests;
}

function groupBy(cube: InsightsCube, rows: readonly CubeRow[], dimension: 'key' | 'model'): Map<string, CubeRow[]> {
  const groups = new Map<string, CubeRow[]>();
  for (const row of rows) {
    const id = rowValue(cube, row, dimension);
    const list = groups.get(id);
    if (list) list.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

function fold<T extends ReceiptAmount>(lines: readonly T[]): (ReceiptAmount & { count: number }) | null {
  if (lines.length === 0) return null;
  const total: ReceiptAmount & { count: number } = { requests: 0, costNanos: 0, costedRequests: 0, count: lines.length };
  for (const line of lines) addAmount(total, line);
  return total;
}

/**
 * Itemises a window: each key with its models, ranked by spend, the tail of either folded.
 * `keyFilter` narrows the receipt to the key the dashboard is filtered by.
 */
export function buildReceiptLedger(
  cube: InsightsCube,
  keyFilter?: string,
  limits: { keys: number; models: number } = { keys: RECEIPT_KEY_LIMIT, models: RECEIPT_MODEL_LIMIT },
): ReceiptLedger {
  const matches = (row: CubeRow) => !keyFilter || rowValue(cube, row, 'key') === keyFilter;
  const rows = cube.rows.filter(matches);
  const previousRows = cube.previous.filter(matches);

  const keys: ReceiptKeyLine[] = [];
  for (const [key, keyRows] of groupBy(cube, rows, 'key')) {
    const models: ReceiptModelLine[] = [];
    for (const [model, modelRows] of groupBy(cube, keyRows, 'model')) {
      models.push({ model, ...amountOf(sumMeasures(modelRows)) });
    }
    models.sort(byAmount);
    keys.push({
      key,
      ...amountOf(sumMeasures(keyRows)),
      models: models.slice(0, limits.models),
      otherModels: fold(models.slice(limits.models)),
    });
  }
  keys.sort(byAmount);

  const current = sumMeasures(rows);
  const previous = previousRows.length > 0 ? sumMeasures(previousRows) : emptyMeasures();
  return {
    keys: keys.slice(0, limits.keys),
    otherKeys: fold(keys.slice(limits.keys)),
    current,
    previous,
    costChange: cube.compare ? compareMetric(current, previous, 'cost') : { kind: 'none' },
  };
}

/**
 * The cube read that covers the dashboard's window. A preset both pages know is asked for by name,
 * so a calendar unit keeps its same-stretch comparison; any other window is asked for by the bounds
 * the dashboard resolved, open-ended while it still follows the clock.
 */
export function receiptCubeParams(range: DashboardRange, window: DashboardWindow): string {
  const params = new URLSearchParams();
  if (range.preset && (INSIGHTS_PRESETS as readonly string[]).includes(range.preset)) {
    params.set('preset', range.preset);
  } else {
    params.set('from', String(window.from));
    if (!isSlidingRange(range)) params.set('to', String(window.to));
  }
  return params.toString();
}

/** Whether the window has ended, so the receipt is final rather than a running total. */
export function isReceiptFinal(range: DashboardRange): boolean {
  return !isSlidingRange(range);
}
