import { useSyncExternalStore } from 'react';
import { createVisibleClock } from '../types/visibleClock';

const clock = createVisibleClock();
const serverSnapshot = () => 0;

/** All mounted quota cards share a single, visibility-aware 15-second clock. */
export function useVisibleNow(): number {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, serverSnapshot);
}
