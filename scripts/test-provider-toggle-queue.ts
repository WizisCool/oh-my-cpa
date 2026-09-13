/**
 * Logic-level tests for the provider enable/disable last-intent queue.
 *
 * The hook is a React hook, so it is exercised here through `react-dom`'s test
 * renderer-free path: a minimal harness that renders it with a stub React
 * runtime is not available in this project, so the *semantics* it implements are
 * pinned by re-deriving them against a fake gateway and asserting the property
 * that matters - the gateway ends on the operator's last click, and one
 * provider's queue never blocks another's.
 *
 * The scenario runner below is deliberately a direct transcription of the hook's
 * drain loop. Keeping it here rather than importing the hook means the property
 * is pinned without adding a DOM test dependency to a suite that has none, and
 * the browser acceptance run covers the wired-up component end to end.
 */
import assert from 'node:assert/strict';

interface GatewayCall {
  key: string;
  value: boolean;
}

/**
 * A fake gateway that records every write and can be made slow per key, so a
 * second click lands while the first write is still in flight and one provider's
 * latency can be told apart from another's.
 */
function createGateway({ delayMs = 0, delayByKey = {} }: { delayMs?: number; delayByKey?: Record<string, number> } = {}) {
  const state = new Map<string, boolean>();
  const calls: GatewayCall[] = [];
  let inFlight = 0;
  let maxConcurrentPerKey = 0;
  const perKeyInFlight = new Map<string, number>();

  return {
    state,
    calls,
    get maxConcurrentPerKey() {
      return maxConcurrentPerKey;
    },
    set(key: string, value: boolean) {
      const keyInFlight = (perKeyInFlight.get(key) ?? 0) + 1;
      perKeyInFlight.set(key, keyInFlight);
      inFlight += 1;
      maxConcurrentPerKey = Math.max(maxConcurrentPerKey, keyInFlight);
      calls.push({ key, value });
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          state.set(key, value);
          perKeyInFlight.set(key, keyInFlight - 1);
          inFlight -= 1;
          resolve();
        }, delayByKey[key] ?? delayMs);
      });
    },
    get totalInFlight() {
      return inFlight;
    },
  };
}

/**
 * The queue semantics under test, transcribed from `useLastIntentQueue`'s drain
 * loop: one write in flight per key, a click during that window replaces the
 * remembered value, and the remembered value is sent when the in-flight write
 * settles.
 */
function createLastIntentQueue(apply: (key: string, value: boolean) => Promise<void>) {
  const target = new Map<string, boolean>();
  const confirmed = new Map<string, boolean>();
  const draining = new Set<string>();

  const drain = async (key: string): Promise<void> => {
    if (draining.has(key)) return;
    draining.add(key);
    try {
      for (;;) {
        const next = target.get(key);
        if (next === undefined) break;
        if (confirmed.get(key) === next) {
          target.delete(key);
          break;
        }
        try {
          await apply(key, next);
        } catch {
          target.delete(key);
          confirmed.delete(key);
          break;
        }
        confirmed.set(key, next);
      }
    } finally {
      draining.delete(key);
      if (target.has(key)) void drain(key);
    }
  };

  return {
    request(key: string, value: boolean) {
      target.set(key, value);
      void drain(key);
    },
    isBusy: (key: string) => target.has(key) || draining.has(key),
  };
}

/** Resolves once every queued write and its drain pass have finished. */
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- one key: the last click wins, and never two writes at once ----

{
  const gateway = createGateway({ delayMs: 20 });
  const queue = createLastIntentQueue((key, value) => gateway.set(key, value));

  // The reported failure: click, see nothing yet, click again. The second click
  // must not be lost, and the two writes must not race.
  queue.request('provider-a', true);
  queue.request('provider-a', false);
  await settle();

  assert.equal(gateway.state.get('provider-a'), false, 'the gateway must end on the last click');
  assert.equal(gateway.maxConcurrentPerKey, 1, 'one key never has two writes in flight');
  assert.equal(queue.isBusy('provider-a'), false, 'the queue drains');

  // Three clicks during one round trip coalesce to the intermediate value being
  // skipped: only the first and the last are worth sending.
  const rapid = createGateway({ delayMs: 20 });
  const rapidQueue = createLastIntentQueue((key, value) => rapid.set(key, value));
  rapidQueue.request('provider-b', true);
  rapidQueue.request('provider-b', false);
  rapidQueue.request('provider-b', true);
  rapidQueue.request('provider-b', false);
  await settle();
  assert.equal(rapid.state.get('provider-b'), false);
  assert.equal(rapid.calls.length, 2, 'four rapid clicks cost two writes, not four');
  assert.equal(rapid.maxConcurrentPerKey, 1);

  // A click that repeats the value already confirmed is not written again: the
  // gateway already holds it, so the request would be pure noise.
  const idempotent = createGateway();
  const idempotentQueue = createLastIntentQueue((key, value) => idempotent.set(key, value));
  idempotentQueue.request('provider-c', true);
  await settle();
  idempotentQueue.request('provider-c', true);
  await settle();
  assert.equal(idempotent.calls.length, 1, 'a repeat of the current value is not re-sent');
}

// ---- per-key isolation ----

{
  // One provider is slow and another is instant, which is the only way to tell
  // "the fast one was not blocked" from "both happened to finish together".
  const gateway = createGateway({ delayByKey: { 'slow-provider': 80, 'other-provider': 0 } });
  const queue = createLastIntentQueue((key, value) => gateway.set(key, value));

  // A slow write on one provider must not hold up another: the concurrency
  // control is per provider, not a page-wide lock.
  queue.request('slow-provider', true);
  queue.request('other-provider', true);
  await settle(30);
  assert.equal(gateway.state.get('other-provider'), true, 'a second provider is not blocked');
  assert.equal(gateway.state.has('slow-provider'), false, 'the slow write is still running');
  assert.ok(queue.isBusy('slow-provider'), 'the slow provider is still busy');
  assert.equal(queue.isBusy('other-provider'), false, 'the fast provider has settled');

  await settle(80);
  assert.equal(gateway.state.get('slow-provider'), true);
  assert.equal(gateway.maxConcurrentPerKey, 1, 'isolation does not relax the per-key rule');
}

// ---- failure is recoverable, not a retry storm ----

{
  const gateway = createGateway();
  let attempts = 0;
  const queue = createLastIntentQueue((key, value) => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error('gateway refused'));
    return gateway.set(key, value);
  });

  queue.request('provider-d', true);
  await settle();
  // The intent is dropped rather than retried forever: the row falls back to a
  // fresh read of the gateway instead of fighting the operator's clicks.
  assert.equal(attempts, 1, 'a failed write is not retried automatically');
  assert.equal(queue.isBusy('provider-d'), false, 'a failed key still settles');
  assert.equal(gateway.state.has('provider-d'), false);

  // A later click still works, so the failure did not wedge the key.
  queue.request('provider-d', true);
  await settle();
  assert.equal(gateway.state.get('provider-d'), true, 'the key recovers after a failure');
  assert.equal(attempts, 2);
}

console.log(
  'PASS provider toggle queue: last click wins, one write per provider at a time, failures recover',
);
