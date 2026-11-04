import React from 'react';

/** How far the pointer travels after one swap before the next may happen. */
const MIN_TRAVEL_PX = 8;

/**
 * Keeps a live sort from swapping on its own. Items of different sizes reflow when two of them
 * trade places, and the reflow can leave the pointer over another item - or over the one it just
 * passed, now somewhere else - which would swap again without the hand moving, and back and forth.
 *
 * So a swap waits for the hand: it is refused against the item just swapped with until the pointer
 * has left that item, and refused altogether until the pointer has travelled a little since the
 * last one. A reflow under a still pointer changes nothing.
 */
export function useSortGuard() {
  const last = React.useRef<{ id: string | null; x: number; y: number } | null>(null);
  return React.useMemo(() => ({
    reset: () => { last.current = null; },
    /** Whether the item in hand, now over `overId` at the drag's `delta`, should swap with it. */
    shouldSwap: (activeId: string, overId: string, delta: { x: number; y: number }) => {
      const previous = last.current;
      if (overId === activeId) {
        if (previous) previous.id = null;
        return false;
      }
      if (previous && (previous.id === overId || Math.hypot(delta.x - previous.x, delta.y - previous.y) < MIN_TRAVEL_PX)) return false;
      last.current = { id: overId, x: delta.x, y: delta.y };
      return true;
    },
  }), []);
}
