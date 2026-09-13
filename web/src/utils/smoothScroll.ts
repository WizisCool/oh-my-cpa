/**
 * Smooth scrolling for the request list.
 *
 * The list is virtualized, and the virtualizer owns its scroll container: it
 * measures the holder, corrects the offset after committing new rows, and
 * re-applies what it was holding. Two consequences shape everything here.
 *
 * First, an animated scroll must not be delegated to CSS. Setting
 * `scroll-behavior: smooth` on the holder makes the *element* animate, but the
 * virtualizer keeps writing `scrollTop` on its own schedule and the two fight;
 * measured against the real list the holder simply never moves. So the animation
 * is driven in JavaScript and pushed through the same API the component already
 * scrolls itself with.
 *
 * Second, a correction is not a weaker gesture. Pin row one after the header
 * collapses, reset on a page change, land on the row a drill-down names — each of
 * those needs the position to be *true* before the next statement runs, and a
 * virtualized list measures its window mid-flight. So corrections stay instant,
 * and only the reader's own gestures animate.
 */

/**
 * How a scroll should be performed.
 *
 * `smooth` is for gestures the reader initiated — "back to top", applying a
 * backlog of new records — where following the movement is what makes the list
 * read as one surface instead of a page swap.
 *
 * `instant` is for scrolls that exist to keep the view correct. Animating those
 * would leave the list showing a position nobody asked for while the virtualizer
 * is already re-measuring underneath.
 */
export type ScrollIntent = 'smooth' | 'instant';

/** Whether the platform is currently honouring animation requests. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Longest a gesture scroll may take, in milliseconds. */
export const SCROLL_ANIMATION_MS = 260;

/** Reduced motion collapses a gesture to a correction rather than to nothing. */
export function scrollDurationFor(intent: ScrollIntent): number {
  if (intent === 'instant') return 0;
  return prefersReducedMotion() ? 0 : SCROLL_ANIMATION_MS;
}

/**
 * easeOutCubic decelerates into the destination.
 *
 * A listing that starts at full speed and settles reads as travel; a linear ramp
 * reads as a jump that was cut into pieces. Clamped rather than trusting the
 * caller, because the value is also the interpolation weight below.
 */
export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - (1 - clamped) ** 3;
}

/**
 * scrollTopAt is the position for one frame of a gesture.
 *
 * The schedule is a pure function of elapsed time rather than an accumulator, so
 * a dropped or late frame cannot make the animation drift or overshoot: whatever
 * the frame rate, the value is where the scroll should be at that instant. It
 * returns exactly `0` once the duration has elapsed, which is what guarantees the
 * gesture lands on row one instead of near it.
 */
export function scrollTopAt(from: number, elapsedMs: number, durationMs = SCROLL_ANIMATION_MS): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return 0;
  const eased = easeOutCubic(elapsedMs / durationMs);
  const top = from * (1 - eased);
  // Integer pixels: the values are handed to a scroll offset, and a fractional
  // one is rounded inconsistently across engines.
  return Math.round(top) <= 0 ? 0 : Math.round(top);
}

export interface ScrollAnimationHandle {
  /** Stops the animation without moving anywhere else. */
  cancel: () => void;
}

/**
 * animateScrollToTop drives one return to the top frame by frame.
 *
 * `applyTop` is expected to be the list's own scroll entry point, so every frame
 * is a scroll the virtualizer already knows how to handle — there is no second
 * authority over the offset. The last frame always writes `0` explicitly: the
 * easing guarantees the value, and writing it once more after the final frame is
 * what makes the end of a gesture exact rather than approximately exact.
 *
 * Re-entrancy is the caller's business, and the callers here already handle it —
 * a second gesture replaces the first via the same refs the polling logic uses.
 */
export function animateScrollToTop(
  from: number,
  applyTop: (top: number) => void,
  { durationMs = scrollDurationFor('smooth') }: { durationMs?: number } = {},
): ScrollAnimationHandle {
  if (durationMs <= 0 || from <= 0) {
    applyTop(0);
    return { cancel: () => undefined };
  }

  let frame = 0;
  let cancelled = false;
  const startedAt = performance.now();

  const step = () => {
    if (cancelled) return;
    const elapsed = performance.now() - startedAt;
    applyTop(scrollTopAt(from, elapsed, durationMs));
    if (elapsed >= durationMs) {
      // The final write, so the gesture lands on row one exactly.
      applyTop(0);
      return;
    }
    frame = requestAnimationFrame(step);
  };

  frame = requestAnimationFrame(step);
  return {
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    },
  };
}
