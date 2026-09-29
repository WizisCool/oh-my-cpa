import React from 'react';
import { createVisibleClock } from '../../../types/visibleClock';

/**
 * The transcript's own clock, ticking once a second while something is in flight.
 *
 * `createVisibleClock` only runs its interval while something is subscribed, and only live views
 * subscribe, so the timer exists exactly for the duration of a run or a running call.
 */
const liveClock = createVisibleClock(1000);

const idleClock = { subscribe: () => () => {}, getSnapshot: () => 0 };

/** The clock only while `isLive`: a settled view subscribes to nothing, so an idle page never ticks. */
export function useLiveNow(isLive: boolean): number {
  const clock = isLive ? liveClock : idleClock;
  return React.useSyncExternalStore(clock.subscribe, clock.getSnapshot, () => 0);
}
