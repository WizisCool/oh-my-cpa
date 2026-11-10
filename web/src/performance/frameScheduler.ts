import React from 'react';
import ReactDOM from 'react-dom';

/**
 * Priority tiers for staged component and chart initialization:
 * - `p0`: Above-the-fold hero KPIs and primary sparklines.
 * - `p1`: Primary analytical charts and interactive visualizations.
 * - `p2`: Below-the-fold panels, calendars, and secondary tables.
 */
export type MountPriority = 'p0' | 'p1' | 'p2';

const PRIORITY_ORDER: readonly MountPriority[] = ['p0', 'p1', 'p2'];

export interface FrameBudgetSchedulerOptions {
  /**
   * Soft execution budget per animation-frame slice in milliseconds.
   * Multiple fast mounts batch into one commit while their cumulative work stays under this budget;
   * once exceeded, remaining work yields to the browser's next paint and input cycle.
   */
  frameBudgetMs?: number;
  now?: () => number;
  /** Schedules a post-paint execution slice and returns its cancellation function. */
  scheduleSlice?: (run: () => void) => () => void;
  /** Optional React batching wrapper so tasks inside one slice commit in a single DOM pass. */
  batchUpdates?: (run: () => void) => void;
  /** True while the document is hidden and background rendering should pause. */
  isHidden?: () => boolean;
  /** Subscribes to visibility changes so queued work resumes when the tab returns. */
  onVisibilityChange?: (listener: () => void) => () => void;
  /**
   * Optional predicate indicating an active concurrent route transition.
   * While true, lower-priority (`p1`/`p2`) mounts yield so navigation commits first.
   */
  isTransitionPending?: () => boolean;
}

interface QueuedJob {
  readonly priority: MountPriority;
  readonly run: () => void;
  cancelled: boolean;
}

export interface FrameBudgetScheduler {
  schedule: (priority: MountPriority, run: () => void) => () => void;
  pendingCount: (priority?: MountPriority) => number;
  /** Notifies the scheduler that external pause conditions (such as route transitions) changed. */
  poke: () => void;
  dispose: () => void;
}

function defaultScheduleSlice(run: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  }
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const frameId = requestAnimationFrame(() => {
    timerId = setTimeout(run, 0);
  });
  return () => {
    cancelAnimationFrame(frameId);
    if (timerId !== undefined) clearTimeout(timerId);
  };
}

/**
 * Priority-ordered, frame-budgeted task scheduler.
 *
 * Unlike a one-item-per-frame `flushSync` queue (which forces N separate full-document style and
 * layout recalculations when N charts mount), this scheduler runs as many ready tasks as fit inside
 * `frameBudgetMs` inside a single batched React commit, then yields to paint and input before
 * advancing to lower-priority tiers.
 */
export function createFrameBudgetScheduler(options: FrameBudgetSchedulerOptions = {}): FrameBudgetScheduler {
  const frameBudgetMs = options.frameBudgetMs ?? 8;
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const scheduleSlice = options.scheduleSlice ?? defaultScheduleSlice;
  const batchUpdates = options.batchUpdates ?? ((fn) => fn());
  const isHidden = options.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const isTransitionPending = options.isTransitionPending ?? (() => false);

  const queues: Record<MountPriority, Set<QueuedJob>> = {
    p0: new Set(),
    p1: new Set(),
    p2: new Set(),
  };

  let cancelScheduled: (() => void) | undefined;
  let detachVisibility: (() => void) | undefined;
  let isDisposed = false;

  const totalPending = (): number => queues.p0.size + queues.p1.size + queues.p2.size;

  const hasRunnableWork = (): boolean => {
    if (isDisposed || isHidden()) return false;
    if (queues.p0.size > 0) return true;
    if (isTransitionPending()) return false;
    return queues.p1.size > 0 || queues.p2.size > 0;
  };

  const cancelSlice = () => {
    cancelScheduled?.();
    cancelScheduled = undefined;
  };

  const nextJob = (): QueuedJob | undefined => {
    const transitioning = isTransitionPending();
    for (const tier of PRIORITY_ORDER) {
      if (transitioning && tier !== 'p0') continue;
      const bucket = queues[tier];
      while (bucket.size > 0) {
        const candidate = bucket.values().next().value as QueuedJob | undefined;
        if (!candidate) break;
        bucket.delete(candidate);
        if (!candidate.cancelled) return candidate;
      }
    }
    return undefined;
  };

  const ensureScheduled = () => {
    if (cancelScheduled || !hasRunnableWork()) return;
    cancelScheduled = scheduleSlice(runSlice);
  };

  function runSlice(): void {
    cancelScheduled = undefined;
    if (!hasRunnableWork()) return;

    const sliceStart = now();
    let firstError: unknown;
    let hasError = false;

    batchUpdates(() => {
      let ranAny = false;
      while (hasRunnableWork()) {
        // Always execute at least one ready job per slice so an expensive initialization makes
        // forward progress without livelocking; subsequent jobs run only while budget remains.
        if (ranAny && now() - sliceStart >= frameBudgetMs) break;
        const job = nextJob();
        if (!job) break;
        ranAny = true;
        try {
          job.run();
        } catch (error) {
          if (!hasError) {
            hasError = true;
            firstError = error;
          }
        }
      }
    });

    if (totalPending() > 0) ensureScheduled();
    else {
      detachVisibility?.();
      detachVisibility = undefined;
    }

    if (hasError) throw firstError;
  }

  const handleVisibilityChange = () => {
    if (isHidden()) cancelSlice();
    else ensureScheduled();
  };

  return {
    schedule(priority, run) {
      if (isDisposed) return () => undefined;
      const job: QueuedJob = { priority, run, cancelled: false };
      queues[priority].add(job);
      if (!detachVisibility && options.onVisibilityChange) {
        detachVisibility = options.onVisibilityChange(handleVisibilityChange);
      }
      ensureScheduled();
      return () => {
        if (job.cancelled) return;
        job.cancelled = true;
        queues[priority].delete(job);
        if (totalPending() === 0) {
          cancelSlice();
          detachVisibility?.();
          detachVisibility = undefined;
        }
      };
    },
    pendingCount(priority) {
      return priority ? queues[priority].size : totalPending();
    },
    poke() {
      if (hasRunnableWork()) ensureScheduled();
    },
    dispose() {
      isDisposed = true;
      cancelSlice();
      detachVisibility?.();
      detachVisibility = undefined;
      queues.p0.clear();
      queues.p1.clear();
      queues.p2.clear();
    },
  };
}

let transitionPendingReader: (() => boolean) | undefined;

export function bindSchedulerTransitionReader(reader: (() => boolean) | undefined): void {
  transitionPendingReader = reader;
}

export const sharedFrameScheduler = createFrameBudgetScheduler({
  frameBudgetMs: 8,
  batchUpdates: (run) => {
    if (typeof ReactDOM.unstable_batchedUpdates === 'function') {
      ReactDOM.unstable_batchedUpdates(run);
    } else {
      run();
    }
  },
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onVisibilityChange: (listener) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  isTransitionPending: () => Boolean(transitionPendingReader?.()),
});

export interface UseFrameBudgetMountOptions {
  /** Mount synchronously on the first render (e.g., for `p0` static shells or test overrides). */
  immediate?: boolean;
  scheduler?: FrameBudgetScheduler;
}

/**
 * Defers heavy subtree initialization into the shared priority frame-budget queue.
 * Once mounted, the component remains mounted across re-renders without flickering.
 */
export function useFrameBudgetMount(
  priority: MountPriority = 'p1',
  options: UseFrameBudgetMountOptions = {},
): boolean {
  const { immediate = false, scheduler = sharedFrameScheduler } = options;
  const [isMounted, setIsMounted] = React.useState(immediate);

  React.useEffect(() => {
    if (isMounted) return undefined;
    return scheduler.schedule(priority, () => setIsMounted(true));
  }, [isMounted, priority, scheduler]);

  return isMounted;
}
