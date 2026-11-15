import { useSyncExternalStore } from 'react';
import { useIsRoutePollingActive } from '../performance/routeContract';
import { createVisibleClock } from '../types/visibleClock';

const clock = createVisibleClock();
const serverSnapshot = () => 0;
const noopSubscribe = () => () => undefined;

/** All mounted quota cards share a single, visibility-aware 15-second clock. */
export function useVisibleNow(): number {
  const isRouteActive = useIsRoutePollingActive();
  return useSyncExternalStore(
    isRouteActive ? clock.subscribe : noopSubscribe,
    clock.getSnapshot,
    serverSnapshot,
  );
}
