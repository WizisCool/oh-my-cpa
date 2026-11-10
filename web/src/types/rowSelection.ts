/**
 * How the console's selectable lists answer a click, the way a desktop file list does.
 *
 * A list shows no selection column until a choice is under way. A plain click opens the row; ⌘ or
 * Ctrl picks one row; Shift picks the run from the anchor - the row last picked without Shift - to
 * the row clicked, as `pickRows` describes. Once anything is chosen, a plain click picks too, so a choice goes on without
 * aiming at boxes.
 */
export type RowClickIntent = 'open' | 'toggle' | 'range';

export function rowClickIntent(
  event: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>,
  isSelecting: boolean,
): RowClickIntent {
  if (event.shiftKey) return 'range';
  if (event.metaKey || event.ctrlKey || isSelecting) return 'toggle';
  return 'open';
}

/**
 * Whether a click on a selection checkbox extends a run. Space on a focused box arrives as a click
 * too, and whether that click reports Shift differs by browser, so a keyboard toggle (detail 0)
 * always picks the one row.
 */
export function isRangeCheckboxClick(event: Pick<MouseEvent, 'shiftKey' | 'detail'>): boolean {
  return event.shiftKey && event.detail > 0;
}

/**
 * Where the next Shift click runs from: the row last picked without Shift, the state that pick left
 * it in, and the rows the latest run from it changed.
 */
export interface SelectionAnchor<Key> {
  key: Key;
  isSelected: boolean;
  changed: readonly Key[];
}

export interface RowPick<Key> {
  selected: Set<Key>;
  anchor: SelectionAnchor<Key>;
}

/**
 * One pick applied to a selection, the way a desktop file list takes it. A plain pick flips the row
 * and makes it the anchor. A Shift pick gives every row from the anchor to the target, in the list's
 * order, the anchor's state, after undoing the previous run from the same anchor - so a second
 * Shift click moves the run's far end rather than adding to it, and a shorter run gives rows back.
 * Rows chosen any other way are left as they are. Without an anchor still in the list there is no
 * run, and the pick is plain.
 */
export function pickRows<Key>(
  selected: ReadonlySet<Key>,
  order: readonly Key[],
  target: Key,
  anchor: SelectionAnchor<Key> | null | undefined,
  isRange: boolean,
): RowPick<Key> {
  const next = new Set(selected);
  const targetIndex = order.indexOf(target);
  const anchorIndex = isRange && anchor ? order.indexOf(anchor.key) : -1;
  if (!anchor || targetIndex < 0 || anchorIndex < 0) {
    if (next.has(target)) next.delete(target);
    else next.add(target);
    return { selected: next, anchor: { key: target, isSelected: next.has(target), changed: [] } };
  }
  const apply = (key: Key, isSelected: boolean) => (isSelected ? next.add(key) : next.delete(key));
  for (const key of anchor.changed) apply(key, !anchor.isSelected);
  const changed: Key[] = [];
  for (const key of order.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)) {
    if (next.has(key) === anchor.isSelected) continue;
    apply(key, anchor.isSelected);
    changed.push(key);
  }
  return { selected: next, anchor: { ...anchor, changed } };
}
