import React from 'react';

export interface StreamBufferOptions<TItem, TState> {
  readonly initialState: TState;
  /** Pure reducer folding a frame-coalesced batch and any overflow drops into the store state. */
  readonly reduce: (state: TState, batch: readonly TItem[], droppedCount: number) => TState;
  /** Maximum buffered items retained before oldest un-flushed entries are dropped. Defaults to `1024`. */
  readonly maxBufferSize?: number;
  /** Optional minimum interval in ms between consecutive flushes (`0` = once per animation frame). */
  readonly coalesceMs?: number;
  readonly now?: () => number;
  readonly requestFrame?: (callback: () => void) => unknown;
  readonly cancelFrame?: (handle: unknown) => void;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly isVisible?: () => boolean;
  readonly onVisibilityChange?: (listener: () => void) => () => void;
}

export interface StreamStore<TItem, TState> {
  getSnapshot: () => TState;
  subscribe: (listener: () => void) => () => void;
  push: (item: TItem) => void;
  pushMany: (items: readonly TItem[]) => void;
  /** Immediately commits any queued items into state. */
  flush: () => void;
  /** Atomically replaces state (e.g. on reload or filter reset) and optionally clears pending items. */
  replace: (nextState: TState | ((previous: TState) => TState), clearPending?: boolean) => void;
  pendingCount: () => number;
  dispose: () => void;
}

/**
 * Frame-aligned ring-buffer store for high-frequency streaming data (SSE pushes, log tails, live polls).
 *
 * Pushed items accumulate in a bounded queue and commit at most once per animation frame (or once
 * per `coalesceMs` window). While the document is hidden, frame flushes pause and resume with a
 * single consolidated batch when the tab returns, preventing background render churn and backlog
 * replay storms.
 */
export function createStreamStore<TItem, TState>(options: StreamBufferOptions<TItem, TState>): StreamStore<TItem, TState> {
  const maxBufferSize = Math.max(1, options.maxBufferSize ?? 1024);
  const coalesceMs = Math.max(0, options.coalesceMs ?? 0);
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const requestFrame = options.requestFrame ?? ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16)));
  const cancelFrame = options.cancelFrame ?? ((h) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h as number) : clearTimeout(h as ReturnType<typeof setTimeout>)));
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const isVisible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible');

  let state = options.initialState;
  let buffer: TItem[] = [];
  let droppedPending = 0;
  let lastFlushAt = -Infinity;
  let frameHandle: unknown = null;
  let timerHandle: unknown = null;
  let detachVisibility: (() => void) | null = null;
  let isDisposed = false;
  const listeners = new Set<() => void>();

  const cancelScheduled = () => {
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
    if (timerHandle !== null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const commitBatch = () => {
    cancelScheduled();
    if (isDisposed || (buffer.length === 0 && droppedPending === 0)) return;
    const batch = buffer;
    const dropped = droppedPending;
    buffer = [];
    droppedPending = 0;
    lastFlushAt = now();
    const next = options.reduce(state, batch, dropped);
    if (!Object.is(next, state)) {
      state = next;
      notify();
    }
  };

  const scheduleFlush = () => {
    if (isDisposed || (buffer.length === 0 && droppedPending === 0)) return;
    if (!isVisible()) return;
    if (frameHandle !== null || timerHandle !== null) return;

    const elapsed = now() - lastFlushAt;
    const waitMs = coalesceMs > 0 ? Math.max(0, coalesceMs - elapsed) : 0;
    if (waitMs > 0) {
      timerHandle = setTimer(() => {
        timerHandle = null;
        if (!isVisible()) return;
        frameHandle = requestFrame(() => {
          frameHandle = null;
          commitBatch();
        });
      }, waitMs);
    } else {
      frameHandle = requestFrame(() => {
        frameHandle = null;
        commitBatch();
      });
    }
  };

  const enqueue = (items: readonly TItem[]) => {
    if (isDisposed || items.length === 0) return;
    if (items.length >= maxBufferSize) {
      droppedPending += buffer.length + (items.length - maxBufferSize);
      buffer = items.slice(items.length - maxBufferSize);
    } else {
      const overflow = buffer.length + items.length - maxBufferSize;
      if (overflow > 0) {
        buffer.splice(0, overflow);
        droppedPending += overflow;
      }
      buffer.push(...items);
    }
    scheduleFlush();
  };

  const onVisibility = () => {
    if (isVisible()) scheduleFlush();
    else cancelScheduled();
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (!detachVisibility && options.onVisibilityChange) {
        detachVisibility = options.onVisibilityChange(onVisibility);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && detachVisibility) {
          detachVisibility();
          detachVisibility = null;
        }
      };
    },
    push(item) {
      enqueue([item]);
    },
    pushMany(items) {
      enqueue(items);
    },
    flush: commitBatch,
    replace(nextState, clearPending = true) {
      if (isDisposed) return;
      if (clearPending) {
        cancelScheduled();
        buffer = [];
        droppedPending = 0;
      }
      const resolved = typeof nextState === 'function'
        ? (nextState as (previous: TState) => TState)(state)
        : nextState;
      if (!Object.is(resolved, state)) {
        state = resolved;
        notify();
      }
    },
    pendingCount: () => buffer.length,
    dispose() {
      isDisposed = true;
      cancelScheduled();
      buffer = [];
      droppedPending = 0;
      detachVisibility?.();
      detachVisibility = null;
      listeners.clear();
    },
  };
}

/**
 * Subscribes to a fine-grained derived slice of a `StreamStore` with custom equality memoization,
 * ensuring high-frequency stream commits re-render only components whose selected slice changed.
 */
export function useStreamSelector<TItem, TState, TSlice>(
  store: Pick<StreamStore<TItem, TState>, 'getSnapshot' | 'subscribe'>,
  selector: (state: TState) => TSlice,
  isEqual: (left: TSlice, right: TSlice) => boolean = Object.is,
): TSlice {
  const cacheRef = React.useRef<{
    hasValue: boolean;
    state?: TState;
    selector?: (state: TState) => TSlice;
    slice?: TSlice;
  }>({ hasValue: false });

  const getSelection = React.useCallback((): TSlice => {
    const currentState = store.getSnapshot();
    const cached = cacheRef.current;
    if (cached.hasValue && Object.is(cached.state, currentState) && Object.is(cached.selector, selector)) {
      return cached.slice as TSlice;
    }
    const nextSlice = selector(currentState);
    if (cached.hasValue && isEqual(cached.slice as TSlice, nextSlice)) {
      cached.state = currentState;
      cached.selector = selector;
      return cached.slice as TSlice;
    }
    cacheRef.current = { hasValue: true, state: currentState, selector, slice: nextSlice };
    return nextSlice;
  }, [store, selector, isEqual]);

  return React.useSyncExternalStore(store.subscribe, getSelection, getSelection);
}

export interface CoalescedSignalGateOptions {
  /** Minimum spacing in ms between emitted signals during bursts; the first signal after idle is immediate. */
  readonly coalesceMs: number;
  readonly isBusy: () => boolean;
  readonly isVisible?: () => boolean;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly onEmit: () => void;
}

export interface CoalescedSignalGate {
  /** Handles a live push signal: emits immediately when quiet and idle, otherwise coalesces trailing edge. */
  onSignal: () => void;
  /** Called when an in-flight read settles so any held signal flushes once. */
  onSettled: () => void;
  /** Evaluates one fallback poll tick when no SSE stream is active. */
  onFallbackTick: (isLive: boolean) => void;
  reset: () => void;
}

/**
 * Leading-immediate, trailing-coalesced gate for signal-only SSE invalidation streams (`usage/live`).
 *
 * - An isolated signal after an idle period emits synchronously at `0ms` latency.
 * - A high-frequency burst (e.g. 25Hz SSE signals) coalesces into at most one trailing emission per
 *   `coalesceMs` window and never overlaps an in-flight read (`isBusy`), eliminating QueryCache churn
 *   and back-to-back chart/number animation resets while guaranteeing the final update is never lost.
 */
export function createCoalescedSignalGate(options: CoalescedSignalGateOptions): CoalescedSignalGate {
  const coalesceMs = Math.max(0, options.coalesceMs);
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const isVisible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let hasPending = false;
  let lastEmitAt = -Infinity;
  let timerHandle: unknown = null;

  const cancelTimer = () => {
    if (timerHandle !== null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
  };

  const tryFlush = () => {
    cancelTimer();
    if (!hasPending) return;
    if (options.isBusy() || !isVisible()) return;
    const elapsed = now() - lastEmitAt;
    if (coalesceMs > 0 && elapsed < coalesceMs) {
      timerHandle = setTimer(tryFlush, coalesceMs - elapsed);
      return;
    }
    hasPending = false;
    lastEmitAt = now();
    options.onEmit();
  };

  return {
    onSignal() {
      if (options.isBusy() || !isVisible()) {
        hasPending = true;
        return;
      }
      const elapsed = now() - lastEmitAt;
      if (coalesceMs <= 0 || elapsed >= coalesceMs) {
        cancelTimer();
        hasPending = false;
        lastEmitAt = now();
        options.onEmit();
        return;
      }
      hasPending = true;
      if (timerHandle === null) {
        timerHandle = setTimer(tryFlush, coalesceMs - elapsed);
      }
    },
    onSettled() {
      if (!hasPending || options.isBusy()) return;
      tryFlush();
    },
    onFallbackTick(isLive) {
      if (isLive || !isVisible() || options.isBusy()) return;
      cancelTimer();
      hasPending = false;
      lastEmitAt = now();
      options.onEmit();
    },
    reset() {
      cancelTimer();
      hasPending = false;
    },
  };
}
