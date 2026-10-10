import React from 'react';

/**
 * A boolean of the request page that scroll gestures flip, held outside React
 * state so that only the elements showing it re-render.
 *
 * The page component owns the filters, the query and the whole list; a flag in
 * its state re-rendered all of that on every flip, and the header's fold flips
 * with each change of wheel direction at the top of the list.
 */
export interface ViewFlag {
  get: () => boolean;
  set: (next: boolean | ((current: boolean) => boolean)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createViewFlag(initial = false): ViewFlag {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const resolved = typeof next === 'function' ? next(value) : next;
      if (resolved === value) return;
      value = resolved;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useViewFlag(flag: ViewFlag): boolean {
  return React.useSyncExternalStore(flag.subscribe, flag.get);
}
