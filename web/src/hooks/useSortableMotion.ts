import type { AnimateLayoutChanges } from '@dnd-kit/sortable';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/** Items glide to the places a reflow gave them while a drag sorts; at the drop they are there. */
export const glideWhileSorting: AnimateLayoutChanges = ({ isSorting }) => isSorting;

const NO_GLIDE: AnimateLayoutChanges = () => false;
const REDUCED = { animateLayoutChanges: NO_GLIDE, transition: null } as const;

/**
 * The options that turn a sortable item's glides off under reduced motion; spread after the
 * item's own. Items then take their new places at once, and the drag itself still follows the
 * pointer.
 */
export function useSortableMotion(): Partial<typeof REDUCED> {
  return usePrefersReducedMotion() ? REDUCED : {};
}
