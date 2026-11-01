/**
 * Request duration on one continuous scale: green at an instant, orange from a minute on.
 *
 * The scale used to be three bands, which meant every reading inside a band was painted
 * identically and a 14-second request looked exactly like an instant. Duration is a
 * measurement, not a verdict, so a continuous ramp says what the bands could not: how far
 * along the wait the reading actually is. The cache-rate badge already reads this way, and
 * this is the same helper with different stops (`twoStopMix.ts`).
 *
 * Red is deliberately absent. Failure keeps the danger hue; a slow request is slow, not
 * broken.
 */

import { twoStopMix, type TwoStopMix } from './twoStopMix';

/**
 * The reading at which the ramp reaches its orange end.
 *
 * Presentation policy, not arithmetic: a minute is the point where a request has stopped
 * feeling like a wait and started feeling like a problem, and past it the reading has
 * nothing left to say - so it stays at the end of the ramp rather than saturating further.
 */
export const DURATION_SCALE_MAX_MS = 60_000;

const TIMING_GREEN = 'var(--timing-green)';
const TIMING_ORANGE = 'var(--timing-orange)';

/**
 * Where a duration sits on the scale, or `null` when there is no reading at all.
 *
 * A missing duration is not a fast one: `null` keeps the plain ink the console gives every
 * unavailable reading, while a measured 0 ms is the fastest request there is and takes the
 * green end.
 */
export function durationScalePosition(ms: number | null | undefined): number | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  return Math.min(1, ms / DURATION_SCALE_MAX_MS);
}

/** The two stops and their weights for one reading; `null` when the record carried no duration. */
export function durationScaleMix(ms: number | null | undefined): TwoStopMix | null {
  const position = durationScalePosition(ms);
  return position === null ? null : twoStopMix(TIMING_GREEN, TIMING_ORANGE, position);
}
