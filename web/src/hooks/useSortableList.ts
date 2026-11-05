import React from 'react';
import { usePreference } from './usePreference';
import { useReorderList } from '../components/common/RowReorder';
import { applyKeyOrder, moveKey, parseGroupedOrder, parseRankOrder, rankedKeys, ranksOf, type DropSide } from '../types/displayOrder';

const NO_ORDER: Record<string, string[]> = {};
const NO_RANKS: Record<string, string> = {};

type SortableList<T> = {
  ordered: readonly T[];
  reorder: { isEnabled: boolean; onMove: (key: string, target: string, side: DropSide) => void; onStep: (key: string, direction: -1 | 1) => void };
};

/**
 * A list the operator orders by dragging. This is the whole integration for a new sortable list -
 * wrap its rows in `RowReorder` with `reorder` and the drawn keys, give each row `useReorderRow` and
 * a `ReorderHandle`. The stored order, the drop that must not jump and the keyboard step all live
 * here.
 *
 * Rows the stored order does not name follow the named ones in the list's own order, so a list whose
 * default order is computed (a sort by state or volume) keeps placing new rows by that sort. The
 * handles stay hidden until the stored order has been read: a move built on the fallback would
 * overwrite whatever the operator arranged before.
 */
function useStoredOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  storedKeys: readonly string[] | undefined,
  isLoaded: boolean,
  save: (keys: readonly string[]) => unknown,
): SortableList<T> {
  const stored = React.useMemo(() => applyKeyOrder(items, keyOf, storedKeys), [items, keyOf, storedKeys]);
  const write = (key: string, target: string, side: DropSide) => {
    const keys = stored.map(keyOf);
    const next = moveKey(keys, key, target, side);
    return next === keys ? undefined : save(next);
  };
  const { ordered, move, step } = useReorderList(stored, keyOf, write);
  return { ordered, reorder: { isEnabled: isLoaded, onMove: move, onStep: step } };
}

/** A list kept in a grouped order preference, whose document maps each list's name to its keys. */
export function useSortableList<T>(preferenceKey: string, list: string, items: readonly T[], keyOf: (item: T) => string): SortableList<T> {
  const { value: order, loaded, set } = usePreference<Record<string, string[]>>(preferenceKey, NO_ORDER, parseGroupedOrder);
  return useStoredOrder(items, keyOf, order[list], loaded, (keys) => set({ ...order, [list]: [...keys] }));
}

/**
 * A list kept in a rank document of its own, for rows keyed by a provider's positional id: the
 * server re-keys such a document with the provider overlays when a delete or move shifts later
 * entries, which it cannot do inside a grouped document. A write ranks every row, so ranks of
 * removed rows do not linger.
 */
export function useRankedSortableList<T>(preferenceKey: string, items: readonly T[], keyOf: (item: T) => string): SortableList<T> {
  const { value: ranks, loaded, set } = usePreference<Record<string, string>>(preferenceKey, NO_RANKS, parseRankOrder);
  const storedKeys = React.useMemo(() => rankedKeys(items.map(keyOf), ranks), [items, keyOf, ranks]);
  return useStoredOrder(items, keyOf, storedKeys, loaded, (keys) => set(ranksOf(keys)));
}
