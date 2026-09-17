import { MOTION_ROLL } from '../theme/themeConfig';

/**
 * The animation every AntV mark on the dashboard runs, in the shape the library reads it.
 *
 * `update` is the one that matters. The panels re-render on a poll, and the React wrapper hands the
 * new spec to the *same* chart instance (`Plot.update()` then `Plot.render()`, with no destroy and no
 * `changeData`), so the mark the reader is already looking at is interpolated instead of replaced.
 * That is what makes this a morph rather than a redraw: a revision the reader did not ask for now
 * reads as movement rather than as a hard cut.
 *
 * `enter` and `exit` are fades, not grows or slides. Content appears; it does not fly - a mark that
 * grows in from an axis claims a direction the data does not have.
 *
 * The duration is §7's `roll` token, the same one the KPI numbers sweep over, so a tile and the mark
 * beneath it move at one tempo. See §7 rule 5 and ADR 0008 for why a chart is allowed to move at all.
 */
export const CHART_ROLL = {
  enter: { type: 'fadeIn', duration: MOTION_ROLL.duration, easing: MOTION_ROLL.easing },
  update: { type: 'morphing', duration: MOTION_ROLL.duration, easing: MOTION_ROLL.easing },
  exit: { type: 'fadeOut', duration: MOTION_ROLL.duration, easing: MOTION_ROLL.easing },
} as const;

/**
 * resolveChartAnimation is the `animate` value a chart passes.
 *
 * It returns `false` rather than an empty object at reduced motion, and that distinction is load
 * bearing: the library reads a missing spec as "use your own defaults", and its default update
 * animation is a 900ms spring - precisely the motion the reader asked not to see, arriving through
 * the one door CSS cannot close.
 */
export function resolveChartAnimation(isReducedMotion: boolean): typeof CHART_ROLL | false {
  return isReducedMotion ? false : CHART_ROLL;
}
