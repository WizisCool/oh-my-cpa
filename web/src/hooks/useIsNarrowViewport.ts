import React from 'react';

/**
 * The console's single narrow-viewport breakpoint, matching the layout's own
 * `max-width: 900px` rule. It exists as a module-level constant so a control
 * that has to change *shape* rather than just size consults the same number the
 * stylesheet does; two different breakpoints for one console is how a layout
 * ends up with a band of widths where nothing agrees.
 */
export const NARROW_VIEWPORT_QUERY = '(max-width: 900px)';

function matchesNarrow(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

/**
 * useIsNarrowViewport reports whether the console is at its narrow width, and
 * re-renders when that changes.
 *
 * Some controls cannot be laid out by CSS alone. A segmented picker is the case
 * that forced this hook: its track is sized to the sum of its labels, so on a
 * phone the third option is painted past the card's edge - and no rule on the
 * track can fix that, because the items do not wrap and the library positions
 * its selection thumb against a single row. The control has to become a vertical
 * list there, which is a shape change React has to make.
 *
 * The listener is attached once and torn down on unmount; crossing the
 * breakpoint is a rare event, so no debounce is warranted.
 */
export function useIsNarrowViewport(): boolean {
  const [isNarrow, setIsNarrow] = React.useState(matchesNarrow);

  React.useEffect(() => {
    const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const onChange = () => setIsNarrow(query.matches);
    query.addEventListener('change', onChange);
    // Re-read on mount: the viewport can change between the initial state and
    // the effect running, which would otherwise leave the first render stale.
    onChange();
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isNarrow;
}
