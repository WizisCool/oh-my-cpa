import React from 'react';

/**
 * The console's phone breakpoint.
 *
 * Two viewport breakpoints exist and they mean different things (docs/design.md §8): at
 * 900px the shell changes shape, and at 640px the device is a phone, which is where a
 * list stops being a table. They are two constants rather than one so the difference is
 * stated in code instead of being re-derived at each call site.
 */
export const PHONE_VIEWPORT_QUERY = '(max-width: 640px)';

function matchesPhone(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(PHONE_VIEWPORT_QUERY).matches;
}

/**
 * useIsPhoneViewport reports whether the console is at its phone width, and re-renders when
 * that changes.
 *
 * A list cannot change from a table to labelled rows in CSS. The rows differ in what they
 * contain and in how the browser computes their size - a table's cells share a row's
 * constraints, and a document-flow block does not - so `display` swapping produces the
 * table's layout with the row's content. The rendering is therefore chosen in React, by the
 * same number the stylesheet's phone rules use.
 *
 * The listener is attached once and torn down on unmount; crossing the breakpoint is a rare
 * event, so no debounce is warranted.
 */
export function useIsPhoneViewport(): boolean {
  const [isPhone, setIsPhone] = React.useState(matchesPhone);

  React.useEffect(() => {
    const query = window.matchMedia(PHONE_VIEWPORT_QUERY);
    const onChange = () => setIsPhone(query.matches);
    query.addEventListener('change', onChange);
    // Re-read on mount: the viewport can change between the initial state and the effect
    // running, which would otherwise leave the first render stale.
    onChange();
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isPhone;
}
