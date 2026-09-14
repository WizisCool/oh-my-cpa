/**
 * The token heatmap's continuous colour ramp.
 *
 * A continuous scale rather than the four discrete steps the panel used to have. The steps answered
 * "busy / quiet" and nothing finer, so every day between two of them was painted identically - which
 * is exactly the information the panel exists to show. The cache-rate badge is the app's other
 * continuous reading (see docs/design.md §2), and this follows the same shape: a pure helper that
 * answers "which two stops, and how much of the first", with the mixing left to CSS.
 *
 * The interpolation is done by CSS `color-mix(in oklch, ...)` so the stops stay design tokens rather
 * than hex values baked into a component, and so the hue sweep is perceptually even.
 */

/** A cell's position on the ramp, as a percentage of the way from the quiet end to the busy end. */
const MAX_PERCENT = 100;

export interface HeatmapRampMix {
  /** A CSS value for the quieting colour, mixed toward the cell's own empty fill. */
  from: string;
  /** A CSS value for the measured colour. */
  to: string;
  /** Weight of `from`, e.g. `"62.5%"`; `to` receives the remainder. */
  fromShare: string;
}

/**
 * Maps a day's token volume onto a position on the ramp.
 *
 * The mapping is the **square root** of the value, not the value itself. Token volume spans several
 * orders of magnitude in one window - a quiet day is thousands and a busy one is hundreds of
 * millions - so a linear ramp puts almost every day within a percent or two of the quiet end and
 * collapses the whole middle of the range into one invisible shade. The square root lifts the low
 * end enough for day-to-day differences to be visible while still letting the busiest day read as
 * the busiest; a logarithm was the other candidate and over-amplifies the bottom, making a day with
 * almost no traffic look mid-scale.
 *
 * `max` is the window's own busiest day, so the ramp is relative to what this deployment actually
 * does: a self-hosted console sees anywhere from a thousand tokens a day to a hundred million, and a
 * fixed ladder would paint every cell of a busy install at the top of the ramp and every cell of a
 * quiet one at the bottom.
 */
export function heatmapRampPosition(tokens: number, max: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(max) || tokens <= 0 || max <= 0) return 0;
  const normalised = Math.sqrt(Math.min(tokens, max) / max);
  // `Math.min` keeps a value above the maximum at the top rather than past it, and the clamp guards
  // the rounding that `Math.sqrt` can leave just above 1.
  return Math.min(1, Math.max(0, normalised));
}

/**
 * heatmapRampMix returns the two stops and their weights for one cell.
 *
 * A day with no traffic sits fully at the quiet stop, which *is* the empty fill: the ramp's floor is
 * the cell's own background, so "no traffic" and "the lightest measured shade" cannot be confused by
 * a cell that is one step off zero. That is why the caller supplies the empty fill rather than this
 * module naming a colour.
 */
export function heatmapRampMix(tokens: number, max: number): HeatmapRampMix {
  const position = heatmapRampPosition(tokens, max);
  const weight = Math.round((1 - position) * MAX_PERCENT * 100) / 100;
  return {
    from: 'var(--heatmap-quiet)',
    to: 'var(--heatmap-busy)',
    fromShare: `${weight}%`,
  };
}

/**
 * The busiest day in the window, which the ramp is scaled against.
 *
 * Zero when nothing in the window carried traffic, which lets a caller skip the ramp entirely
 * instead of dividing by a maximum that does not exist.
 */
export function heatmapRampMax(values: readonly number[]): number {
  let max = 0;
  for (const value of values) {
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}
