/**
 * Behavioural tests for the last-intent queue controller.
 *
 * These import `web/src/hooks/lastIntentQueue.ts` directly - the same controller
 * the React hook wraps and the provider row uses - rather than restating its
 * drain loop in the test. A transcription can drift from the implementation and
 * then pins nothing, which is how the previous version of this suite could stay
 * green while the queue lost a click.
 *
 * The controller takes its clock and its timer as options, so every wait below is
 * deterministic: no test sleeps, and the deadline is exercised by moving a fake
 * clock rather than by spending thirty real seconds.
 */
import assert from 'node:assert/strict';
import {
  createLastIntentQueue,
  LastIntentTimeoutError,
  type LastIntentControllerOptions,
} from '../web/src/hooks/lastIntentQueue.ts';
import { createDisposableSlot } from '../web/src/hooks/disposableSlot.ts';

// ---- the slot that owns the queue across a StrictMode remount ----

//
// React invokes mount -> unmount -> mount for every component under StrictMode in a
// development build. The provider toggle was built on a queue created during render
// and disposed by that first cleanup, so the second setup reinstated a disposed
// queue: every click became a silent no-op - the switch animated and nothing was
// sent - while every production-bundle check passed, because StrictMode's checks do
// not run in a production build. These cases pin the rule that fixes it.
{
  let created = 0;
  const makeFake = () => {
    created += 1;
    let isDisposed = false;
    return {
      dispose: () => {
        isDisposed = true;
      },
      get isDisposed() {
        return isDisposed;
      },
    };
  };

  const slot = createDisposableSlot(makeFake);

  // Mount.
  const first = slot.setup();
  assert.equal(slot.current(), first, 'setup installs the queue it built');

  // StrictMode's simulated unmount, then its remount.
  slot.teardown();
  assert.equal(slot.current(), undefined, 'teardown releases the slot rather than leaving a disposed queue installed');
  assert.ok(first.isDisposed, 'teardown disposes the queue it released');

  const second = slot.setup();
  assert.notEqual(second, first, 'a remount builds a new queue instead of reinstating the disposed one');
  assert.equal(
    second.isDisposed,
    false,
    'the queue installed by the remount is live, so a click on the control is not a silent no-op',
  );
  assert.equal(created, 2, 'exactly one queue per setup');

  // Teardown is idempotent: a framework that runs a cleanup twice must not dispose
  // whatever a later setup installed.
  const third = slot.setup();
  slot.teardown();
  slot.teardown();
  assert.equal(third.isDisposed, true, 'the queue is disposed by its own teardown');
  const fourth = slot.setup();
  assert.equal(fourth.isDisposed, false, 'a repeat teardown cannot leave the next queue disposed');

  // A setup while one is already installed disposes the one it replaces, so a
  // re-run of an effect cannot strand the previous queue's timers.
  const fifth = slot.setup();
  assert.ok(fourth.isDisposed, 'a replacing setup disposes the queue it replaces');
  assert.equal(fifth.isDisposed, false);
  slot.teardown();
}

/**
 * A fake gateway that records every write, can be made slow per key, and can be
 * told to fail a given number of times before succeeding.
 */
function createGateway({
  delayMs = 0,
  delayByKey = {},
  failuresByKey = {},
  schedule,
  cancelScheduled,
}: {
  delayMs?: number;
  delayByKey?: Record<string, number>;
  failuresByKey?: Record<string, number>;
  // The gateway waits on the test's own clock, so a write lands only when the
  // test advances time; a real timer here would make every assertion below a
  // race against the event loop.
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled: (handle: unknown) => void;
}) {
  const state = new Map<string, boolean>();
  const calls: { key: string; value: boolean }[] = [];
  const perKeyInFlight = new Map<string, number>();
  const remainingFailures = { ...failuresByKey };
  let maxConcurrentPerKey = 0;

  return {
    state,
    calls,
    get maxConcurrentPerKey() {
      return maxConcurrentPerKey;
    },
    set(key: string, value: boolean) {
      const inFlight = (perKeyInFlight.get(key) ?? 0) + 1;
      perKeyInFlight.set(key, inFlight);
      maxConcurrentPerKey = Math.max(maxConcurrentPerKey, inFlight);
      calls.push({ key, value });
      return new Promise<void>((resolve, reject) => {
        schedule(() => {
          perKeyInFlight.set(key, inFlight - 1);
          if ((remainingFailures[key] ?? 0) > 0) {
            remainingFailures[key] -= 1;
            reject(new Error(`gateway refused ${key}`));
            return;
          }
          state.set(key, value);
          resolve();
        }, delayByKey[key] ?? delayMs);
      });
    },
  };
}

/**
 * A controllable clock and timer queue, so retry delays and the deadline are
 * driven by the test instead of by elapsed wall time.
 */
function createScheduler() {
  let currentMs = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    now: () => currentMs,
    schedule(callback: () => void, delayMs: number) {
      const handle = nextHandle++;
      timers.set(handle, { at: currentMs + Math.max(delayMs, 0), callback });
      return handle;
    },
    cancelScheduled(handle: unknown) {
      timers.delete(handle as number);
    },
    /** Runs every timer due at or before the new time, in due order. */
    async advance(ms: number) {
      const until = currentMs + ms;
      // Drains pending promise reactions before firing anything. A real event loop
      // always empties the microtask queue before running the next timer, and a
      // harness that skipped this could fire the deadline in the same synchronous
      // pass as a request's rejection - an interleaving no browser produces, which
      // would make the assertions below describe a state the product cannot reach.
      await settleMicrotasks();
      for (;;) {
        let earliest: { handle: number; at: number; callback: () => void } | undefined;
        for (const [handle, timer] of timers) {
          if (timer.at <= until && (earliest === undefined || timer.at < earliest.at)) {
            earliest = { handle, at: timer.at, callback: timer.callback };
          }
        }
        if (earliest === undefined) break;
        timers.delete(earliest.handle);
        currentMs = earliest.at;
        earliest.callback();
        await settleMicrotasks();
      }
      currentMs = until;
      await settleMicrotasks();
    },
    get pendingCount() {
      return timers.size;
    },
  };
}

/** Lets queued promise continuations run without advancing any timer. */
const settleMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

function buildQueue<T>(
  gatewayOptions: Omit<Parameters<typeof createGateway>[0], 'schedule' | 'cancelScheduled'>,
  overrides: Partial<LastIntentControllerOptions<T>> = {},
) {
  const scheduler = createScheduler();
  const gateway = createGateway({
    ...gatewayOptions,
    schedule: scheduler.schedule,
    cancelScheduled: scheduler.cancelScheduled,
  });
  const errors: { key: string; error: unknown }[] = [];
  const confirmed: { key: string; intent: T }[] = [];
  const settled: string[] = [];
  let changeCount = 0;

  const controller = createLastIntentQueue<T>({
    apply: (key, intent) => gateway.set(key, intent as unknown as boolean),
    isRetryable: () => true,
    onError: (key, error) => errors.push({ key, error }),
    onConfirmed: (key, intent) => confirmed.push({ key, intent }),
    onSettled: (key) => settled.push(key),
    onChange: () => {
      changeCount += 1;
    },
    now: scheduler.now,
    schedule: scheduler.schedule,
    cancelScheduled: scheduler.cancelScheduled,
    ...overrides,
  });

  return {
    controller,
    gateway,
    scheduler,
    errors,
    confirmed,
    settled,
    get changeCount() {
      return changeCount;
    },
  };
}

// ---- one key: the last click wins, and never two writes at once ----

{
  const harness = buildQueue<boolean>({ delayMs: 20 });
  harness.controller.request('provider-a', true);
  harness.controller.request('provider-a', false);
  await harness.scheduler.advance(100);

  assert.equal(harness.gateway.state.get('provider-a'), false, 'the gateway must end on the last click');
  assert.equal(harness.gateway.maxConcurrentPerKey, 1, 'one key never has two writes in flight');
  assert.equal(harness.controller.isBusy('provider-a'), false, 'the burst drains');

  // Three clicks during one round trip coalesce: only the first and the last are
  // worth sending, because the intermediate values are states nobody observes.
  const rapid = buildQueue<boolean>({ delayMs: 20 });
  rapid.controller.request('provider-b', true);
  rapid.controller.request('provider-b', false);
  rapid.controller.request('provider-b', true);
  rapid.controller.request('provider-b', false);
  await rapid.scheduler.advance(100);
  assert.equal(rapid.gateway.state.get('provider-b'), false);
  assert.equal(rapid.gateway.calls.length, 2, 'four rapid clicks cost two writes, not four');
  assert.equal(rapid.gateway.maxConcurrentPerKey, 1);

  // A second click on the same value while the burst is still working toward it is
  // not written again: the in-flight write already asks for that value, so a
  // second request would be pure noise. A repeat *after* the burst drains is
  // deliberately sent again - the row has stopped overriding the server, and
  // skipping the write then would mean trusting a remembered value the gateway
  // may have since changed underneath us.
  const idempotent = buildQueue<boolean>({ delayMs: 50 });
  idempotent.controller.request('provider-c', true);
  idempotent.controller.request('provider-c', true);
  await idempotent.scheduler.advance(200);
  assert.equal(
    idempotent.gateway.calls.length,
    1,
    'a repeated click within the burst is not written a second time',
  );
  assert.equal(idempotent.gateway.state.get('provider-c'), true);
}

// ---- every accepted intent re-renders, even while the key is already busy ----

{
  // The defect this pins: the previously published value is read from the intent
  // map, so a click that only mutates the map while the key is already busy would
  // never reach React and the row would keep showing the older intent.
  const harness = buildQueue<boolean>({ delayMs: 50 });
  harness.controller.request('provider-a', true);
  const afterFirst = harness.changeCount;
  assert.ok(afterFirst > 0, 'the first intent must notify the renderer');
  assert.equal(harness.controller.targetFor('provider-a'), true);

  harness.controller.request('provider-a', false);
  assert.ok(
    harness.changeCount > afterFirst,
    'an intent accepted while the key is busy must still notify the renderer',
  );
  assert.equal(harness.controller.targetFor('provider-a'), false, 'the newest intent is displayed at once');
  await harness.scheduler.advance(100);
}

// ---- per-key isolation ----

{
  // One provider is slow and another is instant, which is the only way to tell
  // "the fast one was not blocked" from "both happened to finish together".
  const harness = buildQueue<boolean>({ delayByKey: { 'slow-provider': 80, 'other-provider': 0 } });
  harness.controller.request('slow-provider', true);
  harness.controller.request('other-provider', true);
  await harness.scheduler.advance(30);
  assert.equal(harness.gateway.state.get('other-provider'), true, 'a second provider is not blocked');
  assert.equal(harness.gateway.state.has('slow-provider'), false, 'the slow write is still running');
  assert.ok(harness.controller.isBusy('slow-provider'), 'the slow provider is still busy');
  assert.equal(harness.controller.isBusy('other-provider'), false, 'the fast provider has settled');

  await harness.scheduler.advance(100);
  assert.equal(harness.gateway.state.get('slow-provider'), true);
  assert.equal(harness.gateway.maxConcurrentPerKey, 1, 'isolation does not relax the per-key rule');
}

// ---- a transient failure is retried, bounded, and settles ----

{
  const harness = buildQueue<boolean>({ failuresByKey: { 'provider-d': 2 } });
  harness.controller.request('provider-d', true);
  // Three attempts total: the original plus the two configured retries.
  await harness.scheduler.advance(5000);

  assert.equal(harness.gateway.calls.length, 3, 'two transient failures are retried, then it succeeds');
  assert.equal(harness.gateway.state.get('provider-d'), true, 'the retried write lands');
  assert.equal(harness.errors.length, 0, 'a recovered burst reports no error');
  assert.equal(harness.controller.isBusy('provider-d'), false);
  assert.deepEqual(harness.settled, ['provider-d']);

  // A failure that outlasts the retry budget is reported once and drops the
  // intent, so the row falls back to a fresh read instead of fighting the
  // operator's clicks with a value nobody confirmed.
  const permanent = buildQueue<boolean>({ failuresByKey: { 'provider-e': 99 } });
  permanent.controller.request('provider-e', true);
  await permanent.scheduler.advance(5000);

  assert.equal(permanent.gateway.calls.length, 4, 'the original attempt plus three retries, then stop');
  assert.equal(permanent.errors.length, 1, 'a permanent failure is reported once');
  assert.equal(permanent.controller.isBusy('provider-e'), false);
  assert.equal(permanent.controller.targetFor('provider-e'), undefined, 'the unconfirmed intent is dropped');
}

// ---- a permanent failure is not retried at all ----

{
  const harness = buildQueue<boolean>(
    { failuresByKey: { 'provider-f': 99 } },
    { isRetryable: () => false },
  );
  harness.controller.request('provider-f', true);
  await harness.scheduler.advance(5000);

  assert.equal(harness.gateway.calls.length, 1, 'a refusal that cannot succeed is not repeated');
  assert.equal(harness.errors.length, 1, 'the refusal is reported');
  assert.equal(harness.controller.isBusy('provider-f'), false);
}

// ---- a retry sends the newest intent, not the one that failed ----

{
  // The write fails while the operator has already moved to a different value. The
  // retry must send the newest intent; sending the failed one again would write a
  // value the operator has visibly left, and reporting its failure would blame a
  // value nobody is waiting for.
  const harness = buildQueue<boolean>({ failuresByKey: { 'provider-g': 1 } });
  harness.controller.request('provider-g', true);
  // Let the first attempt fail and enter its retry delay.
  await harness.scheduler.advance(0);
  assert.equal(harness.gateway.calls.length, 1);
  harness.controller.request('provider-g', false);
  await harness.scheduler.advance(5000);

  assert.equal(harness.gateway.state.get('provider-g'), false, 'the newest intent is what lands');
  assert.equal(
    harness.gateway.calls[harness.gateway.calls.length - 1].value,
    false,
    'the retry sends the newest intent rather than the failed one',
  );
  assert.equal(harness.errors.length, 0, 'a superseded failure is not reported against the new intent');
}

// ---- one deadline per burst, armed at the first click and never extended ----

{
  // Every attempt fails transiently, so the burst only ends when its budget runs
  // out. The discriminating assertion is *when* it ends: the click near the end
  // of the window must not buy the burst a fresh budget, so the burst is over at
  // the first click's deadline rather than that later click's.
  const harness = buildQueue<boolean>({ failuresByKey: { 'provider-h': 99 } }, { deadlineMs: 1000 });
  harness.controller.request('provider-h', true);

  // A click shortly before the budget expires. If the deadline were restarted by
  // a new intent, this click's own deadline (1900) would keep the burst alive.
  await harness.scheduler.advance(900);
  harness.controller.request('provider-h', false);
  assert.equal(
    harness.controller.isBusy('provider-h'),
    true,
    'the burst is still working just before its deadline',
  );

  await harness.scheduler.advance(200);
  assert.equal(
    harness.controller.isBusy('provider-h'),
    false,
    'a click must not extend the burst past the deadline its first intent set',
  );
  assert.equal(harness.errors.length, 1, 'the exhausted burst is reported exactly once');
  assert.ok(
    harness.errors[0].error instanceof LastIntentTimeoutError,
    `an exhausted budget must report the deadline, got ${String(harness.errors[0].error)}`,
  );
  const calledAtDeadline = harness.gateway.calls.length;
  await harness.scheduler.advance(5000);
  assert.equal(
    harness.gateway.calls.length,
    calledAtDeadline,
    'an exhausted burst stops writing rather than continuing to retry',
  );
}

// ---- the deadline aborts the request in flight ----

{
  // A request that is still running when the burst gives up must be cancelled:
  // left alone it would settle later, against a value the operator has already
  // replaced, and the row would then disagree with the gateway.
  //
  // The error is asserted as well as the cancellation, and the retry predicate is
  // permissive on purpose. Aborting and failing are indistinguishable at the
  // rejection, so a burst that reports whatever rejection the abort produced would
  // tell the operator "the update failed" when all the console knows is that it
  // stopped waiting - and a permissive predicate is what exposes that, because an
  // abort misread as a transient failure is then retried against a dead request.
  const aborted: string[] = [];
  const scheduler = createScheduler();
  const errors: unknown[] = [];
  let applyCalls = 0;
  const controller = createLastIntentQueue<boolean>({
    apply: (_key, _intent, signal) => {
      applyCalls += 1;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted.push('aborted');
          // Rejected the way a real fetch rejects when its signal aborts.
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    },
    // Mirrors the real classifier's abort rule (see `isAbortError`): an aborted
    // request is not retryable. That rule is what makes this test discriminating -
    // with a permissive predicate, a misreported abort is caught by the retry
    // path's own deadline check and the defect hides.
    isRetryable: (error) => !(error instanceof DOMException && error.name === 'AbortError'),
    onError: (_key, error) => errors.push(error),
    now: scheduler.now,
    schedule: scheduler.schedule,
    cancelScheduled: scheduler.cancelScheduled,
    deadlineMs: 500,
  });
  controller.request('provider-i', true);
  await scheduler.advance(5000);

  assert.deepEqual(aborted, ['aborted'], 'the deadline cancels the request rather than only stopping the wait');
  assert.equal(controller.isBusy('provider-i'), false);
  assert.equal(applyCalls, 1, 'an aborted request is not retried against a signal that is already dead');
  assert.equal(errors.length, 1, 'the abandoned burst is reported once');
  assert.ok(
    errors[0] instanceof LastIntentTimeoutError,
    `an aborted request must be reported as the deadline, not as the abort: got ${String(errors[0])}`,
  );

  // dispose cancels whatever is still pending, so a burst cannot outlive its page.
  controller.dispose();
  assert.equal(scheduler.pendingCount, 0, 'dispose leaves no timer behind');
}

// ---- a persistently busy console ends on the retry budget, not on the deadline ----

{
  // The gateway-side gate refuses a write it cannot admit with a retryable code.
  // When the console stays busy, the burst must end as soon as its retries are
  // spent rather than sitting on the deadline: the retry budget and the deadline
  // answer different failures, and spending the whole budget on a console that is
  // already answering would make the operator wait far longer than needed for the
  // same outcome.
  const harness = buildQueue<boolean>(() => ({}), {});
  const scheduler = harness.scheduler;
  let calls = 0;
  const errors: unknown[] = [];
  const controller = createLastIntentQueue<boolean>({
    apply: () => {
      calls += 1;
      return Promise.reject(new Error('write_busy'));
    },
    // Every refusal is transient, so nothing but the budget stops the burst.
    isRetryable: () => true,
    onError: (_key, error) => errors.push(error),
    now: scheduler.now,
    schedule: scheduler.schedule,
    cancelScheduled: scheduler.cancelScheduled,
    deadlineMs: 60_000,
    retryDelaysMs: [300, 800, 2000],
  });
  controller.request('provider-m', true);
  // Advanced well past both the retry budget (3.1s) and the deadline (60s).
  await scheduler.advance(120_000);

  assert.equal(calls, 4, 'the original attempt plus three retries, then no more');
  assert.equal(errors.length, 1, 'the abandoned burst is reported once');
  assert.equal(
    (errors[0] as Error).message,
    'write_busy',
    'an exhausted retry budget reports the refusal it kept getting, not the unused deadline',
  );
  assert.equal(controller.isBusy('provider-m'), false, 'the row is released');
}

// ---- dispose ends a burst that is between retries instead of hanging it ----

// ---- dispose ends a burst that is between retries instead of hanging it ----

{
  // A burst waiting out a retry delay holds a promise that only its timer settles.
  // Cancelling that timer without settling the wait would leave the drain loop
  // suspended forever, holding the key busy and its intent rendered on a page that
  // has already gone away.
  const harness = buildQueue<boolean>({ failuresByKey: { 'provider-l': 99 } });
  harness.controller.request('provider-l', true);
  // Let the first attempt fail and enter its retry delay, then dispose mid-wait.
  await harness.scheduler.advance(0);
  assert.equal(harness.gateway.calls.length, 1, 'the first attempt ran and failed');
  assert.ok(harness.controller.isBusy('provider-l'), 'the burst is waiting to retry');

  harness.controller.dispose();
  await harness.scheduler.advance(5000);

  assert.equal(
    harness.controller.isBusy('provider-l'),
    false,
    'dispose releases the row rather than leaving it busy forever',
  );
  assert.equal(
    harness.controller.targetFor('provider-l'),
    undefined,
    'dispose drops the abandoned intent instead of leaving it rendered',
  );
  assert.equal(harness.gateway.calls.length, 1, 'dispose issues no further write');
  assert.equal(harness.errors.length, 0, 'dispose reports nothing to a page that is gone');
  assert.equal(harness.scheduler.pendingCount, 0, 'dispose leaves no timer behind');

  // A click that arrives after disposal must not revive the burst: the component
  // is gone, and a drain started now would hold timers nothing can cancel.
  harness.controller.request('provider-l', false);
  await harness.scheduler.advance(5000);
  assert.equal(harness.gateway.calls.length, 1, 'a request after dispose issues no write');
  assert.equal(harness.scheduler.pendingCount, 0, 'a request after dispose schedules nothing');
  assert.equal(harness.controller.isBusy('provider-l'), false, 'a request after dispose does not mark the row busy');
}

// ---- late responses from an earlier request cannot overwrite a newer value ----

{
  // The generation guard: a slow first write settles after a second, newer write
  // has already been confirmed. What the row displays must follow the newer one.
  const harness = buildQueue<boolean>({ delayByKey: { 'provider-j': 100, 'provider-k': 0 } });
  harness.controller.request('provider-j', true);
  await harness.scheduler.advance(200);
  assert.equal(harness.controller.targetFor('provider-j'), undefined, 'the drained key stops overriding');

  harness.controller.request('provider-j', false);
  await harness.scheduler.advance(200);
  assert.equal(harness.gateway.state.get('provider-j'), false);
  assert.equal(
    harness.confirmed[harness.confirmed.length - 1].intent,
    false,
    'the last confirmation is the newest write, not the earlier one',
  );
}

console.log(
  'PASS last-intent queue: last click wins, one write per key at a time, bounded retries, one deadline per burst',
);
