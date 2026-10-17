import React from 'react';

import { MOTION_ROUTE_ENTER, MOTION_ROUTE_EXIT, MOTION_ROUTE_PRESENCE } from '../../../theme/themeConfig';
import type { PresencePhase } from '../../../types/usageRouting';

/**
 * Where an element sits in the map's own layout, without the transforms on it or
 * its ancestors. Measured against the map rather than the column: a column is
 * centred, so a row arriving anywhere in it moves every other row by half a row,
 * and a FLIP measured inside the column would miss that move and let it jump.
 */
function layoutTopWithin(element: HTMLElement, container: HTMLElement | null): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== container) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

/**
 * Slides an element from where it was laid out to where it is now (FLIP): the
 * layout changes at once and a transform carries the element across, so a
 * reflow never animates a layout property (docs/design.md §7 rules 1 and 9). The
 * slide is additive, so it composes with an entrance still running.
 */
export function useFlip(ref: React.RefObject<HTMLElement | null>, containerRef: React.RefObject<HTMLElement | null>, isReducedMotion: boolean) {
  const topRef = React.useRef<number | undefined>(undefined);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const top = layoutTopWithin(element, containerRef.current);
    const previous = topRef.current;
    topRef.current = top;
    if (previous === undefined || Math.abs(previous - top) < 0.5 || isReducedMotion) return;
    element.animate(
      [{ transform: `translateY(${previous - top}px)` }, { transform: 'translateY(0)' }],
      { duration: MOTION_ROUTE_PRESENCE.duration, easing: MOTION_ROUTE_PRESENCE.easing, composite: 'add' },
    );
  });
}

/**
 * A row's motion as it enters, leaves and moves.
 *
 * A row fades in while drifting a few pixels in from `away`; it leaves the same
 * way, quicker and accelerating, and stays in its place while it fades so the
 * rows around it close the gap only once it has gone.
 */
export function useRowMotion(
  ref: React.RefObject<HTMLElement | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  { phase, away, delayMs, isReducedMotion }: { phase: PresencePhase; away: string; delayMs: number; isReducedMotion: boolean },
) {
  const exitRef = React.useRef<Animation | undefined>(undefined);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element || phase !== 'entering' || isReducedMotion) return;
    element.animate(
      [{ opacity: 0, transform: away }, { opacity: 1, transform: 'none' }],
      { duration: MOTION_ROUTE_ENTER.duration, easing: MOTION_ROUTE_ENTER.easing, delay: delayMs, fill: 'backwards' },
    );
    // Only the mount enters; a later phase change is the exit effect's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (phase === 'exiting') {
      if (!isReducedMotion && !exitRef.current) {
        exitRef.current = element.animate(
          [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: away }],
          { duration: MOTION_ROUTE_EXIT.duration, easing: MOTION_ROUTE_EXIT.easing, fill: 'forwards' },
        );
      }
    } else if (exitRef.current) {
      exitRef.current.cancel();
      exitRef.current = undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isReducedMotion]);

  useFlip(ref, containerRef, isReducedMotion);
}
