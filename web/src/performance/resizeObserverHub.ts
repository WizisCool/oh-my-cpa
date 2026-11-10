import React from 'react';

export interface ObservedBoxSize {
  readonly width: number;
  readonly height: number;
}

export interface ResizeSubscriptionOptions {
  /**
   * Defer resize callbacks while a route transition is active, delivering the settled box on the
   * next animation frame so incoming/outgoing views do not recalculate chart geometry mid-fade.
   */
  freezeOnTransition?: boolean;
  /** Minimum dimension delta in pixels required to emit an update. Defaults to `0.5`. */
  epsilonPx?: number;
}

export type ResizeSubscriberCallback = (size: ObservedBoxSize) => void;

export interface ResizeObserverHubDeps {
  createObserver?: (callback: ResizeObserverCallback) => Pick<ResizeObserver, 'observe' | 'unobserve' | 'disconnect'> | null;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  isTransitionPending?: () => boolean;
  subscribeTransition?: (listener: () => void) => () => void;
}

interface SubscriberRecord {
  readonly callback: ResizeSubscriberCallback;
  readonly freezeOnTransition: boolean;
  readonly epsilonPx: number;
  lastDelivered: ObservedBoxSize | null;
  deferredSize: ObservedBoxSize | null;
  active: boolean;
}

export interface ResizeObserverHub {
  observe: (element: Element, callback: ResizeSubscriberCallback, options?: ResizeSubscriptionOptions) => () => void;
  observedElementCount: () => number;
  dispose: () => void;
}

function defaultCreateObserver(callback: ResizeObserverCallback) {
  if (typeof ResizeObserver === 'undefined') return null;
  return new ResizeObserver(callback);
}

/**
 * Multiplexes element size observations onto a single shared `ResizeObserver`.
 *
 * Browser layout engines evaluate a single observer tracking N targets significantly faster than N
 * separate `ResizeObserver` instances, and extracting all `contentRect` boxes before running any
 * listener avoids interleaved DOM write/read layout thrashing across peer charts.
 */
export function createResizeObserverHub(deps: ResizeObserverHubDeps = {}): ResizeObserverHub {
  const makeObserver = deps.createObserver ?? defaultCreateObserver;
  const requestFrame = deps.requestFrame ?? ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : Number(setTimeout(() => cb(0), 0))));
  const cancelFrame = deps.cancelFrame ?? ((id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)));
  const isTransitionPending = deps.isTransitionPending ?? (() => false);

  const byElement = new Map<Element, Set<SubscriberRecord>>();
  const lastSizeByElement = new Map<Element, ObservedBoxSize>();
  const deferredSubscribers = new Set<SubscriberRecord>();
  let observer: ReturnType<typeof makeObserver> = null;
  let detachTransition: (() => void) | undefined;
  let flushFrame: number | undefined;
  let isDisposed = false;

  const hasMeaningfulChange = (prev: ObservedBoxSize | null, next: ObservedBoxSize, epsilon: number): boolean => {
    if (!prev) return true;
    return Math.abs(prev.width - next.width) >= epsilon || Math.abs(prev.height - next.height) >= epsilon;
  };

  const deliver = (record: SubscriberRecord, size: ObservedBoxSize) => {
    if (!record.active) return;
    if (!hasMeaningfulChange(record.lastDelivered, size, record.epsilonPx)) return;
    record.lastDelivered = size;
    record.callback(size);
  };

  const flushDeferred = () => {
    flushFrame = undefined;
    if (isDisposed || isTransitionPending()) return;
    const pending = [...deferredSubscribers];
    deferredSubscribers.clear();
    for (const record of pending) {
      const size = record.deferredSize;
      record.deferredSize = null;
      if (size) deliver(record, size);
    }
  };

  const scheduleDeferredFlush = () => {
    if (flushFrame !== undefined || deferredSubscribers.size === 0 || isTransitionPending()) return;
    flushFrame = requestFrame(flushDeferred);
  };

  const handleEntries: ResizeObserverCallback = (entries) => {
    if (isDisposed) return;
    // Phase 1: Collect all measured boxes before any subscriber mutates DOM/SVG attributes.
    const measured: Array<{ subscribers: readonly SubscriberRecord[]; size: ObservedBoxSize }> = [];
    for (const entry of entries) {
      const set = byElement.get(entry.target);
      if (!set || set.size === 0) continue;
      const { width, height } = entry.contentRect;
      // Ignore 0x0 observations from detached or collapsed transient nodes.
      if (!(width > 0 && height > 0)) continue;
      const size = { width, height };
      lastSizeByElement.set(entry.target, size);
      measured.push({ subscribers: [...set], size });
    }

    const transitioning = isTransitionPending();
    // Phase 2: Dispatch updates (or hold transition-frozen subscribers until transition end).
    for (const { subscribers, size } of measured) {
      for (const record of subscribers) {
        if (!record.active) continue;
        if (transitioning && record.freezeOnTransition && record.lastDelivered !== null) {
          record.deferredSize = size;
          deferredSubscribers.add(record);
          continue;
        }
        record.deferredSize = null;
        deferredSubscribers.delete(record);
        deliver(record, size);
      }
    }
  };

  const ensureObserver = () => {
    if (!observer && !isDisposed) {
      observer = makeObserver(handleEntries);
    }
    if (!detachTransition && deps.subscribeTransition) {
      detachTransition = deps.subscribeTransition(() => {
        if (!isTransitionPending()) scheduleDeferredFlush();
      });
    }
    return observer;
  };

  const cleanupIfIdle = () => {
    if (byElement.size > 0) return;
    if (flushFrame !== undefined) {
      cancelFrame(flushFrame);
      flushFrame = undefined;
    }
    deferredSubscribers.clear();
    observer?.disconnect();
    observer = null;
    detachTransition?.();
    detachTransition = undefined;
  };

  return {
    observe(element, callback, options = {}) {
      if (isDisposed) return () => undefined;
      const obs = ensureObserver();
      if (!obs) return () => undefined;

      const record: SubscriberRecord = {
        callback,
        freezeOnTransition: options.freezeOnTransition ?? true,
        epsilonPx: options.epsilonPx ?? 0.5,
        lastDelivered: null,
        deferredSize: null,
        active: true,
      };

      let set = byElement.get(element);
      const isFirstForElement = !set;
      if (!set) {
        set = new Set();
        byElement.set(element, set);
      }
      set.add(record);
      let initialFrame: number | undefined;
      if (isFirstForElement) {
        obs.observe(element);
      } else {
        const known = lastSizeByElement.get(element);
        if (known) {
          initialFrame = requestFrame(() => {
            initialFrame = undefined;
            if (!record.active || isDisposed) return;
            if (isTransitionPending() && record.freezeOnTransition && record.lastDelivered !== null) {
              record.deferredSize = known;
              deferredSubscribers.add(record);
              return;
            }
            deliver(record, known);
          });
        }
      }

      return () => {
        if (!record.active) return;
        record.active = false;
        if (initialFrame !== undefined) {
          cancelFrame(initialFrame);
          initialFrame = undefined;
        }
        deferredSubscribers.delete(record);
        const currentSet = byElement.get(element);
        if (!currentSet) return;
        currentSet.delete(record);
        if (currentSet.size === 0) {
          byElement.delete(element);
          lastSizeByElement.delete(element);
          observer?.unobserve(element);
          cleanupIfIdle();
        }
      };
    },
    observedElementCount() {
      return byElement.size;
    },
    dispose() {
      isDisposed = true;
      byElement.forEach((set) => {
        set.forEach((record) => {
          record.active = false;
        });
      });
      byElement.clear();
      lastSizeByElement.clear();
      cleanupIfIdle();
    },
  };
}

let hubTransitionReader: (() => boolean) | undefined;
let hubTransitionSubscriber: ((listener: () => void) => () => void) | undefined;

export function bindResizeHubTransitionSource(
  isPending: () => boolean,
  subscribe: (listener: () => void) => () => void,
): void {
  hubTransitionReader = isPending;
  hubTransitionSubscriber = subscribe;
}

export const sharedResizeObserverHub = createResizeObserverHub({
  isTransitionPending: () => Boolean(hubTransitionReader?.()),
  subscribeTransition: (listener) => (hubTransitionSubscriber ? hubTransitionSubscriber(listener) : () => undefined),
});

/**
 * Subscribes a React ref to the shared `ResizeObserver` hub with stable callback semantics.
 */
export function useSharedResizeObserver<T extends Element>(
  ref: React.RefObject<T | null>,
  onResize: ResizeSubscriberCallback,
  options?: ResizeSubscriptionOptions & { enabled?: boolean },
): void {
  const callbackRef = React.useRef(onResize);
  callbackRef.current = onResize;
  const enabled = options?.enabled ?? true;
  const freezeOnTransition = options?.freezeOnTransition ?? true;
  const epsilonPx = options?.epsilonPx ?? 0.5;

  React.useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return undefined;
    return sharedResizeObserverHub.observe(
      element,
      (size) => callbackRef.current(size),
      { freezeOnTransition, epsilonPx },
    );
  }, [ref, enabled, freezeOnTransition, epsilonPx]);
}
