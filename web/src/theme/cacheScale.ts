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

import type { RollingReadout } from '../types/rollingNumber';

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
 * cacheRateTenths reduces a rate to the tenth of a percent the console prints.
 *
 * One rounding authority for the badge, the tile and the colour scale: they have to
 * agree about `40%` and `40.0%`, or the same rate reads differently in two places.
 *
 * A missing rate is not a zero rate - the dashboard shows a dash when the window
 * carried no prompt tokens at all - so `null` returns undefined while a non-finite
 * number, which is a broken reading rather than an absent one, still prints as zero.
 */
export function cacheRateTenths(rate: number | null | undefined): number | undefined {
  if (rate === null || rate === undefined) return undefined;
  if (!Number.isFinite(rate)) return 0;
  return Math.round(Math.min(MAX_CACHE_RATE, Math.max(0, rate)) * 10);
}

/**
 * formatCacheRate renders a rate for the operator: one decimal, capped at
 * MAX_CACHE_RATE. A rate that rounds to zero reads as `0%` rather than `0.0%`,
 * so the column never mixes two spellings of "nothing was cached".
 */
export function formatCacheRate(rate: number | null | undefined): string {
  const tenths = cacheRateTenths(rate);
  if (tenths === undefined) return '—';
  return tenths === 0 ? '0%' : `${(tenths / 10).toFixed(1)}%`;
}

/**
 * resolveCacheRateReadout is `formatCacheRate` as an animated readout.
 *
 * The percent sign is the suffix, and the fraction digits follow the same rule the
 * printed form uses: exactly zero keeps no decimal, every other reading keeps its
 * tenth. `minimumFractionDigits` cannot say "except at zero", so the rule is
 * evaluated here rather than handed to the formatter.
 */
export function resolveCacheRateReadout(rate: number | null | undefined): RollingReadout | undefined {
  const tenths = cacheRateTenths(rate);
  if (tenths === undefined) return undefined;
  return {
    number: tenths / 10,
    suffix: '%',
    format: { minimumFractionDigits: tenths === 0 ? 0 : 1, maximumFractionDigits: 1 },
  };
}
