import React from 'react';
import { usePreference } from './usePreference';
import {
  DEFAULT_HIDDEN_NAV,
  DEFAULT_NAV_ORDER,
  NAV_HIDDEN_PREFERENCE,
  NAV_ORDER_PREFERENCE,
  applyNavOrder,
  hiddenNavSet,
  hideNavKey,
  moveNavEntry,
  parseHiddenNavKeys,
  parseNavOrder,
  retainVisibleGroups,
  showNavKey,
  stepNavEntry,
  type NavDropSide,
  type NavGroup,
  type NavOrder,
} from '../types/sidebarNav';

export interface NavLayout {
  /** The rail entries the operator has hidden, as route keys. */
  hidden: readonly string[];
  /** The same set as a lookup, for the filter that builds the rail. */
  hiddenSet: ReadonlySet<string>;
  isHidden: (key: string) => boolean;
  /** True only when both reads succeeded: a write built on a fallback would erase the stored value. */
  loaded: boolean;
  toggle: (key: string, visible: boolean) => void;
  /** Put every entry back. */
  showAll: () => void;
  /** Each group's entries in the operator's order, as stored. */
  order: NavOrder;
  /** The model in the operator's order, hidden entries included: what the settings panel lists. */
  orderedGroups: NavGroup[];
  /** The model the rail draws: ordered, then filtered by the hidden set. */
  visibleGroups: NavGroup[];
  /** Move one entry beside another in the same group. */
  move: (key: string, targetKey: string, side: NavDropSide) => void;
  /** Move one entry a place earlier or later inside its group. */
  step: (key: string, direction: -1 | 1) => void;
  /** Back to the model's own order. */
  resetOrder: () => void;
}

/**
 * useNavLayout is the rail's layout - which entries it shows and in what order - read and written
 * from the two places that need it: the rail itself and the settings panel that customizes it.
 *
 * It is a hook rather than a context because the preference layer already is the shared state: both
 * callers read the one `preferences` query entry, so a change made on the settings page is on the
 * rail before the write leaves the browser, and no page has to own either of them.
 *
 * It takes the model rather than building it because the two callers read that model from the same
 * queries for their own reasons - the shell from every route, the panel from the page that opens it -
 * and a second copy here could disagree with the rail about what a destination is.
 *
 * The stored documents are the set of *hidden* routes and each group's order. Hiding the complement
 * is what lets a release that adds a destination show it to a deployment that has never touched this
 * setting, and writing a group's order is what lets another group, or an entry the document does not
 * name, keep the model's own arrangement.
 *
 * Writes are held on `loaded` rather than `ready`: both documents are derived from what is stored, and
 * `ready` also becomes true when the read failed, at which point the value in hand is the fallback
 * and writing it would replace the operator's real setting with a default.
 */
export function useNavLayout(navGroups: readonly NavGroup[]): NavLayout {
  const { value: hidden, loaded: isHiddenLoaded, set: setHidden } = usePreference<readonly string[]>(
    NAV_HIDDEN_PREFERENCE,
    DEFAULT_HIDDEN_NAV,
    parseHiddenNavKeys,
  );
  const { value: order, loaded: isOrderLoaded, set: setOrder } = usePreference<NavOrder>(
    NAV_ORDER_PREFERENCE,
    DEFAULT_NAV_ORDER,
    parseNavOrder,
  );

  const hiddenSet = React.useMemo(() => hiddenNavSet(hidden), [hidden]);
  const isHidden = React.useCallback((key: string) => hiddenSet.has(key), [hiddenSet]);
  const orderedGroups = React.useMemo(() => applyNavOrder(navGroups, order), [navGroups, order]);
  const visibleGroups = React.useMemo(() => retainVisibleGroups(orderedGroups, hiddenSet), [orderedGroups, hiddenSet]);

  // The write is optimistic and reports its own failure, so a caller has nothing to do with the
  // result: waiting for it here would only delay the rail behind a round trip.
  const toggle = React.useCallback(
    (key: string, visible: boolean) => {
      if (!isHiddenLoaded) return;
      void setHidden(visible ? showNavKey(hidden, key) : hideNavKey(hidden, key));
    },
    [hidden, isHiddenLoaded, setHidden],
  );

  const showAll = React.useCallback(() => {
    if (!isHiddenLoaded || hidden.length === 0) return;
    void setHidden([]);
  }, [hidden, isHiddenLoaded, setHidden]);

  const move = React.useCallback(
    (key: string, targetKey: string, side: NavDropSide) => {
      if (!isOrderLoaded) return;
      const next = moveNavEntry(navGroups, order, key, targetKey, side);
      // A drop that changes nothing writes nothing: the stored document is not a draft.
      if (next !== order) void setOrder(next);
    },
    [isOrderLoaded, navGroups, order, setOrder],
  );

  const step = React.useCallback(
    (key: string, direction: -1 | 1) => {
      if (!isOrderLoaded) return;
      const next = stepNavEntry(navGroups, order, key, direction);
      if (next !== order) void setOrder(next);
    },
    [isOrderLoaded, navGroups, order, setOrder],
  );

  const resetOrder = React.useCallback(() => {
    if (!isOrderLoaded || Object.keys(order).length === 0) return;
    void setOrder(DEFAULT_NAV_ORDER);
  }, [isOrderLoaded, order, setOrder]);

  return {
    hidden,
    hiddenSet,
    isHidden,
    loaded: isHiddenLoaded && isOrderLoaded,
    toggle,
    showAll,
    order,
    orderedGroups,
    visibleGroups,
    move,
    step,
    resetOrder,
  };
}
