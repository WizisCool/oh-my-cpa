import React from 'react';

/** The primary pointer can rest on a control without pressing it: a mouse or trackpad, not a finger. */
export const CAN_HOVER_QUERY = '(hover: hover)';

function matchesCanHover(): boolean {
  return typeof window === 'undefined' || window.matchMedia(CAN_HOVER_QUERY).matches;
}

/**
 * useCanHover reports whether hovering is something the reader's pointer can do.
 *
 * A touch screen still produces hover: the browser keeps a hover state at the last place touched
 * and re-evaluates it when the layout moves, so a control that slides under that point - when a
 * keyboard opens, say - is "hovered" without having been touched. Anything shown on hover has to
 * ask, and keep asking, because a tablet gains and loses a mouse while the console is open.
 */
export function useCanHover(): boolean {
  const [canHover, setCanHover] = React.useState(matchesCanHover);
  React.useEffect(() => {
    const query = window.matchMedia(CAN_HOVER_QUERY);
    const update = () => setCanHover(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return canHover;
}
