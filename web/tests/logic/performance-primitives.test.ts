import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { test } from 'vitest';

import {
  createCoalescedSignalGate,
  createFrameBudgetScheduler,
  createResizeObserverHub,
  createRouteRegistry,
  createRouteTransitionStore,
  createStreamStore,
  defineSwrQuery,
  invalidateSwrScopes,
  type ObservedBoxSize,
} from '../../src/performance/index.ts';
import { dashboardWidgetSpec } from '../../src/types/dashboardLayout.ts';
import { isDiscreteWheel, keyScrollFor, pageDistance, type WheelSample } from '../../src/utils/scrollSmoothing.ts';

test('frame scheduler separates priority tiers across slices, caps per-slice jobs, and yields across frames', () => {
  let clock = 0;
  let hidden = false;
  let transitioning = false;
  const slices: Array<() => void> = [];
  const executed: string[] = [];
  let batches = 0;

  const scheduler = createFrameBudgetScheduler({
    frameBudgetMs: 8,
    maxJobsPerSlice: 2,
    now: () => clock,
    isHidden: () => hidden,
    isTransitionPending: () => transitioning,
    batchUpdates: (run) => {
      batches += 1;
      run();
    },
    scheduleSlice: (run) => {
      slices.push(run);
      return () => {
        const idx = slices.indexOf(run);
        if (idx >= 0) slices.splice(idx, 1);
      };
    },
  });

  scheduler.schedule('p2', () => {
    clock += 1;
    executed.push('p2-a');
  });
  const cancelCancelled = scheduler.schedule('p1', () => {
    executed.push('cancelled');
  });
  scheduler.schedule('p1', () => {
    clock += 1;
    executed.push('p1-a');
  });
  scheduler.schedule('p1', () => {
    clock += 1;
    executed.push('p1-b');
  });
  scheduler.schedule('p1', () => {
    clock += 1;
    executed.push('p1-c');
  });
  scheduler.schedule('p0', () => {
    clock += 1;
    executed.push('p0-a');
  });
  cancelCancelled();

  assert.equal(slices.length, 1);
  // Slice 1 runs p0-a and stops at the p0 -> p1 tier boundary without dequeuing p1-a.
  slices.shift()!();
  assert.deepEqual(executed, ['p0-a']);
  assert.equal(batches, 1);
  assert.equal(slices.length, 1);

  // Slice 2 runs at most maxJobsPerSlice (2) jobs from p1 in FIFO order, keeping p1-c queued.
  slices.shift()!();
  assert.deepEqual(executed, ['p0-a', 'p1-a', 'p1-b']);
  assert.equal(batches, 2);
  assert.equal(slices.length, 1);

  // While a route transition is pending, p1/p2 work yields while p0 still runs immediately.
  transitioning = true;
  scheduler.schedule('p0', () => {
    clock += 1;
    executed.push('p0-urgent');
  });
  slices.shift()!();
  assert.deepEqual(executed, ['p0-a', 'p1-a', 'p1-b', 'p0-urgent']);
  assert.equal(scheduler.pendingCount('p1'), 1);
  assert.equal(scheduler.pendingCount('p2'), 1);
  assert.equal(slices.length, 0, 'no idle spin while transition blocks p1/p2');

  // Completing the transition resumes p1-c, then yields at the p1 -> p2 boundary for p2-a.
  hidden = true;
  transitioning = false;
  scheduler.poke();
  assert.equal(slices.length, 0);

  hidden = false;
  scheduler.poke();
  assert.equal(slices.length, 1);
  slices.shift()!();
  assert.deepEqual(executed, ['p0-a', 'p1-a', 'p1-b', 'p0-urgent', 'p1-c']);
  assert.equal(slices.length, 1);
  slices.shift()!();
  assert.deepEqual(executed, ['p0-a', 'p1-a', 'p1-b', 'p0-urgent', 'p1-c', 'p2-a']);
  assert.equal(scheduler.pendingCount(), 0);
  scheduler.dispose();
});

test('resize observer hub multiplexes one observer, delivers cached size to late peers, and freezes during transitions', () => {
  let observeCalls = 0;
  let unobserveCalls = 0;
  let disconnectCalls = 0;
  let transitioning = false;
  const transitionListeners = new Set<() => void>();
  const frames: Array<FrameRequestCallback> = [];
  let observerCallback: ResizeObserverCallback | undefined;

  const hub = createResizeObserverHub({
    createObserver: (cb) => {
      observerCallback = cb;
      return {
        observe: () => { observeCalls += 1; },
        unobserve: () => { unobserveCalls += 1; },
        disconnect: () => { disconnectCalls += 1; },
      };
    },
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => undefined,
    isTransitionPending: () => transitioning,
    subscribeTransition: (listener) => {
      transitionListeners.add(listener);
      return () => transitionListeners.delete(listener);
    },
  });

  const target = {} as Element;
  const seenA: ObservedBoxSize[] = [];
  const seenB: ObservedBoxSize[] = [];

  const unsubA = hub.observe(target, (size) => seenA.push(size), { epsilonPx: 1, freezeOnTransition: true });
  assert.equal(observeCalls, 1);
  assert.equal(hub.observedElementCount(), 1);

  const emitResize = (width: number, height: number) => {
    observerCallback?.(
      [{ target, contentRect: { width, height } as DOMRectReadOnly } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  };

  // Initial measurement delivers; 0x0 and sub-epsilon jitter are ignored.
  emitResize(0, 0);
  assert.equal(seenA.length, 0);
  emitResize(480, 220);
  emitResize(480.4, 220.2);
  assert.deepEqual(seenA, [{ width: 480, height: 220 }]);

  // Second subscriber on the same element reuses the single observer and receives the known box on next frame.
  const unsubB = hub.observe(target, (size) => seenB.push(size), { freezeOnTransition: false });
  assert.equal(observeCalls, 1);
  assert.equal(frames.length, 1);
  frames.shift()!(16);
  assert.deepEqual(seenB, [{ width: 480.4, height: 220.2 }]);

  // During a pending route transition, frozen subscriber A defers while unfrozen B updates immediately.
  transitioning = true;
  emitResize(640, 260);
  assert.deepEqual(seenA, [{ width: 480, height: 220 }]);
  assert.deepEqual(seenB, [{ width: 480.4, height: 220.2 }, { width: 640, height: 260 }]);

  // Ending the transition flushes the latest deferred box to subscriber A on the next animation frame.
  transitioning = false;
  for (const listener of transitionListeners) listener();
  assert.equal(frames.length, 1);
  frames.shift()!(32);
  assert.deepEqual(seenA, [{ width: 480, height: 220 }, { width: 640, height: 260 }]);

  unsubA();
  assert.equal(unobserveCalls, 0);
  unsubB();
  assert.equal(unobserveCalls, 1);
  assert.equal(disconnectCalls, 1);
  assert.equal(hub.observedElementCount(), 0);
});

test('stream store bounds ring buffer, coalesces bursts per frame, and pauses while hidden', () => {
  let clock = 100;
  let visible = true;
  const visibilityListeners = new Set<() => void>();
  const frames: Array<() => void> = [];

  const store = createStreamStore<number, { items: number[]; dropped: number }>({
    initialState: { items: [], dropped: 0 },
    maxBufferSize: 3,
    now: () => clock,
    isVisible: () => visible,
    onVisibilityChange: (listener) => {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => undefined,
    reduce: (state, batch, dropped) => ({
      items: [...state.items, ...batch],
      dropped: state.dropped + dropped,
    }),
  });

  let notifications = 0;
  const unsub = store.subscribe(() => { notifications += 1; });

  // Five pushes in one frame keep the newest 3 and record 2 dropped items, committing once.
  store.pushMany([1, 2, 3, 4]);
  store.push(5);
  assert.equal(frames.length, 1);
  assert.equal(notifications, 0);

  frames.shift()!();
  assert.deepEqual(store.getSnapshot(), { items: [3, 4, 5], dropped: 2 });
  assert.equal(notifications, 1);

  // Hidden pushes accumulate without scheduling rAF until visibility returns.
  visible = false;
  clock += 50;
  store.pushMany([6, 7]);
  assert.equal(frames.length, 0);
  assert.equal(store.pendingCount(), 2);

  visible = true;
  for (const listener of visibilityListeners) listener();
  assert.equal(frames.length, 1);
  frames.shift()!();
  assert.deepEqual(store.getSnapshot(), { items: [3, 4, 5, 6, 7], dropped: 2 });

  unsub();
  store.dispose();
});

test('coalesced signal gate fires immediately when idle and coalesces 25Hz SSE bursts without overlapping fetches', () => {
  let clock = 1_000;
  let busy = false;
  let visible = true;
  let emitted = 0;
  const timers: Array<{ ms: number; cb: () => void }> = [];

  const gate = createCoalescedSignalGate({
    coalesceMs: 250,
    now: () => clock,
    isBusy: () => busy,
    isVisible: () => visible,
    setTimer: (cb, ms) => {
      const entry = { ms, cb };
      timers.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      const idx = timers.indexOf(handle as { ms: number; cb: () => void });
      if (idx >= 0) timers.splice(idx, 1);
    },
    onEmit: () => {
      emitted += 1;
    },
  });

  // First signal after idle emits synchronously at 0ms latency.
  gate.onSignal();
  assert.equal(emitted, 1);

  // Twenty rapid SSE signals over 200ms while fetch is busy coalesce into a single pending flush.
  busy = true;
  for (let i = 0; i < 20; i += 1) {
    clock += 10;
    gate.onSignal();
  }
  assert.equal(emitted, 1, 'no overlapping emissions while busy or inside coalesce window');

  // Fetch settles at +200ms (50ms remaining in 250ms coalesce window) -> schedules one trailing timer.
  busy = false;
  gate.onSettled();
  assert.equal(emitted, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 50);

  // If the tab goes hidden before the trailing timer fires, pending stays queued until visible again.
  visible = false;
  clock += 50;
  timers.shift()!.cb();
  assert.equal(emitted, 1, 'hidden tab defers trailing flush');

  visible = true;
  clock += 300;
  gate.onVisibilityChange();
  assert.equal(emitted, 2, 'foregrounding flushes held signal immediately without waiting for fallback poll');
  gate.reset();
});

test('SWR query contract prevents stale out-of-order snapshot rollbacks and scopes tag invalidation', async () => {
  const queryClient = new QueryClient();
  let calls = 0;

  const contract = defineSwrQuery<{ window: string }, { revision: number; window: string }>({
    scope: 'perf-test-dashboard',
    tags: ['perf-test-usage'],
    staleTime: 30_000,
    placeholderStrategy: 'sameScope',
    key: (params) => ['perf-test-dashboard', params.window] as const,
    fetcher: async (params) => {
      calls += 1;
      return { revision: calls, window: params.window };
    },
  });

  await contract.prefetch(queryClient, { window: 'preset=1h' });
  assert.deepEqual(contract.readSnapshot(queryClient, { window: 'preset=1h' }), {
    revision: 1,
    window: 'preset=1h',
  });

  // Monotonic guard rejects an older out-of-order response from overwriting revision 5.
  contract.writeSnapshot(queryClient, { window: 'preset=1h' }, { revision: 5, window: 'preset=1h' });
  contract.writeSnapshot(
    queryClient,
    { window: 'preset=1h' },
    { revision: 2, window: 'preset=1h' },
    (current, candidate) => !current || (candidate?.revision ?? 0) >= current.revision,
  );
  assert.equal(contract.readSnapshot(queryClient, { window: 'preset=1h' })?.revision, 5);

  queryClient.setQueryData(['perf-test-usage', 'untagged'], { ok: true });
  await invalidateSwrScopes(queryClient, 'perf-test-usage');
  const state = queryClient.getQueryState(['perf-test-dashboard', 'preset=1h']);
  const directScopeState = queryClient.getQueryState(['perf-test-usage', 'untagged']);
  assert.equal(state?.isInvalidated, true);
  assert.equal(directScopeState?.isInvalidated, true);
  queryClient.clear();
});

test('route transition store reaches zero after overlapping transition starts before a prior settle frame runs', () => {
  const frames: Array<() => void> = [];
  let notifications = 0;
  const store = createRouteTransitionStore({
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    pokeScheduler: () => undefined,
  });
  const unsub = store.subscribe(() => { notifications += 1; });

  const releaseA = store.markTransitionStart();
  assert.equal(store.isPending(), true);
  assert.equal(notifications, 1);

  releaseA();
  // Start B before A's scheduled settle frame runs.
  const releaseB = store.markTransitionStart();
  assert.equal(store.isPending(), true);
  assert.equal(notifications, 1, 'no premature idle notification between A and B');

  // A's settle frame decrements 2 -> 1; store stays pending while B is active.
  frames.shift()!();
  assert.equal(store.isPending(), true);

  // B releases and its settle frame decrements 1 -> 0.
  releaseB();
  frames.shift()!();
  assert.equal(store.isPending(), false);
  assert.equal(notifications, 2);
  unsub();
});

test('route registry resolves exact and prefix routes, respects intent cooldown, and prewarms critical/high routes on idle', async () => {
  let now = 500;
  const loaded: string[] = [];
  const prefetched: string[] = [];
  const idleCallbacks: Array<() => void> = [];

  const registry = createRouteRegistry(
    [
      {
        path: '/dashboard',
        priority: 'critical',
        preloadChunk: async () => { loaded.push('/dashboard'); },
        prefetchData: async () => { prefetched.push('/dashboard'); },
      },
      {
        path: '/insights',
        priority: 'high',
        preloadChunk: async () => { loaded.push('/insights'); },
        prefetchData: async () => { prefetched.push('/insights'); },
      },
      {
        path: '/plugin-pages/',
        matchPrefix: true,
        priority: 'normal',
        preloadChunk: async () => { loaded.push('/plugin-pages/'); },
      },
    ],
    {
      intentCooldownMs: 2_000,
      now: () => now,
      scheduleIdle: (cb) => {
        idleCallbacks.push(cb);
        return () => {
          const idx = idleCallbacks.indexOf(cb);
          if (idx >= 0) idleCallbacks.splice(idx, 1);
        };
      },
    },
  );

  assert.equal(registry.resolve('/plugin-pages/demo/0')?.path, '/plugin-pages/');
  assert.equal(registry.resolve('/')?.path, '/dashboard');

  const queryClient = new QueryClient();
  registry.warmIntent('/insights?metric=tokens', { queryClient, pathname: '/insights', timeZone: 'UTC' });
  registry.warmIntent('/insights', { queryClient, pathname: '/insights', timeZone: 'UTC' });
  assert.deepEqual(prefetched, ['/insights'], 'intent cooldown suppresses duplicate data prefetches during hover sweep');

  now += 2_500;
  registry.warmIntent('/insights', { queryClient, pathname: '/insights', timeZone: 'UTC' });
  assert.deepEqual(prefetched, ['/insights', '/insights']);

  loaded.length = 0;
  const cancelIdle = registry.scheduleIdlePrewarm('/dashboard');
  while (idleCallbacks.length > 0) idleCallbacks.shift()!();
  assert.deepEqual(loaded, ['/insights'], 'idle prewarm skips active route and normal-priority plugin routes');
  cancelIdle();
  queryClient.clear();
});

test('live routing widget is available on mobile viewports and supports half-to-full spans', () => {
  const spec = dashboardWidgetSpec('routing');
  assert.equal(Boolean(spec.isPhoneOmitted), false);
  assert.deepEqual(spec.spans, [2, 3, 4]);
});

function makeWheelSample(overrides: Partial<WheelSample> = {}): WheelSample {
  return {
    deltaMode: 0,
    deltaX: 0,
    deltaY: 100,
    wheelDeltaY: -120,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

test('isDiscreteWheel recognizes mouse notches at 1x and fractional HiDPI scales without smoothing trackpads', () => {
  assert.equal(isDiscreteWheel(makeWheelSample(), { isApple: false, devicePixelRatio: 1 }), true);
  // Chromium divides legacy wheelDeltaY by fractional display scales (125%, 150%, 175%) and truncates.
  assert.equal(
    isDiscreteWheel(makeWheelSample({ wheelDeltaY: -96, deltaY: 100 }), { isApple: false, devicePixelRatio: 1.25 }),
    true,
  );
  assert.equal(
    isDiscreteWheel(makeWheelSample({ wheelDeltaY: -192, deltaY: 200 }), { isApple: false, devicePixelRatio: 1.25 }),
    true,
  );
  assert.equal(
    isDiscreteWheel(makeWheelSample({ wheelDeltaY: -80, deltaY: 100 }), { isApple: false, devicePixelRatio: 1.5 }),
    true,
  );
  assert.equal(
    isDiscreteWheel(makeWheelSample({ wheelDeltaY: -68, deltaY: 100 }), { isApple: false, devicePixelRatio: 1.75 }),
    true,
  );
  // Line/page delta modes are always discrete steps.
  assert.equal(
    isDiscreteWheel(makeWheelSample({ deltaMode: 1, deltaY: 3, wheelDeltaY: undefined }), { isApple: true }),
    true,
  );

  // Continuous trackpad streams, small sub-line deltas, Apple pixel streams, horizontal pans, and zoom stay native.
  assert.equal(
    isDiscreteWheel(makeWheelSample({ wheelDeltaY: -18, deltaY: 14.5 }), { isApple: false, devicePixelRatio: 1.25 }),
    false,
  );
  assert.equal(
    isDiscreteWheel(makeWheelSample({ wheelDeltaY: -96, deltaY: 24 }), { isApple: false, devicePixelRatio: 1.25 }),
    false,
  );
  assert.equal(isDiscreteWheel(makeWheelSample(), { isApple: true, devicePixelRatio: 2 }), false);
  assert.equal(isDiscreteWheel(makeWheelSample({ deltaX: 8 }), { isApple: false, devicePixelRatio: 1 }), false);
  assert.equal(isDiscreteWheel(makeWheelSample({ ctrlKey: true }), { isApple: false, devicePixelRatio: 1 }), false);
});

test('pageDistance and keyScrollFor step by the unoccluded scroller height when scroll-padding-bottom is present', () => {
  // With clientHeight = 700 and 200px occluded by the expanded header, only 500px of rows are visible:
  // PageDown steps 460px (500 - 40) rather than 660px (700 - 40), so no rows are skipped.
  assert.equal(pageDistance(700, 200), 460);
  assert.deepEqual(keyScrollFor('PageDown', false, 700 - 200), { by: 460 });
});
