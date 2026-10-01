/**
 * The stored scroll-smoothing choice, kept apart from the engine in `scrollSmoothing.ts`.
 *
 * The settings row and the console shell read this on every load, while the engine only has to be
 * running before the reader's first notch; keeping the words here lets the engine load as its own
 * chunk instead of riding in the main entry.
 */

/** Whether wheel and keyboard scrolls glide: always, unless the system asks for reduced motion, or never. */
export type ScrollSmoothingPreference = 'on' | 'system' | 'off';

export const SCROLL_SMOOTHING_PREFERENCES: readonly ScrollSmoothingPreference[] = ['on', 'system', 'off'];

export const SCROLL_SMOOTHING_PREFERENCE_KEY = 'omc_scroll_smoothing';

/**
 * On by default, including for a reader whose system reports reduced motion. See ADR 0046: on
 * Windows that report is the "Animation effects" switch, which most readers turn off to make the
 * desktop feel faster, and it is also what disables the browser's own wheel animation. A glide that
 * follows the reader's own wheel is input, not decoration - macOS and iOS keep inertial scrolling
 * under Reduce Motion for the same reason - and `system` is one click away for a reader who wants
 * the operating system's switch to decide.
 */
export const DEFAULT_SCROLL_SMOOTHING: ScrollSmoothingPreference = 'on';

export function parseScrollSmoothing(raw: unknown): ScrollSmoothingPreference | undefined {
  return SCROLL_SMOOTHING_PREFERENCES.includes(raw as ScrollSmoothingPreference)
    ? (raw as ScrollSmoothingPreference)
    : undefined;
}

export function isScrollSmoothingActive(preference: ScrollSmoothingPreference, prefersReducedMotion: boolean): boolean {
  if (preference === 'off') return false;
  if (preference === 'system') return !prefersReducedMotion;
  return true;
}
