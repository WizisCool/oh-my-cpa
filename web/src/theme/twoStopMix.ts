/**
 * The arithmetic every two-stop ramp in the console shares.
 *
 * A continuous reading - the cache-rate badge and the request duration - is not a
 * list of bands but a position between two design tokens. This module answers only
 * "which two stops, and how much of the first one?": the mixing itself is CSS
 * `color-mix(in oklch, ...)`, so the stops stay tokens instead of hex values baked
 * into a component, and the hue sweep is perceptually even.
 *
 * OKLCH also keeps a ramp legible: a mix of two text-safe stops is not automatically
 * text-safe, so a ramp that promises legibility anywhere between its ends has to solve its
 * stops against the sweep they produce rather than against themselves (`palette.ts`).
 * Only the duration ramp makes that promise - the cache-rate ramp holds its two stops on
 * their own and says nothing about the blends between them.
 *
 * Leaf on purpose: it imports nothing, so the test harness can load it on its own.
 */

export interface TwoStopMix {
  /** Low end of the ramp, as a CSS value. */
  from: string;
  /** High end of the ramp, as a CSS value. */
  to: string;
  /** Weight of `from`, e.g. `"62.5%"`; `to` receives the remainder. */
  fromShare: string;
}

/**
 * twoStopMix maps a 0–1 position onto the two stops.
 *
 * The position is deliberately not rounded to a step: quantising it would collapse
 * the ramp back into the bands it exists to replace. `NaN` sits at the low end,
 * which is the safe end for both callers - no cache hit, and no recorded duration;
 * an infinity is still an extreme reading and clamps to the end of its own ramp.
 */
export function twoStopMix(from: string, to: string, position: number): TwoStopMix {
  const clamped = Number.isNaN(position) ? 0 : Math.min(1, Math.max(0, position));
  return { from, to, fromShare: share(1 - clamped) };
}

/** Round the weight to 0.01% so the custom property stays short; 10,000 steps is
 *  far finer than the eye or an 11px reading can resolve. */
function share(weight: number): string {
  return `${Number((weight * 100).toFixed(2))}%`;
}
