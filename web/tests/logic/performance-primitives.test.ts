import assert from 'node:assert/strict';
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { test } from 'vitest';

import { MUTATION_KEYS, QUERY_KEYS } from '../../src/api/queryKeys.ts';
import {
  createStateLiveChannel,
  resolveStateEventsURL,
  type MinimalEventSource,
  type StateSyncEvent,
} from '../../src/api/stateLive.ts';
import { buildOptimisticMutationOptions, defineOptimisticTarget } from '../../src/hooks/optimisticMutation.ts';
import { reconcileStateSyncEvent, type StateVersionTracker } from '../../src/hooks/useEventSource.ts';
import { invalidateQueriesSilently, queryProgressSource } from '../../src/utils/progressSources.ts';

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
import { isSameDrawing } from '../../src/charts/useChartMorph.ts';
import { isSameReadout } from '../../src/components/dashboard/RollingNumber.tsx';

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

test('optimistic mutation updates cache synchronously, rolls back on error, and invalidates only when final concurrent mutation settles', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const cacheKey = ['test-optimistic-toggle'] as const;
  const mutationKey = ['mutation', 'test-optimistic-toggle'] as const;
  queryClient.setQueryData(cacheKey, { enabled: false });

  const resolvers: Array<() => void> = [];
  let finalSettledCount = 0;

  const makeObserver = () =>
    new MutationObserver(
      queryClient,
      buildOptimisticMutationOptions<void, Error, boolean>(queryClient, {
        mutationKey,
        mutationFn: () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          }),
        targets: [
          defineOptimisticTarget<boolean, { enabled: boolean }>(cacheKey, (_prev, enabled) => ({
            enabled,
          })),
        ],
        onFinalSettled: () => {
          finalSettledCount += 1;
        },
      }),
    );

  // Fire two rapid consecutive clicks (true -> false) before either network request resolves.
  const firstClick = makeObserver().mutate(true);
  // Optimistic setQueryData runs synchronously in 0 ticks (before any await)!
  assert.deepEqual(queryClient.getQueryData(cacheKey), { enabled: true });

  const secondClick = makeObserver().mutate(false);
  assert.deepEqual(queryClient.getQueryData(cacheKey), { enabled: false });

  // Flush microtasks so cancelQueries().then(...) advances into mutationFn and populates resolvers[].
  for (let tick = 0; tick < 6 && resolvers.length < 2; tick += 1) {
    await Promise.resolve();
  }
  assert.equal(resolvers.length, 2, 'both concurrent mutations entered mutationFn');

  // Reset invalidation flag before resolving the first mutation while the second is still active.
  await queryClient.invalidateQueries({ queryKey: cacheKey, refetchType: 'none' });
  queryClient.setQueryData(cacheKey, { enabled: false });

  // Resolve click 1 first: click 2 is still in flight (isMutating === 2), so invalidation MUST NOT fire.
  resolvers[0]!();
  await firstClick;
  assert.equal(finalSettledCount, 0, 'intermediate mutation settlement must not trigger final invalidation');
  assert.deepEqual(queryClient.getQueryData(cacheKey), { enabled: false }, 'second click state remains intact without flicker');

  // Resolve click 2 (last in queue, isMutating === 1): invalidation now fires once.
  resolvers[1]!();
  await secondClick;
  assert.equal(finalSettledCount, 1, 'final concurrent mutation triggers exactly one settle invalidation');
  assert.equal(queryClient.getQueryState(cacheKey)?.isInvalidated, true);

  // Verify atomic rollback on error.
  queryClient.setQueryData(cacheKey, { enabled: false });
  let capturedErrorMessage = '';
  const failingObserver = new MutationObserver(
    queryClient,
    buildOptimisticMutationOptions<void, Error, boolean>(queryClient, {
      mutationKey,
      mutationFn: async () => {
        assert.deepEqual(queryClient.getQueryData(cacheKey), { enabled: true }, 'optimistic state is visible while pending');
        throw new Error('upstream rejected toggle');
      },
      targets: [
        defineOptimisticTarget<boolean, { enabled: boolean }>(cacheKey, (_prev, enabled) => ({
          enabled,
        })),
      ],
      onError: (err) => {
        capturedErrorMessage = err.message;
      },
    }),
  );

  await assert.rejects(() => failingObserver.mutate(true));
  assert.deepEqual(queryClient.getQueryData(cacheKey), { enabled: false }, 'failed mutation rolls back to previous snapshot');
  assert.equal(capturedErrorMessage, 'upstream rejected toggle');
  queryClient.clear();
});

test('state SSE channel suspends when hidden and reconcileStateSyncEvent applies sync_error rollback while guarding active mutations', async () => {
  const queryClient = new QueryClient();
  let isVisible = true;
  let visibilityHandler: (() => void) | null = null;
  const listenersByType = new Map<string, Array<(evt: MessageEvent<string> | Event) => void>>();
  let closedCount = 0;

  const fakeSource: MinimalEventSource = {
    readyState: 1,
    addEventListener: (type, fn) => {
      const list = listenersByType.get(type) ?? [];
      list.push(fn);
      listenersByType.set(type, list);
    },
    close: () => {
      closedCount += 1;
    },
  };

  const channel = createStateLiveChannel({
    createSource: () => fakeSource,
    url: () => '/api/events',
    isVisible: () => isVisible,
    onVisibilityChange: (handler) => {
      visibilityHandler = handler;
      return () => {
        visibilityHandler = null;
      };
    },
    setTimer: () => 1,
    clearTimer: () => undefined,
  });

  const received: StateSyncEvent[] = [];
  const tracker: StateVersionTracker = { lastVersion: 0 };
  const syncErrors: string[] = [];

  const unsub = channel.subscribe({
    onEvent: (evt) => {
      received.push(evt);
    },
  });

  const emitFrame = (type: string, data: unknown) => {
    for (const handler of listenersByType.get(type) ?? []) {
      handler({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  };

  emitFrame('ready', { type: 'ready', version: 1 });
  assert.equal(channel.getState(), 'live');
  assert.equal(received.length, 1);
  await reconcileStateSyncEvent(queryClient, received[0]!, tracker);
  assert.equal(tracker.lastVersion, 1);

  // Seed optimistic provider state (disabled: false) that upstream will reject via sync_error.
  queryClient.setQueryData(QUERY_KEYS.providers(false), {
    providers: [{ id: 'codex-0', family: 'codex', name: 'Codex', protocol: 'OpenAI Responses', disabled: false, disable_cooling: false, key_configured: true, proxy_configured: false }],
    total: 1,
  });

  // Start an in-flight providerStatus mutation and verify state_sync skips invalidation while active.
  let resolveActiveMutation!: () => void;
  const activeObserver = new MutationObserver(queryClient, {
    mutationKey: MUTATION_KEYS.providerStatus,
    mutationFn: () => new Promise<void>((resolve) => { resolveActiveMutation = resolve; }),
  });
  const activePromise = activeObserver.mutate();
  await reconcileStateSyncEvent(
    queryClient,
    { type: 'state_sync', version: 2, scopes: ['management-providers'] },
    tracker,
  );
  assert.equal(
    queryClient.getQueryState(QUERY_KEYS.providers(false))?.isInvalidated ?? false,
    false,
    'state_sync defers invalidating a scope while a newer optimistic mutation is in flight',
  );
  resolveActiveMutation();
  await activePromise;

  // Emit sync_error carrying authoritative disabled: true snapshot; verify immediate rollback + error notification.
  const syncErrorEvent: StateSyncEvent = {
    type: 'sync_error',
    version: 3,
    scopes: ['management-providers'],
    code: 'config_rejected',
    error: 'CPA rejected codex update',
    data: {
      revision: 'rev-3',
      stored_layout: 'v8',
      scalars: {
        proxy_url: '',
        ws_auth: true,
        force_model_prefix: false,
        debug: false,
        request_log: false,
        logging_to_file: false,
        logs_max_total_size_mb: 0,
        error_logs_max_files: 10,
        routing_strategy: 'round-robin',
        request_retry: 0,
        max_retry_interval: 0,
        max_retry_credentials: 0,
        usage_statistics_enabled: true,
      },
      supported_keys: ['debug'],
      client_keys_total: 1,
      provider_statuses: [{ id: 'codex-0', family: 'codex', disabled: true }],
      auth_file_statuses: [{ name: 'codex-a.json', auth_index: 'idx-a', disabled: true }],
      oauth_model_aliases: {},
      oauth_excluded_models: {},
    },
  };
  await reconcileStateSyncEvent(queryClient, syncErrorEvent, tracker, (err) => {
    syncErrors.push(err.error ?? '');
  });

  const rolledBack = queryClient.getQueryData<{ providers: Array<{ id: string; disabled: boolean }> }>(
    QUERY_KEYS.providers(false),
  );
  assert.equal(rolledBack?.providers[0]?.disabled, true, 'sync_error snapshot rolls back optimistic provider status');
  assert.deepEqual(syncErrors, ['CPA rejected codex update']);
  assert.equal(queryClient.getQueryState(QUERY_KEYS.providers(false))?.isInvalidated, true);

  // Simulate an OMC process restart: tracker held version 3, reconnected stream emits ready at version 1.
  // The lower ready version must start a fresh epoch, invalidate cached state, and allow version 2 through!
  await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providers(false), refetchType: 'none' });
  queryClient.setQueryData(QUERY_KEYS.providers(false), {
    providers: [{ id: 'codex-0', family: 'codex', name: 'Codex', protocol: 'OpenAI Responses', disabled: true, disable_cooling: false, key_configured: true, proxy_configured: false }],
    total: 1,
  });
  await reconcileStateSyncEvent(queryClient, { type: 'ready', version: 1 }, tracker);
  assert.equal(tracker.lastVersion, 1, 'ready with lower version resets tracker to new server epoch');
  assert.equal(queryClient.getQueryState(QUERY_KEYS.providers(false))?.isInvalidated, true);

  // Reset invalidation and verify version 2 in the new epoch is NOT dropped.
  queryClient.setQueryData(QUERY_KEYS.providers(false), {
    providers: [{ id: 'codex-0', family: 'codex', name: 'Codex', protocol: 'OpenAI Responses', disabled: true, disable_cooling: false, key_configured: true, proxy_configured: false }],
    total: 1,
  });
  await reconcileStateSyncEvent(
    queryClient,
    { type: 'state_sync', version: 2, scopes: ['management-providers'] },
    tracker,
  );
  assert.equal(tracker.lastVersion, 2);
  assert.equal(queryClient.getQueryState(QUERY_KEYS.providers(false))?.isInvalidated, true);

  // Verify resolveStateEventsURL honors root and custom OMCPA_BASE_PATH via window.__OMCPA_CONFIG__.
  const g = globalThis as { window?: { __OMCPA_CONFIG__?: { basePath?: string; apiBaseUrl?: string } } };
  const prevWindow = g.window;
  try {
    g.window = { __OMCPA_CONFIG__: { basePath: '/', apiBaseUrl: '/api/v1' } };
    assert.equal(resolveStateEventsURL('/api/events'), '/api/events');
    g.window = { __OMCPA_CONFIG__: { basePath: '/omc', apiBaseUrl: '/omc/api/v1' } };
    assert.equal(resolveStateEventsURL('/api/events'), '/omc/api/events');
    assert.equal(resolveStateEventsURL('/events'), '/omc/api/v1/events');
  } finally {
    g.window = prevWindow;
  }

  // Hiding the tab closes the EventSource slot immediately.
  isVisible = false;
  visibilityHandler?.();
  assert.equal(closedCount, 1);

  unsub();
  queryClient.clear();
});

test('invalidateQueriesSilently keeps DataProgress bar idle when cached data reconciles in the background', async () => {
  let resolveFetch!: (val: { ok: boolean }) => void;
  const queryClient = new QueryClient();
  const progress = queryProgressSource(queryClient.getQueryCache() as never);
  const key = ['management-auth-files'] as const;

  // 1. Seed initial cached data and attach an observer (simulating an open OAuthManagementPage).
  queryClient.setQueryData(key, { ok: true });
  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: () => new Promise<{ ok: boolean }>((resolve) => { resolveFetch = resolve; }),
    staleTime: 30_000,
  });
  const observerUnsub = observer.subscribe(() => undefined);
  // Attach a synchronous cache subscriber calling progress.read() on every cache event
  // (including the synchronous 'invalidated' event where fetchStatus is still 'idle'),
  // mirroring DataProgress's useSyncExternalStore subscription.
  let sawNonEmptyDuringSilent = false;
  let checkingSilent = false;
  const cacheSubUnsub = queryClient.getQueryCache().subscribe(() => {
    const active = progress.read();
    if (checkingSilent && active.size > 0) {
      sawNonEmptyDuringSilent = true;
    }
  });

  // 2. Silent invalidation after an optimistic switch toggle starts a background fetch,
  //    but DataProgress reports 0 blocking tasks across every cache event!
  checkingSilent = true;
  const silentPromise = invalidateQueriesSilently(queryClient, { queryKey: key });
  assert.equal(progress.read().size, 0, 'silent background reconciliation must not trigger top progress bar');
  assert.equal(sawNonEmptyDuringSilent, false, 'useSyncExternalStore snapshot read on invalidate event must not strip silent marker');

  resolveFetch({ ok: true });
  await silentPromise;
  checkingSilent = false;

  // 3. Subsequent explicit manual invalidation on the same query DOES trigger the progress bar.
  const manualPromise = queryClient.invalidateQueries({ queryKey: key });
  assert.equal(progress.read().size, 1, 'explicit manual invalidation still reports progress');
  resolveFetch({ ok: true });
  await manualPromise;

  cacheSubUnsub();
  observerUnsub();
  queryClient.clear();
});

test('a chart redraws for a new dataset, not for a parent re-render that only renews its handlers', () => {
  const groups = [{ id: 'a', values: [1, 2] }];
  const drawn = { groups, metric: 'tokens', onSelect: () => undefined };
  assert.equal(isSameDrawing({ ...drawn, onSelect: () => undefined }, drawn), true);
  assert.equal(isSameDrawing({ ...drawn, groups: [...groups] }, drawn), false);
  assert.equal(isSameDrawing({ ...drawn, metric: 'cost' }, drawn), false);
  assert.equal(isSameDrawing({ groups, metric: 'tokens' }, drawn), false);
  assert.equal(isSameDrawing(drawn, { ...drawn, onSelect: undefined }), false);
});

test('a rolling number re-renders only when the reading it prints changes', () => {
  const reading = { number: 1.2, suffix: 'M', format: { maximumFractionDigits: 1 } };
  assert.equal(isSameReadout({ ...reading, format: { maximumFractionDigits: 1 } }, reading), true);
  assert.equal(isSameReadout({ ...reading, number: 1.3 }, reading), false);
  assert.equal(isSameReadout({ ...reading, suffix: 'B' }, reading), false);
  assert.equal(isSameReadout({ ...reading, format: { maximumFractionDigits: 2 } }, reading), false);
  assert.equal(isSameReadout(undefined, reading), false);
  assert.equal(isSameReadout(undefined, undefined), true);
});
