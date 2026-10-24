import React from 'react';

/** How long after a press its change may still be anchored; anything later was not caused by it. */
const ANCHOR_WINDOW_MS = 1500;

/**
 * Keeps what the reader pressed where they pressed it.
 *
 * A control that reshapes the page - a filter chosen in a ranking far down the page - changes the
 * height of what sits above it: a legend loses rows, a chart redraws, a list shortens. The pressed row
 * then slides out from under the finger and the reader loses their place, which on a phone means
 * scrolling back to find it. The browser's own scroll anchoring does not cover this reliably: Safari
 * does not implement it, and where it exists it picks its own anchor.
 *
 * So the page records the pressed element and its viewport offset on pointer-down, and after the
 * change commits - before paint - scrolls its scroll container by however far that element moved.
 * The anchor is the nearest list row or test-identified figure rather than the raw target, because a
 * chart may redraw the very node that was pressed. Pages using this set `overflow-anchor: none` so
 * the browser does not correct the same shift a second time.
 *
 * Returns the pointer-down handler to put on the page; `dependency` is the state whose change should
 * be anchored.
 */
export function useScrollAnchor(dependency: unknown): (event: React.PointerEvent) => void {
  const anchor = React.useRef<{ element: Element; top: number; at: number } | null>(null);

  const capture = React.useCallback((event: React.PointerEvent) => {
    const target = event.target as Element | null;
    const element = target?.closest('li, tr, [data-testid]') ?? target;
    if (!element) return;
    anchor.current = { element, top: element.getBoundingClientRect().top, at: performance.now() };
  }, []);

  React.useLayoutEffect(() => {
    const current = anchor.current;
    anchor.current = null;
    if (!current || !current.element.isConnected || performance.now() - current.at > ANCHOR_WINDOW_MS) return;
    const delta = current.element.getBoundingClientRect().top - current.top;
    if (Math.abs(delta) < 1) return;
    const scroller = current.element.closest('.app-content') ?? document.scrollingElement;
    scroller?.scrollBy({ top: delta, behavior: 'instant' });
  }, [dependency]);

  return capture;
}
