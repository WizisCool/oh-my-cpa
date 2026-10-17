import React from 'react';

import { reconcilePresence, type Presence } from '../../../types/usageRouting';

/**
 * Keeps an item on screen for `exitMs` after it left `items`, marked `exiting`,
 * so it can animate out from the place the reader saw it. The first render's
 * items are `entering`, which lets the panel's opening read as rows arriving.
 *
 * Each leaving item has its own timer: a row that left while another was still
 * fading must not wait for the other's timer to restart.
 */
export function usePresence<T>(items: readonly T[], keyOf: (item: T) => string, exitMs: number): Presence<T>[] {
  const [list, setList] = React.useState<Presence<T>[]>(
    () => items.map((item) => ({ key: keyOf(item), item, phase: 'entering' })),
  );
  const keyOfRef = React.useRef(keyOf);
  keyOfRef.current = keyOf;
  const isFirstRef = React.useRef(true);
  React.useLayoutEffect(() => {
    if (isFirstRef.current) {
      isFirstRef.current = false;
      return;
    }
    // An equal list keeps its identity, so a caller handing over a fresh but equal array
    // settles instead of rendering again.
    setList((previous) => {
      const next = reconcilePresence(previous, items, keyOfRef.current);
      const isSame = next.length === previous.length
        && next.every((entry, index) => entry.key === previous[index].key && entry.phase === previous[index].phase && entry.item === previous[index].item);
      return isSame ? previous : next;
    });
  }, [items]);

  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>()).current;
  React.useEffect(() => {
    const exiting = new Set(list.filter((entry) => entry.phase === 'exiting').map((entry) => entry.key));
    for (const key of exiting) {
      if (timers.has(key)) continue;
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        setList((previous) => previous.filter((entry) => entry.key !== key || entry.phase !== 'exiting'));
      }, exitMs));
    }
    // An item that came back before its timer ran is staying.
    for (const [key, timer] of timers) {
      if (exiting.has(key)) continue;
      clearTimeout(timer);
      timers.delete(key);
    }
  }, [list, exitMs, timers]);
  React.useEffect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }, [timers]);
  return list;
}
