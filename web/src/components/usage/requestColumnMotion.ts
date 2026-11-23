import { MOTION_ARRIVAL } from '../../theme/themeConfig';

const COLUMN_CELL_SELECTOR =
  '.request-table-header > .req-th:not(.req-th-select):not(.req-th-chevron), .request-row > .req-col';

const MIN_GLIDE_DELTA_PX = 0.75;

export type ColumnPositions = ReadonlyMap<HTMLElement, number>;

/**
 * Snapshots the painted X coordinates of visible header and virtualized row cells.
 * Returns an empty map in stacked-card mode (<= 920px) where the table header is hidden.
 */
export function captureColumnPositions(stream: HTMLElement): ColumnPositions {
  const header = stream.querySelector<HTMLElement>('.request-table-header');
  if (!header || getComputedStyle(header).display !== 'grid') return new Map();

  const positions = new Map<HTMLElement, number>();
  for (const cell of stream.querySelectorAll<HTMLElement>(COLUMN_CELL_SELECTOR)) {
    const bounds = cell.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) {
      positions.set(cell, bounds.left);
    }
  }
  return positions;
}

/** Cancels any in-flight column animations before measuring fresh layout positions. */
export function cancelColumnAnimations(animations: readonly Animation[]): void {
  for (const animation of animations) {
    try {
      animation.cancel();
    } catch {
      // Ignore already-detached animations in synthetic or torn-down trees.
    }
  }
}

/**
 * Runs a single-move horizontal FLIP glide after the grid snaps to its new column layout:
 * hidden columns leave immediately, surviving columns glide from their previous X coordinate
 * to their new track, and newly shown columns fade in where they belong.
 */
export function animateColumnGlide(
  stream: HTMLElement,
  previous: ColumnPositions,
): Animation[] {
  if (previous.size === 0) return [];
  const animations: Animation[] = [];
  for (const [cell, currentLeft] of captureColumnPositions(stream)) {
    if (typeof cell.animate !== 'function') continue;
    const oldLeft = previous.get(cell);
    if (oldLeft === undefined) {
      animations.push(
        cell.animate(
          [{ opacity: 0 }, { opacity: 1 }],
          { duration: MOTION_ARRIVAL.duration, easing: MOTION_ARRIVAL.easing },
        ),
      );
      continue;
    }
    const fromX = oldLeft - currentLeft;
    if (Math.abs(fromX) < MIN_GLIDE_DELTA_PX) continue;
    animations.push(
      cell.animate(
        [{ transform: `translateX(${fromX}px)` }, { transform: 'translateX(0)' }],
        { duration: MOTION_ARRIVAL.duration, easing: MOTION_ARRIVAL.easing },
      ),
    );
  }
  return animations;
}
