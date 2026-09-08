/**
 * Cache-rate colour scale: yellow at 0% → green at 100%.
 *
 * Red was deliberately dropped: a low cache rate is not a failure, and the
 * danger hue belongs to failed requests. The ramp now runs between two adjacent
 * hues, so it reads as one quality going from "barely cached" to "well cached".
 *
 * The interpolation is done by CSS `color-mix(in oklch, …)`: OKLCH keeps the
 * hue sweep perceptually even, and letting the browser mix means the stops stay
 * design tokens instead of hex values baked into a component. This module
 * answers only "which two stops, and how much of the first one?" — the caller
 * passes the strings through as CSS custom properties.
 *
 * See docs/design.md §2 for the stop values and the 4.5:1 contrast rule.
 */

export interface CacheScaleMix {
  /** Low end of the scale (a near-zero hit rate), as a CSS value. */
  from: string;
  /** High end of the scale (a near-total hit rate), as a CSS value. */
  to: string;
  /** Weight of `from`, e.g. `"62.5%"`; `to` receives the remainder. */
  fromShare: string;
}

/**
 * The highest rate the badge will ever read.
 *
 * This is presentation policy, not arithmetic: the app never claims a perfect
 * hit rate, so the badge stops at 99.9% and the Go dashboard aggregate caps at
 * the same value so the two readings agree. See docs/design.md §2.
 */
export const MAX_CACHE_RATE = 99.9;

const YELLOW = 'var(--cache-rate-yellow)';
const GREEN = 'var(--cache-rate-green)';

/**
 * cacheScaleMix maps a 0–100 rate onto the two stops.
 *
 * The rate is deliberately not rounded to an integer: `Math.round` would
 * quantise the whole badge to 101 colours. Non-finite input is treated as 0,
 * which is the yellow end of the scale.
 */
export function cacheScaleMix(rate: number): CacheScaleMix {
  const clamped = Number.isNaN(rate) ? 0 : Math.min(100, Math.max(0, rate));
  return { from: YELLOW, to: GREEN, fromShare: share(1 - clamped / 100) };
}

/** Round the weight to 0.01% so the custom property stays short; 10,000 steps
 *  is far finer than the eye or an 11px badge can resolve. */
function share(weight: number): string {
  return `${Number((weight * 100).toFixed(2))}%`;
}

/**
 * formatCacheRate renders a rate for the operator: one decimal, capped at
 * MAX_CACHE_RATE. A rate that rounds to zero reads as `0%` rather than `0.0%`,
 * so the column never mixes two spellings of "nothing was cached".
 */
export function formatCacheRate(rate: number | null | undefined): string {
  // A missing rate is not a zero rate: the dashboard shows a dash when the
  // window carried no prompt tokens at all.
  if (rate === null || rate === undefined) return '—';
  if (!Number.isFinite(rate)) return '0%';
  const tenths = Math.round(Math.min(MAX_CACHE_RATE, Math.max(0, rate)) * 10);
  return tenths === 0 ? '0%' : `${(tenths / 10).toFixed(1)}%`;
}
