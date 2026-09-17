import React from 'react';

/**
 * The query every motion override in the console is written against.
 *
 * A module constant for the same reason the narrow-viewport breakpoint is one: the stylesheet and the
 * components that cannot be told by CSS must consult the same string, or the two disagree about what
 * "reduced" means.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function matchesReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * usePrefersReducedMotion reports whether the reader has asked for reduced motion.
 *
 * CSS already carries this preference for every transition and keyframe the console owns. It cannot
 * reach a canvas: an AntV mark is redrawn frame by frame by the library, and the library has no
 * reduced-motion handling of its own (neither `@antv/g2` nor `@ant-design/plots` mentions the query
 * anywhere). So the charts have to ask, and they have to keep asking - the preference can change
 * while the console is open, and a dashboard that animated anyway until the next reload would break
 * the promise mid-session.
 *
 * The listener mirrors `useIsNarrowViewport`: attached once, torn down on unmount, and re-read on
 * mount because the preference can change between the initial state and the effect running.
 */
export function usePrefersReducedMotion(): boolean {
  const [isReduced, setIsReduced] = React.useState(matchesReducedMotion);

  React.useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setIsReduced(query.matches);
    query.addEventListener('change', onChange);
    onChange();
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isReduced;
}
