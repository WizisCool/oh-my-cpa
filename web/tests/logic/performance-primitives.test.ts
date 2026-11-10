import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { test } from 'vitest';

import {
  createCoalescedSignalGate,
  createFrameBudgetScheduler,
  createResizeObserverHub,
  createRouteRegistry,
  createStreamStore,
  defineSwrQuery,
  invalidateSwrScopes,
  type ObservedBoxSize,
} from '../../src/performance/index.ts';
import { dashboardWidgetSpec } from '../../src/types/dashboardLayout.ts';

test('frame scheduler runs p0 before p1/p2, batches within frameBudgetMs, and yields across frames', () => {
  let clock = 0;
  let hidden = false;
  let transitioning = false;
  const slices: Array<() => void> = [];
  const executed: string[] = [];
  let batches = 0;

  const scheduler = createFrameBudgetScheduler({
    frameBudgetMs: 8,
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
    clock += 3;
    executed.push('p2-a');
  });
  const cancelCancelled = scheduler.schedule('p1', () => {
    executed.push('cancelled');
  });
  scheduler.schedule('p1', () => {
    clock += 6;
    executed.push('p1-a');
  });
  scheduler.schedule('p0', () => {
    clock += 4;
    executed.push('p0-a');
  });
  cancelCancelled();

  assert.equal(slices.length, 1);
  // Slice 1 runs p0-a (4ms) + p1-a (4+6 = 10ms >= 8ms budget), then yields before p2-a.
  const firstSlice = slices.shift()!;
  firstSlice();
  assert.deepEqual(executed, ['p0-a', 'p1-a']);
  assert.equal(batches, 1);
  assert.equal(slices.length, 1, 'remaining p2 work schedules a follow-up frame slice');

  // While a route transition is pending, p2 work yields while p0 still runs immediately.
  transitioning = true;
  scheduler.schedule('p0', () => {
    clock += 1;
    executed.push('p0-urgent');
  });
  const secondSlice = slices.shift()!;
  secondSlice();
  assert.deepEqual(executed, ['p0-a', 'p1-a', 'p0-urgent']);
  assert.equal(scheduler.pendingCount('p2'), 1);
  assert.equal(slices.length, 0, 'no idle spin while transition blocks p2');

  // Completing the transition resumes queued p2 work; hiding pauses it again.
  hidden = true;
  transitioning = false;
  scheduler.poke();
  assert.equal(slices.length, 0);

  hidden = false;
  scheduler.poke();
  assert.equal(slices.length, 1);
  slices.shift()!();
  assert.deepEqual(executed, ['p0-a', 'p1-a', 'p0-urgent', 'p2-a']);
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
  let emitted = 0;
  const timers: Array<{ ms: number; cb: () => void }> = [];

  const gate = createCoalescedSignalGate({
    coalesceMs: 250,
    now: () => clock,
    isBusy: () => busy,
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

  clock += 50;
  timers.shift()!.cb();
  assert.equal(emitted, 2, 'entire 20-signal burst produces exactly one trailing refresh');
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

  await invalidateSwrScopes(queryClient, 'perf-test-usage');
  const state = queryClient.getQueryState(['perf-test-dashboard', 'preset=1h']);
  assert.equal(state?.isInvalidated, true);
  queryClient.clear();
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
