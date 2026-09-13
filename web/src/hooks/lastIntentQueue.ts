/**
 * A framework-free, coalescing last-intent queue for one write per key.
 *
 * The problem it solves: a control writes to a remote gateway and only learns the
 * new state by re-reading afterwards. Between the write landing and the re-read
 * arriving, a second click is very likely - the operator clicks, sees nothing
 * change yet, and clicks again. The two naive handlings both lose:
 *
 *   - Firing both requests leaves them racing. The gateway applies them in
 *     arrival order, which is not necessarily click order, and whichever read
 *     resolves last decides what the screen shows. The result is a control that
 *     disagrees with the gateway, which is the one outcome that must not happen.
 *   - Dropping the second request while the first is in flight (or locking every
 *     row until it settles) makes the second click a no-op, so the final state is
 *     whatever the first click asked for - the opposite of the operator's last
 *     intent.
 *
 * So a key has at most one request in flight, and a click during that window is
 * *remembered* rather than dropped or sent. When the in-flight request settles,
 * whatever the key remembers now is sent. Three clicks during one round trip
 * therefore cost one extra request, never three - the intermediate values are
 * states nobody wants to observe - and no two requests for one key are ever in
 * flight together, so they cannot land out of order.
 *
 * Serialisation is per key: an update to one provider never blocks another.
 *
 * Two additions sit on top of that, both driven by the same rule - a write that
 * the operator cannot see must not be reported as settled when it is not:
 *
 *   - A transient failure is retried a bounded number of times. The delay is
 *     short, and before each retry the operator's newest intent is re-read, so a
 *     click that arrived during the wait is what gets sent rather than a value
 *     the operator has already moved past.
 *   - The whole burst is bounded by one deadline, armed when the burst's first
 *     intent is recorded and never restarted by a retry or a later click. When
 *     it expires the in-flight request is aborted and the burst is reported as
 *     timed out, because an aborted request proves only that this client stopped
 *     waiting - not that the gateway did not commit.
 *
 * The controller owns no React state and no timers outside the ones it is given,
 * so its behaviour is pinned by direct tests rather than by re-describing it.
 */

/** Raised when a burst exhausts its deadline. Distinguishable from a gateway error. */
export class LastIntentTimeoutError extends Error {
  constructor(key: string) {
    super(`timed out waiting for the write of ${key} to settle`);
    this.name = 'LastIntentTimeoutError';
  }
}

export interface LastIntentControllerOptions<T> {
  /** Applies one intent to the server. The signal aborts the request at the deadline. */
  apply: (key: string, intent: T, signal: AbortSignal) => Promise<void>;
  /** Whether two intents are the same value. */
  equals?: (left: T, right: T) => boolean;
  /**
   * Whether a failure is worth retrying. Defaults to accepting nothing, so a
   * caller that does not classify its errors gets no retries rather than retries
   * of writes that cannot succeed.
   */
  isRetryable?: (error: unknown) => boolean;
  /** Reports a terminal failure so the row can say what went wrong. */
  onError?: (key: string, error: unknown) => void;
  /**
   * Reports one confirmed write, before the key is released. The row's displayed
   * state is republished here rather than by re-reading the list, so a confirmed
   * value is never briefly replaced by an older one.
   */
  onConfirmed?: (key: string, intent: T) => void;
  /** Runs once a key's burst has drained, whether it succeeded or failed. */
  onSettled?: (key: string) => void;
  /** Runs whenever a key's busy state or newest intent changes. */
  onChange?: () => void;
  /** The whole-burst budget, measured from the first intent of the burst. */
  deadlineMs?: number;
  /** Delays between retry attempts; the attempt count is the array's length. */
  retryDelaysMs?: readonly number[];
  /** Injected clock, so the deadline is testable without waiting for it. */
  now?: () => number;
  /** Injected timer, so retry delays are testable without waiting for them. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

export interface LastIntentQueueController<T> {
  /** Records the operator's newest intent for a key and starts draining it. */
  request: (key: string, intent: T) => void;
  /**
   * The value the control should display for a key: the operator's newest intent
   * while the burst is working toward it, and nothing once the server holds it.
   * A caller renders `targetFor(key) ?? serverValue`, so a click is visible on
   * the frame it happened instead of flicking back to the old state while the
   * request is in flight.
   */
  targetFor: (key: string) => T | undefined;
  /** Whether a key still has work queued or in flight. */
  isBusy: (key: string) => boolean;
  /** Releases every pending timer. The queue is not usable afterwards. */
  dispose: () => void;
}

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [300, 800, 2000];

export function createLastIntentQueue<T>({
  apply,
  equals = Object.is,
  isRetryable,
  onError,
  onConfirmed,
  onSettled,
  onChange,
  deadlineMs = DEFAULT_DEADLINE_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  now = () => Date.now(),
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelScheduled = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: LastIntentControllerOptions<T>): LastIntentQueueController<T> {
  // The newest intent each key is working toward, and the last value a write
  // confirmed *during the current burst*. Both are Maps rather than state because
  // the drain loop reads them synchronously between awaits.
  //
  // The confirmed side is scoped to one burst on purpose. Remembering it across
  // drains would let a click be dropped whenever the server changed underneath -
  // someone else toggling the same provider - because the recorded value would
  // still look "already applied". Clearing it when the burst drains means the
  // only write avoided is the genuinely redundant one: the same value the burst
  // just sent.
  const target = new Map<string, T>();
  const confirmed = new Map<string, T>();
  const draining = new Set<string>();
  const busy = new Set<string>();
  // When the current burst of each key must be abandoned, and how many retry
  // attempts it has already spent. Both are per burst, so neither a later click
  // nor a retry extends the budget.
  const burstDeadline = new Map<string, number>();
  const attempts = new Map<string, number>();
  const inFlight = new Map<string, AbortController>();
  // Every waiting timer, so dispose can end a burst that is between attempts,
  // together with the resolvers of those waits. Cancelling a timer alone would
  // leave the drain loop suspended on a promise that can never settle.
  const pendingTimers = new Set<unknown>();
  const pendingWaits = new Set<() => void>();
  let isDisposed = false;

  const wait = (delayMs: number) =>
    new Promise<void>((resolve) => {
      // Exactly one of these runs: the timer resolves the wait, or dispose does.
      const settle = () => {
        pendingWaits.delete(settle);
        resolve();
      };
      const handle = schedule(() => {
        pendingTimers.delete(handle);
        settle();
      }, delayMs);
      pendingTimers.add(handle);
      pendingWaits.add(settle);
    });

  const remainingMs = (key: string) => {
    const deadline = burstDeadline.get(key);
    return deadline === undefined ? deadlineMs : deadline - now();
  };

  const release = (key: string) => {
    if (busy.has(key)) {
      busy.delete(key);
      onChange?.();
    }
  };

  const drain = async (key: string): Promise<void> => {
    if (draining.has(key)) return;
    draining.add(key);
    let terminalError: unknown;
    try {
      for (;;) {
        // Disposal ends the burst instead of continuing it: the owning component
        // is gone, so a further write would be one nobody is watching and a
        // reported failure would be shown for a page that no longer exists.
        if (isDisposed) return;
        const intent = target.get(key);
        // Nothing asked for, so this key is done and the control can fall back to
        // whatever the server reports.
        if (intent === undefined) break;
        const settled = confirmed.get(key);
        if (settled !== undefined && equals(settled, intent)) {
          // The gateway already holds the newest intent, so sending it again
          // would be a redundant write.
          target.delete(key);
          break;
        }
        const budget = remainingMs(key);
        if (budget <= 0) {
          terminalError = new LastIntentTimeoutError(key);
          break;
        }
        const controller = new AbortController();
        inFlight.set(key, controller);
        // The deadline aborts the request rather than only stopping this wait: a
        // request left running after the queue gave up would settle later against
        // a value the operator has already replaced. `abortedByDeadline` records
        // that the cancellation was ours, because the rejection an abort produces
        // is otherwise indistinguishable from a transport failure and would be
        // reported as one - telling the operator the update failed when all this
        // console knows is that it stopped waiting.
        let abortedByDeadline = false;
        const abortTimer = schedule(() => {
          abortedByDeadline = true;
          controller.abort();
        }, budget);
        pendingTimers.add(abortTimer);
        try {
          await apply(key, intent, controller.signal);
        } catch (error) {
          cancelScheduled(abortTimer);
          pendingTimers.delete(abortTimer);
          inFlight.delete(key);
          // Checked before everything else: this cancellation is ours, so the
          // rejection says nothing about the gateway, and continuing would mean
          // issuing a request against a signal the deadline already killed. It is
          // also checked before the supersede branch, which would otherwise send a
          // new request that is born past the deadline.
          if (abortedByDeadline) {
            terminalError = new LastIntentTimeoutError(key);
            break;
          }
          // A click that landed while this write was failing is the operator's
          // newest intent, so it wins: discarding it here would be the lost click
          // this queue exists to prevent, and reporting the old failure would
          // blame a value nobody is waiting for any more.
          if (target.get(key) !== undefined && !equals(target.get(key) as T, intent)) {
            attempts.delete(key);
            continue;
          }
          if (!isRetryable?.(error)) {
            terminalError = error;
            break;
          }
          const spent = attempts.get(key) ?? 0;
          if (spent >= retryDelaysMs.length) {
            terminalError = error;
            break;
          }
          attempts.set(key, spent + 1);
          width: {
            // Never sleep past the deadline; the request after the sleep would be
            // refused anyway, and waiting out the remainder would only delay the
            // report the operator is owed.
            const remaining = remainingMs(key);
            if (remaining <= 0) {
              terminalError = new LastIntentTimeoutError(key);
              break width;
            }
            await wait(Math.min(retryDelaysMs[spent], remaining));
          }
          continue;
        }
        cancelScheduled(abortTimer);
        pendingTimers.delete(abortTimer);
        inFlight.delete(key);
        attempts.delete(key);
        // Published before the key is released, so the row never renders a
        // released key against a server value that predates this write.
        confirmed.set(key, intent);
        onConfirmed?.(key, intent);
      }
    } finally {
      inFlight.delete(key);
      draining.delete(key);
      // Scoped to this burst; see the note where the map is declared.
      confirmed.delete(key);
      burstDeadline.delete(key);
      attempts.delete(key);
      // Nothing is reported after disposal: there is no longer a page to report
      // it to, and the rows were released rather than left rendering an intent
      // the burst abandoned.
      if (isDisposed) {
        target.delete(key);
        release(key);
        return;
      }
      if (terminalError !== undefined) {
        // Both values are dropped rather than kept: the control falls back to a
        // fresh read of the gateway, so a failing server cannot leave the queue
        // fighting the operator's clicks with a value nobody confirmed.
        target.delete(key);
        onError?.(key, terminalError);
      }
      release(key);
      onSettled?.(key);
      // A click that landed after the loop's last check but before this point
      // finds no drainer running, so it is picked up here.
      if (target.has(key)) void drain(key);
    }
  };

  const request = (key: string, intent: T) => {
    // A disposed queue belongs to a component that is gone. Accepting the intent
    // would start a drain whose timers nothing will ever cancel, which is exactly
    // the leak dispose exists to prevent.
    if (isDisposed) return;
    // The burst's budget starts at its first intent and is never restarted: a
    // click that keeps moving the deadline would let a stuck key stay pending
    // forever, which is the failure the deadline exists to end.
    if (!burstDeadline.has(key)) {
      burstDeadline.set(key, now() + deadlineMs);
    }
    target.set(key, intent);
    if (!busy.has(key)) {
      busy.add(key);
    }
    // Reported on every accepted intent, not only on a busy transition: the
    // displayed value comes from the intent map, and a reader that is not told
    // about the change would keep rendering the previous value.
    onChange?.();
    void drain(key);
  };

  return {
    request,
    targetFor: (key) => target.get(key),
    isBusy: (key) => busy.has(key),
    dispose: () => {
      isDisposed = true;
      for (const handle of pendingTimers) cancelScheduled(handle);
      pendingTimers.clear();
      // Released so a drain suspended between retries can finish its loop instead
      // of hanging on a promise that would never settle.
      for (const settle of pendingWaits) settle();
      pendingWaits.clear();
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    },
  };
}
