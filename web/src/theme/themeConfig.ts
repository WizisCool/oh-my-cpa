import { THREAD_FILL_SHARES, type ThemePalette } from './palette';

/**
 * Motion tokens and CSS custom-property projection for the active palette.
 *
 * This module computes nothing about colour. A palette is resolved once in `palette.ts`, and this
 * projects its tokens onto the document's custom properties — the same way the chart runtime, the
 * Monaco editor and the brand artwork read the resolved palette.
 */

/**
 * A named motion token, in the shape both consumers read it: WAAPI takes an `EffectTiming` (which is
 * this with every field optional) and the chart library takes `duration?: number` with an easing
 * string, so naming the two fields is what lets one token serve both without a cast.
 */
export interface MotionToken {
  readonly duration: number;
  readonly easing: string;
}

/** The fast acknowledgement shared by controls and chart emphasis. */
export const MOTION_FAST: MotionToken = { duration: 120, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * The `roll` token: the dashboard's KPI readouts sweeping to a new value, and the
 * chart marks behind them morphing between two revisions.
 *
 * Readout sweeps run on refresh so live KPI changes remain legible. The shared token keeps the
 * number and chart revisions in step: a digit move at `base` is indistinguishable from a redraw,
 * which is the state 240ms exists to leave.
 */
export const MOTION_ROLL: MotionToken = { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * Glyph presence within a readout - a digit entering or leaving the number - on the `base` token.
 *
 * A presence fade is not the readout's motion but the acknowledgement that its digit count changed,
 * and holding it to `base` is what stops an arriving `,000` from trailing the sweep over `roll`.
 */
export const MOTION_ROLL_PRESENCE: MotionToken = { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * The `scroll` token: one wheel notch or scrolling key gliding to where it would have
 * jumped (`web/src/utils/scrollSmoothing.ts`).
 *
 * Long enough that a 100px notch reads as travel rather than a cut, short enough that a turning
 * wheel never trails the hand: each notch retargets the glide, so the token bounds the lag behind the
 * last notch, not the length of a scroll. The easing is easeOutCubic, spelled here as its CSS curve,
 * rather than the console's `ease`: that curve starts at rest, and a glide restarted at every notch
 * would stall at each one.
 */
export const MOTION_SCROLL: MotionToken = { duration: 160, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' };

/**
 * The `route` token: one hop of a stored request travelling the routing map, from
 * the caller to the gateway or from the gateway to the credential that answered it.
 *
 * This motion runs on a live signal rather than on an action or a poll. It is
 * longer than `roll` because the reader has to follow a glowing stroke across most of the map's
 * width, which a quarter second does not allow; it is a fixed length rather than one scaled by distance so a
 * reroute's second hop lands on the same beat as a first. The easing starts and ends at rest, unlike
 * the console's `ease`, because the hop begins at one node and settles on another.
 */
export const MOTION_ROUTE: MotionToken = { duration: 460, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };

/** The answering credential's acknowledgement when a hop lands on it: one fade, never repeated. */
export const MOTION_ROUTE_LAND: MotionToken = { duration: 420, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * A routing-map node or lane lighting as a request reaches it and settling back: the light rises
 * over the first sixth and decays over the rest, so a tile glows as the request docks and cools while the
 * reader's eye moves on, instead of blinking.
 */
export const MOTION_ROUTE_GLOW: MotionToken = { duration: 1200, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' };

/**
 * A routing-map row sliding to close or open a gap as rows enter and leave the rolling minute. On
 * the decelerating curve, so the column settles rather than stops.
 */
export const MOTION_ROUTE_PRESENCE: MotionToken = { duration: 300, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * A routing-map row arriving: it fades in while drifting a few pixels from its own edge of the map,
 * on the console's decelerating curve. Longer than a transition because a row arriving is an event
 * the reader should notice, and never past its target: the console has no bounce.
 */
export const MOTION_ROUTE_ENTER: MotionToken = { duration: 300, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/** A routing-map row leaving the minute: shorter than its arrival and accelerating away. */
export const MOTION_ROUTE_EXIT: MotionToken = { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)' };

/** A live label repeats this glyph-only sweep; unlike a transition, its period lasts with the work. */
export const MOTION_LIVE_TEXT: MotionToken = { duration: 900, easing: 'linear' };

export function themePaletteCssVariables(palette: ThemePalette): Record<string, string> {
  const variables: Record<string, string> = {
    '--bg': palette.bg,
    '--surface': palette.surface,
    '--bg-surface': palette.surface,
    '--canvas': palette.canvas,
    '--elevated': palette.elevated,
    '--fg': palette.fg,
    '--fg-2': palette.fg2,
    '--muted': palette.muted,
    '--meta': palette.meta,
    '--border': palette.border,
    '--border-soft': palette.borderSoft,
    '--hover': palette.hover,
    '--hover-inset': palette.hoverInset,
    '--selected-inset': palette.selected,
    '--thumb-bg': palette.thumbBg,
    '--tooltip-bg': palette.tooltipBg,
    '--primary': palette.primary,
    '--primary-hover': palette.primaryHover,
    '--primary-active': palette.primaryActive,
    '--primary-on': palette.primaryOn,
    '--accent': palette.accent,
    '--accent-hover': palette.accentHover,
    '--accent-active': palette.accentActive,
    '--accent-on': palette.accentOn,
    '--success': palette.success,
    '--warn': palette.warn,
    '--danger': palette.danger,
    '--timing-green': palette.timingGreen,
    '--timing-orange': palette.timingOrange,
    '--cache-rate-yellow': palette.cacheRateYellow,
    '--cache-rate-green': palette.cacheRateGreen,
    '--heatmap-quiet': palette.heatmapQuiet,
    '--heatmap-busy': palette.heatmapBusy,
    '--heatmap-zero-unrecorded': palette.heatmapZeroUnrecorded,
    '--heatmap-zero-recorded': palette.heatmapZeroRecorded,
    '--heatmap-tip-link': palette.heatmapTipLink,
    '--series-track': palette.seriesTrack,
    '--edge-share': `${palette.edgeShare}%`,
    '--lift-share': `${palette.liftShare}%`,
    '--fine-share': `${palette.fineShare}%`,
    '--shade': palette.shade,
    '--motion-live-text': `${MOTION_LIVE_TEXT.duration}ms`,
    '--thread-field': `color-mix(in srgb, var(--fg) ${THREAD_FILL_SHARES.field}%, transparent)`,
    '--thread-field-hover': `color-mix(in srgb, var(--fg) ${THREAD_FILL_SHARES.fieldHover}%, transparent)`,
    '--thread-hairline': `color-mix(in srgb, var(--fg) ${THREAD_FILL_SHARES.hairline}%, transparent)`,
  };
  palette.series.forEach((color, index) => {
    variables[`--series-${index + 1}`] = color;
  });
  palette.effort.forEach((color, index) => {
    variables[`--effort-${index + 1}`] = color;
  });
  return variables;
}
