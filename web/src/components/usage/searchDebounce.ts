/**
 * The request list's debounced search box, without React.
 *
 * The rule this encodes is not "wait 350ms before committing". It is that a
 * keystroke belongs to the view it was typed against, and three different events
 * can invalidate it first:
 *
 *   - The committed value changed from outside this box: hydration from the saved
 *     view, Back/Forward, a drill-down link, a removed chip. The stale text would
 *     otherwise be written onto the view the operator just navigated to.
 *   - A clear-all ran. This is the case the committed value cannot detect at all,
 *     because the box is usually already empty when the clear happens - nothing
 *     observable changes and a queued keystroke would land after it. That is what
 *     an explicit `invalidate()` is for.
 *   - The component was disposed.
 *
 * The commit callback is read at fire time rather than captured when the timer was
 * scheduled. A commit builds its URL from the parameters of the render it was
 * created in, so a filter changed during the debounce window would otherwise be
 * erased when the queued keystroke fired against the older snapshot. That is also
 * why the callback is passed through `commit` on every call rather than in the
 * constructor: the caller is a React render, and this controller must not hold a
 * closure over the first one.
 *
 * `generation` is what makes `invalidate()` cover the window between the request
 * to reset and the effect that would cancel the timer: the scheduled callback
 * compares the generation it was scheduled under, so a reset that arrived after
 * the timer fired but before the commit ran still suppresses the write.
 */

export interface SearchDebounceOptions {
  /** Milliseconds of inactivity before the typed value is committed. */
  delayMs: number;
  /** Injected scheduler, so the debounce is testable without waiting for it. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

export interface SearchDebounceController {
  /**
   * Records a keystroke. `commit` is invoked with the trimmed value once the
   * window elapses, unless something invalidated the keystroke first.
   */
  change: (next: string, commit: (value: string) => void) => void;
  /**
   * Adopts a committed value that arrived from outside this box, and cancels
   * whatever this box had queued against the previous one.
   */
  sync: (committed: string) => void;
  /**
   * Cancels queued work and suppresses an already-fired callback. Callers use it
   * for the events the committed value cannot signal: a clear-all, or a URL change
   * this page did not write.
   */
  invalidate: () => void;
  /** The value this box currently believes is committed. */
  committed: () => string;
  /** Releases the pending timer. The controller is not usable afterwards. */
  dispose: () => void;
}

export function createSearchDebounce({
  delayMs,
  schedule = (callback, ms) => setTimeout(callback, ms),
  cancelScheduled = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: SearchDebounceOptions): SearchDebounceController {
  let handle: unknown;
  let committed = '';
  // Incremented by every invalidation, so a callback that was already fired but
  // not yet run can tell that the view it belonged to is gone.
  let generation = 0;
  let isDisposed = false;

  const cancelPending = () => {
    if (handle !== undefined) {
      cancelScheduled(handle);
      handle = undefined;
    }
  };

  return {
    change: (next, commit) => {
      if (isDisposed) return;
      cancelPending();
      const trimmed = next.trim();
      // Typing back to the committed value schedules nothing: there is no write
      // to make, and leaving a timer armed would commit a value the URL already
      // holds.
      if (trimmed === committed) return;
      const scheduledUnder = generation;
      handle = schedule(() => {
        handle = undefined;
        if (generation !== scheduledUnder) return;
        commit(trimmed);
      }, delayMs);
    },
    sync: (value) => {
      committed = value;
      // Cancelled without advancing the generation: this is the value the queue
      // was waiting for, so dropping the pending commit is correct, while an
      // invalidation that arrives later must still be able to kill a callback
      // that is already on its way.
      cancelPending();
    },
    invalidate: () => {
      generation += 1;
      cancelPending();
    },
    committed: () => committed,
    dispose: () => {
      isDisposed = true;
      generation += 1;
      cancelPending();
    },
  };
}
