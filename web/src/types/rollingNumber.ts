/**
 * The animated form of a number the console already knows how to print.
 *
 * A printed string carries everything a reader needs and nothing an animation does:
 * a rolling readout has to know which number to move, which unit word sits beside
 * it, and which Intl shape it rounds in. Each readout is therefore derived from the
 * formatter that owns it - `resolveCountFlowReadout`, `resolveTokenFlowReadout`,
 * `resolveTokenRateFlowReadout` and `resolveCacheRateReadout` - and the ones backed
 * by an `Intl.NumberFormat` read the split back out of that formatter's own parts,
 * so the animated digits *are* the printed digits rather than a second rounding
 * rule that can drift from the first.
 *
 * `suffix` is the unit word (`B`, `万`, `%`). It doubles as the change detector: a
 * value sliding from one unit into the next is a change of scale, not of magnitude,
 * and rolling 1.2 into 9000 while the unit word swaps under it would show digits
 * that never described the window. `RollingNumber` watches it and prints that one
 * frame in place.
 */
export interface RollingReadout {
  /** The number to animate, already scaled into the unit it prints in. */
  number: number;
  /** A leading mark that never moves, such as the currency sign. */
  prefix?: string;
  /** The unit word printed beside the number; empty when the style prints bare digits. */
  suffix: string;
  /** The Intl shape the number prints in, so a sweep always lands on the printed rounding. */
  format: RollingFormat;
}

/**
 * The Intl options an animated readout may carry.
 *
 * Narrower than `Intl.NumberFormatOptions` on purpose: the animation runtime cannot
 * express scientific or engineering notation, and a readout is a promise that the
 * number will be painted - so the type refuses a shape that could only ever arrive
 * as a static string at runtime.
 */
export type RollingFormat = Intl.NumberFormatOptions & { notation?: 'standard' | 'compact' };
