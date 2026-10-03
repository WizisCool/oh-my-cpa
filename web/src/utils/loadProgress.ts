/**
 * The rough-progress model behind the console's loading bar.
 *
 * The console counts queries and module waits rather than inventing a known remaining duration.
 * Each task has an id; a batch opens when the first starts and ends when the last settles. Settled
 * work counts in full; pending work earns exponential credit capped at `PENDING_CREDIT_CAP` of its
 * share. Only settlement earns the remaining credit. Independent CSS activity reports waiting even
 * when the estimate holds at its cap or a larger denominator keeps it below the drawn frontier.
 *
 * Pure and clock-injected, so the policy is tested without a browser; `progressController` owns the frame
 * clock and lifecycle; `ProgressBar` owns the DOM and CSS activity marker.
 */

/** The work must still be in flight after this long before the bar paints (design.md §7 rule 4). */
export const PROGRESS_SHOW_DELAY_MS = 200;
/** The most of its share a pending task can earn before it settles. */
export const PENDING_CREDIT_CAP = 0.85;
/** How quickly a pending task approaches that cap; about two thirds of it after this long. */
export const PENDING_CREDIT_TAU_MS = 1600;
/** The bar starts with a visible sliver, so the first painted frame is not an empty track. */
export const PROGRESS_FLOOR = 0.08;
/** How quickly the drawn bar closes on the model's value; about two thirds of a step per this long. */
export const PROGRESS_SMOOTHING_TAU_MS = 90;

export interface ProgressBatch {
  /** When the batch's first task started. */
  startedAt: number;
  /** Each pending task, by id, with when it started. */
  pending: ReadonlyMap<string, number>;
  /** Every task this batch has started, settled or not; a task that starts again counts again. */
  started: number;
  settled: number;
}

/**
 * Folds the ids currently in flight into the batch.
 *
 * Returns `null` while nothing is in flight and nothing was: there is no batch to draw. A batch whose
 * last task just settled is returned with an empty `pending` - that is the completed state, and the
 * caller decides how long to keep it painted before discarding the batch.
 */
export function reconcileProgressBatch(
  batch: ProgressBatch | null,
  inFlight: ReadonlySet<string>,
  now: number,
): ProgressBatch | null {
  // A finished batch does not absorb new work: a fresh request is a fresh episode, and folding it
  // into a bar already at its end would leave the bar full while the new read is still outstanding.
  const base = batch && batch.pending.size > 0 ? batch : null;
  if (!base && inFlight.size === 0) return batch;

  const pending = new Map<string, number>();
  let started = base?.started ?? 0;
  let settled = base?.settled ?? 0;
  for (const id of inFlight) {
    const since = base?.pending.get(id);
    if (since === undefined) started += 1;
    pending.set(id, since ?? now);
  }
  if (base) {
    for (const id of base.pending.keys()) {
      if (!inFlight.has(id)) settled += 1;
    }
  }
  return { startedAt: base?.startedAt ?? now, pending, started, settled };
}

export function isProgressBatchComplete(batch: ProgressBatch): boolean {
  return batch.pending.size === 0;
}

/**
 * The batch's estimated share, in [0, 1], including partial credit for pending work.
 *
 * `shouldEstimate` is false under reduced motion: the pending tasks' credit is the bar moving without
 * anything having happened, so a reader who asked for less motion sees only real steps - a task
 * settling.
 */
export function estimateProgress(batch: ProgressBatch, now: number, shouldEstimate = true): number {
  if (batch.started === 0 || isProgressBatchComplete(batch)) return 1;
  let credit = 0;
  if (shouldEstimate) {
    for (const since of batch.pending.values()) {
      credit += PENDING_CREDIT_CAP * (1 - Math.exp(-Math.max(0, now - since) / PENDING_CREDIT_TAU_MS));
    }
  }
  const value = (batch.settled + credit) / batch.started;
  // Strictly below 1 while anything is pending: only the last task settling may fill the bar.
  return Math.min(Math.max(value, PROGRESS_FLOOR), 0.98);
}

/** Whether the batch has lasted long enough to paint; a fast batch never paints at all. */
export function shouldShowProgress(batch: ProgressBatch, now: number): boolean {
  return now - batch.startedAt >= PROGRESS_SHOW_DELAY_MS;
}

/**
 * Moves the drawn value toward the model's value after `elapsedMs`, frame-rate independent.
 *
 * Never backwards: a task joining the batch raises the denominator and lowers the model's value, but
 * a bar that shrinks reads as work being undone. The drawn bar holds until the model passes it again.
 */
export function advanceDrawnProgress(drawn: number, target: number, elapsedMs: number): number {
  if (target <= drawn) return drawn;
  const step = 1 - Math.exp(-Math.max(0, elapsedMs) / PROGRESS_SMOOTHING_TAU_MS);
  const next = drawn + (target - drawn) * step;
  // Snap tiny gaps rather than leaving the drawn fill asymptotically short of its target.
  return target - next < 0.002 ? target : next;
}
