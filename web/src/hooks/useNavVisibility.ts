import React from 'react';
import { usePreference } from './usePreference';
import {
  DEFAULT_HIDDEN_NAV,
  NAV_HIDDEN_PREFERENCE,
  hiddenNavSet,
  hideNavKey,
  parseHiddenNavKeys,
  showNavKey,
} from '../types/sidebarNav';

export interface NavVisibility {
  /** The rail entries the operator has hidden, as route keys. */
  hidden: readonly string[];
  /** The same set as a lookup, for the filter that builds the rail. */
  hiddenSet: ReadonlySet<string>;
  isHidden: (key: string) => boolean;
  /** True once the stored set has been read, so a caller can hold a write until it has. */
  ready: boolean;
  toggle: (key: string, visible: boolean) => void;
  /** Put every entry back. */
  showAll: () => void;
}

/**
 * useNavVisibility is the rail's visibility setting, read and written from the two places that
 * need it - the rail itself and the settings page that customizes it.
 *
 * It is a hook rather than a context because the preference layer already is the shared state:
 * both callers read the one `preferences` query entry, so a toggle made on the settings page is
 * on the rail before the write leaves the browser, and no page has to own either of them.
 *
 * The stored document is the set of *hidden* routes rather than the visible ones, which is what
 * lets a release that adds a destination show it to a deployment that has never touched this
 * setting - there is nothing to re-enable.
 */
export function useNavVisibility(): NavVisibility {
  const { value, ready, set } = usePreference<readonly string[]>(NAV_HIDDEN_PREFERENCE, DEFAULT_HIDDEN_NAV, parseHiddenNavKeys);

  const hiddenSet = React.useMemo(() => hiddenNavSet(value), [value]);
  const isHidden = React.useCallback((key: string) => hiddenSet.has(key), [hiddenSet]);

  // The write is optimistic and reports its own failure, so a caller has nothing to do with the
  // result: waiting for it here would only delay the rail behind a round trip.
  const toggle = React.useCallback(
    (key: string, visible: boolean) => {
      void set(visible ? showNavKey(value, key) : hideNavKey(value, key));
    },
    [set, value],
  );

  const showAll = React.useCallback(() => {
    if (value.length === 0) return;
    void set([]);
  }, [set, value]);

  return { hidden: value, hiddenSet, isHidden, ready, toggle, showAll };
}
