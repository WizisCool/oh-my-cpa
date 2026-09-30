import { useSyncExternalStore } from 'react';
import { elapsedLabel } from '../../types/liveElapsed';
import { createFrameClock } from '../../types/frameClock';

const FRAME_CLOCK = createFrameClock();
const IDLE_CLOCK = { subscribe: () => () => {}, getSnapshot: () => 0 };

/** The external-store snapshot is the formatted value, not the clock itself. A second-scale
 * label therefore renders ten times a second even on a 144Hz screen, without rendering its parent. */
export function LiveElapsed({ startedAtMS, isRunning, durationMS }: { startedAtMS: number; isRunning: boolean; durationMS?: number }) {
  const clock = isRunning ? FRAME_CLOCK : IDLE_CLOCK;
  const label = useSyncExternalStore(clock.subscribe, () => elapsedLabel(isRunning ? clock.getSnapshot() - startedAtMS : durationMS ?? 0), () => elapsedLabel(durationMS ?? 0));
  return <span data-live-elapsed>{label}</span>;
}
