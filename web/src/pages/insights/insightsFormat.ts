/**
 * How the Insights page writes a metric. One place, so a tile, a ranking row, a matrix cell and a
 * tooltip print the same value the same way.
 */

import { formatTokens, formatTokensFull, type TokenNumberStyle } from '../../types/tokenDisplay';
import type { InsightsMetric } from './insightsCube';

const COUNT = new Intl.NumberFormat('en');

/** Money at two decimals; a fraction of a cent keeps four, so a small spend never reads as $0.00. */
export function formatSpend(usd: number): string {
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** A metric's readout; null is written as a dash, never as zero. */
export function formatMetric(metric: InsightsMetric, value: number | null, style: TokenNumberStyle): string {
  if (value === null || !Number.isFinite(value)) return '—';
  switch (metric) {
    case 'cost':
      return formatSpend(value);
    case 'tokens':
      return formatTokens(value, style);
    case 'requests':
      return COUNT.format(value);
    case 'latency':
      return formatLatency(value);
  }
}

/** The exact form behind a rounded readout, for its title. */
export function formatMetricExact(metric: InsightsMetric, value: number | null): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  if (metric === 'tokens') return formatTokensFull(value);
  if (metric === 'cost') return `$${value.toFixed(6)}`;
  if (metric === 'requests') return COUNT.format(value);
  return undefined;
}

/** A relative change as a signed percentage, or null when there is none to state. */
export function formatChange(change: number | null): string | null {
  if (change === null || !Number.isFinite(change)) return null;
  const percent = change * 100;
  if (Math.abs(percent) < 0.05) return '0%';
  const digits = Math.abs(percent) >= 100 ? 0 : 1;
  return `${percent > 0 ? '+' : '−'}${Math.abs(percent).toFixed(digits)}%`;
}

/**
 * Which way a change went, for its colour: a rise in a muted red, a fall in a muted green. The
 * tones are mixed toward the ink so a change reads as a direction, not as an alarm; a change too
 * small to print has none.
 */
export function changeTrend(change: number | null): 'up' | 'down' | undefined {
  if (change === null || !Number.isFinite(change) || Math.abs(change) < 0.0005) return undefined;
  return change > 0 ? 'up' : 'down';
}

export function formatShare(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return '—';
  const percent = share * 100;
  return percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`;
}
