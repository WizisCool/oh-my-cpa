import React from 'react';

const MIN_LIST_HEIGHT = 240;
const INITIAL_LIST_HEIGHT = 480;

/**
 * The virtual list's height, measured from the host it fills.
 *
 * The page header above the list folds with a short height transition, and the
 * host changes height on every frame of it. Following that frame by frame
 * rendered the page and made the virtualizer measure every mounted row several
 * times per fold, which is what dropped frames when a wheel rocked across the
 * fold. A fold is therefore settled once: while the header is in transition the
 * list grows in one step to the height the fold will leave it, and a list that
 * is about to shrink keeps its height until the transition ends. The host clips
 * the surplus, so no frame shows a gap under the rows.
 */
export function useRequestListHeight(pageRef: React.RefObject<HTMLElement | null>) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(INITIAL_LIST_HEIGHT);

  React.useLayoutEffect(() => {
    const host = hostRef.current;
    const page = pageRef.current;
    if (!host) return undefined;
    const header = page?.querySelector<HTMLElement>('.request-collapsible-header') ?? null;

    // Compared here rather than left to React: a state setter that resolves to
    // the current value can still render the owner once, and this runs per frame.
    let applied = INITIAL_LIST_HEIGHT;
    const apply = (next: number) => {
      if (next === applied) return;
      applied = next;
      setHeight(next);
    };
    const measure = () => apply(Math.max(MIN_LIST_HEIGHT, host.clientHeight));
    // Asked of the element rather than tracked from the fold's flag: reduced
    // motion and a fold reversed mid-flight both change whether one is running.
    const foldTransitions = () => header?.getAnimations() ?? [];

    /**
     * The height the host will have once the running fold lands: what it has now,
     * plus everything the header still has to give up (or take back). The end
     * margins are read from the transitions' own keyframes, so this needs no copy
     * of the stylesheet's values.
     */
    const settledHeight = (transitions: Animation[]): number => {
      if (!header) return host.clientHeight;
      const style = getComputedStyle(header);
      const end: Record<string, string> = {};
      for (const transition of transitions) {
        const frames = (transition.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
        Object.assign(end, frames[frames.length - 1]);
      }
      const px = (value: string | undefined, fallback: string) => Number.parseFloat(value ?? fallback) || 0;
      const isClosing = header.classList.contains('is-collapsed');
      const endHeader = isClosing ? 0 : (header.firstElementChild?.scrollHeight ?? header.offsetHeight);
      // Fractional boxes: mid-transition the header is a fraction of a pixel tall,
      // and rounding it would leave the estimate a pixel off the height the fold
      // lands on, which costs the second render this exists to avoid.
      const occupiedNow = header.getBoundingClientRect().height + px(style.marginTop, '0') + px(style.marginBottom, '0');
      const occupiedAtEnd = endHeader + px(end.marginTop, style.marginTop) + px(end.marginBottom, style.marginBottom);
      return host.getBoundingClientRect().height + occupiedNow - occupiedAtEnd;
    };

    // The direction the running fold was last answered for. One answer per fold
    // is enough, and reading styles on every frame of it is the cost this avoids;
    // a fold reversed mid-flight is a new direction and is answered again.
    let answeredFold: boolean | null = null;

    const observer = new ResizeObserver(() => {
      const transitions = foldTransitions();
      if (transitions.length === 0) {
        answeredFold = null;
        measure();
        return;
      }
      const isClosing = header?.classList.contains('is-collapsed') ?? false;
      if (answeredFold === isClosing) return;
      answeredFold = isClosing;
      // Growing is taken at once and exactly, so the rows the fold uncovers are
      // already there; shrinking waits for the fold to land, and the host clips
      // the rows it has not let go of yet.
      const settled = Math.max(MIN_LIST_HEIGHT, Math.round(settledHeight(transitions)));
      if (settled > applied) apply(settled);
    });
    observer.observe(host);

    const handleFoldSettled = (event: TransitionEvent) => {
      if (event.target !== header || foldTransitions().length > 0) return;
      answeredFold = null;
      measure();
    };
    header?.addEventListener('transitionend', handleFoldSettled);
    header?.addEventListener('transitioncancel', handleFoldSettled);
    return () => {
      observer.disconnect();
      header?.removeEventListener('transitionend', handleFoldSettled);
      header?.removeEventListener('transitioncancel', handleFoldSettled);
    };
  }, [pageRef]);

  return { hostRef, height };
}
