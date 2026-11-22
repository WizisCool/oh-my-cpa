import { MOTION_ARRIVAL } from '../../theme/themeConfig';
import { REQUEST_COLUMNS, type RequestColumnId } from './requestColumns';

/** Short departure before the remaining tracks close. */
export const COLUMN_EXIT_DURATION = 120;

type ColumnPositions = ReadonlyMap<HTMLElement, number>;

/**
 * Capture only painted header cells and virtualized row cells. All cells keep
 * their DOM identity while the grid's track list changes, so they can be moved
 * from their previous X coordinate without cloning the table or its portal.
 */
export function captureColumnPositions(stream: HTMLElement): ColumnPositions {
  const header = stream.querySelector<HTMLElement>('.request-table-header');
  if (!header || getComputedStyle(header).display !== 'grid') return new Map();

  const positions = new Map<HTMLElement, number>();
  for (const column of REQUEST_COLUMNS) {
    for (const cell of stream.querySelectorAll<HTMLElement>(
      `.req-th-${column.id}, .req-col-${column.id}`,
    )) {
      const bounds = cell.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) positions.set(cell, bounds.left);
    }
  }
  return positions;
}

/** Fade the departing cells without changing the surrounding grid yet. */
export function fadeDepartingColumns(
  stream: HTMLElement,
  columns: ReadonlySet<RequestColumnId>,
): Animation[] {
  const animations: Animation[] = [];
  for (const id of columns) {
    for (const cell of stream.querySelectorAll<HTMLElement>(`.req-th-${id}, .req-col-${id}`)) {
      if (cell.getBoundingClientRect().width === 0 || typeof cell.animate !== 'function') continue;
      animations.push(cell.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: COLUMN_EXIT_DURATION, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
      ));
    }
  }
  return animations;
}

/**
 * The grid itself snaps to its new track list. Each surviving cell glides
 * from its old X location to its new location, while newly visible cells
 * fade in. These compositor animations never cover the toolbar or popover.
 */
export function animateColumnArrival(
  stream: HTMLElement,
  previous: ColumnPositions,
): Animation[] {
  const animations: Animation[] = [];
  for (const [cell, currentLeft] of captureColumnPositions(stream)) {
    if (typeof cell.animate !== 'function') continue;
    const oldLeft = previous.get(cell);
    if (oldLeft === undefined) {
      animations.push(cell.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: MOTION_ARRIVAL.duration, easing: MOTION_ARRIVAL.easing },
      ));
      continue;
    }
    const fromX = oldLeft - currentLeft;
    if (Math.abs(fromX) < 0.75) continue;
    animations.push(cell.animate(
      [{ transform: `translateX(${fromX}px)` }, { transform: 'translateX(0)' }],
      { duration: MOTION_ARRIVAL.duration, easing: MOTION_ARRIVAL.easing, composite: 'add' },
    ));
  }
  return animations;
}
