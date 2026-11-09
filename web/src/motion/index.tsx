import React from 'react';
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, useIsPresent, type Transition } from 'motion/react';
import * as m from 'motion/react-m';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';

/**
 * The console's one door to Motion (motion.dev). Surfaces import `m`, `AnimatePresence` and the
 * spring tokens from here, never from `motion/react` itself, so that every animated surface runs
 * under the same reduced-motion policy and settles with the same few springs.
 *
 * Motion is not part of the shell. A surface that animates with it wraps itself in `MotionScope`,
 * which loads the animation features with that surface's own lazy route chunk; the `m` components
 * are inert outside it (`strict` refuses the full `motion` component, whose eager features would
 * undo that). Library overlays - drawers, dialogs, menus - keep the CSS motion tokens in
 * `index.css`; this module is for elements React renders itself.
 */

/**
 * Named springs, by what the motion means rather than how it feels. The console's motion is brisk:
 * it answers the hand at once and is done before the eye has to wait for it, so these are short and
 * `bounce: 0` - critically damped, settling without an overshoot structure should never show.
 * `visualDuration` is when the move looks finished; the tail after it is imperceptible.
 */
export const SPRINGS = {
  /** Structure making room for something that arrives: a tier opening, a row unfolding. */
  settle: { type: 'spring', visualDuration: 0.22, bounce: 0 },
  /** Something leaving goes a little quicker than something arriving, out of the reader's way. */
  leave: { type: 'spring', visualDuration: 0.16, bounce: 0 },
  /**
   * The answer to a keystroke: a filtered list settling where it stands. It is the shortest of the
   * three because it runs under the hand that is still typing - a list that is still moving when the
   * next character lands reads as lag, not as grace.
   */
  answer: { type: 'spring', visualDuration: 0.14, bounce: 0 },
} as const satisfies Record<string, Transition>;

export type SpringName = keyof typeof SPRINGS;

const INSTANT: Transition = { duration: 0 };

/**
 * The transition a surface animates with: the named spring, or none under reduced motion. Motion's
 * own reduced-motion mode still plays opacity and size; the console's policy is that a reduced
 * interface does not move at all, so the choice is made here rather than left to the library.
 */
export function useSpringTransition(name: SpringName): Transition {
  return usePrefersReducedMotion() ? INSTANT : SPRINGS[name];
}

/** Layout animation's features, fetched the first time a surface that uses them mounts. */
const loadLayoutFeatures = () => import('./layoutFeatures').then((module) => module.default);

/**
 * Loads Motion's features for a surface and binds them to the console's policy. `animation` (the
 * default) covers enter, exit and value animation and is loaded with the surface. `layout` adds
 * layout animation - elements gliding to where a reflow put them - and arrives a moment later on its
 * own, so the surface paints first; until then its elements simply take their places.
 */
export function MotionScope({ features = 'animation', children }: { features?: 'animation' | 'layout'; children: React.ReactNode }) {
  const isReduced = usePrefersReducedMotion();
  return (
    <LazyMotion features={features === 'layout' ? loadLayoutFeatures : domAnimation} strict>
      <MotionConfig reducedMotion={isReduced ? 'always' : 'never'}>{children}</MotionConfig>
    </LazyMotion>
  );
}

export { AnimatePresence, m, useIsPresent, INSTANT };
