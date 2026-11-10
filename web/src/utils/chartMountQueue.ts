import {
  createFrameBudgetScheduler,
  sharedFrameScheduler,
  type MountPriority,
} from '../performance/frameScheduler';

export type ScheduleChartTask = (task: () => void) => () => void;

/**
 * Backwards-compatible factory over `createFrameBudgetScheduler` for deterministic queue tests.
 * Uses `frameBudgetMs: 0` when a custom single-step `scheduleTask` is injected so each scheduled
 * tick runs one queued task unless a wider frame budget is explicitly configured.
 */
export function createChartMountQueue(
  scheduleTask: ScheduleChartTask,
  frameBudgetMs = 0,
): (mount: () => void, priority?: MountPriority) => () => void {
  const scheduler = createFrameBudgetScheduler({
    frameBudgetMs,
    scheduleSlice: scheduleTask,
    isHidden: () => false,
  });
  return (mount, priority = 'p1') => scheduler.schedule(priority, mount);
}

/** Enqueues chart creation into the console-wide priority frame-budget scheduler. */
export function enqueueChartMount(mount: () => void, priority: MountPriority = 'p1'): () => void {
  return sharedFrameScheduler.schedule(priority, mount);
}
