/**
 * The usage rhythm, summarised: the day's shape by hour and its busiest stretch. Pure, so which
 * hours the panel marks as the peak is the logic suite's claim and not a rendering detail.
 */

import type { InsightsRhythmCell, InsightsWindow } from '../../types/insights';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a window can show a weekday pattern: only one holding every weekday. A shorter window would
 * fill one or two rows of the grid and present the rest as idle days it never read.
 */
export function canShowWeekView(window: Pick<InsightsWindow, 'from' | 'to'>): boolean {
  return window.to - window.from + 1 >= WEEK_MS;
}

/** The span the summary names as the busiest: long enough to be a habit, short enough to act on. */
export const PEAK_SPAN_HOURS = 3;

export interface RhythmSummary {
  /** Per local hour, 0 first, summed over every weekday. */
  hours: number[];
  total: number;
  /** The first hour of the busiest PEAK_SPAN_HOURS-hour stretch; it may wrap past midnight. */
  peakStart: number;
  peakShare: number;
}

export function summarizeRhythm(cells: readonly InsightsRhythmCell[], valueOf: (cell: InsightsRhythmCell) => number): RhythmSummary {
  const hours = Array.from({ length: 24 }, () => 0);
  let total = 0;
  for (const cell of cells) {
    const value = valueOf(cell);
    if (!(value > 0)) continue;
    hours[cell.hour] += value;
    total += value;
  }
  let peakStart = 0;
  let peak = -1;
  for (let start = 0; start < 24; start += 1) {
    let sum = 0;
    for (let offset = 0; offset < PEAK_SPAN_HOURS; offset += 1) sum += hours[(start + offset) % 24];
    if (sum > peak) {
      peak = sum;
      peakStart = start;
    }
  }
  return {
    hours,
    total,
    peakStart,
    peakShare: total > 0 ? peak / total : 0,
  };
}

/** The hours of the busiest stretch, for drawing it. */
export function peakHourSet(summary: RhythmSummary): Set<number> {
  if (summary.total <= 0) return new Set();
  return new Set(Array.from({ length: PEAK_SPAN_HOURS }, (_, offset) => (summary.peakStart + offset) % 24));
}
