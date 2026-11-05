import React from 'react';
import { usePreference } from './usePreference';
import { useReorderList } from '../components/common/RowReorder';
import { applyKeyOrder, moveKey, parseGroupedOrder, type DropSide } from '../types/displayOrder';

const NO_ORDER: Record<string, string[]> = {};

/**
 * A list the operator orders by dragging, kept in a grouped order preference: the document maps each
 * list's name to its keys. This is the whole integration for a new sortable list - wrap its rows in
 * `RowReorder` with `reorder` and the drawn keys, give each row `useReorderRow` and a
 * `ReorderHandle`. The stored order, the drop that must not jump and the keyboard step all live here.
 *
 * Rows the document does not name follow the named ones in the list's own order, so a list whose
 * default order is computed (a sort by state or volume) keeps placing new rows by that sort. The
 * handles stay hidden until the stored order has been read: a move built on the fallback would
 * overwrite whatever the operator arranged before.
 */
export function useSortableList<T>(
  preferenceKey: string,
  list: string,
  items: readonly T[],
  keyOf: (item: T) => string,
): {
  ordered: readonly T[];
  reorder: { isEnabled: boolean; onMove: (key: string, target: string, side: DropSide) => void; onStep: (key: string, direction: -1 | 1) => void };
} {
  const { value: order, loaded, set } = usePreference<Record<string, string[]>>(preferenceKey, NO_ORDER, parseGroupedOrder);
  const stored = React.useMemo(() => applyKeyOrder(items, keyOf, order[list]), [items, keyOf, order, list]);
  const write = (key: string, target: string, side: DropSide) => {
    const keys = stored.map(keyOf);
    const next = moveKey(keys, key, target, side);
    return next === keys ? undefined : set({ ...order, [list]: [...next] });
  };
  const { ordered, move, step } = useReorderList(stored, keyOf, write);
  return { ordered, reorder: { isEnabled: loaded, onMove: move, onStep: step } };
}
