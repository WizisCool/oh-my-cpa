import React from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { NavigateOptions, To } from 'react-router-dom';
import type { RouteLoadingBody } from '../components/common/PageLoading';
import { bindSchedulerTransitionReader, sharedFrameScheduler } from './frameScheduler';
import { bindResizeHubTransitionSource } from './resizeObserverHub';

export type RoutePriority = 'critical' | 'high' | 'normal';
export type RouteTransitionMode = 'concurrent' | 'immediate';

export interface RoutePrefetchContext {
  readonly queryClient: QueryClient;
  readonly pathname: string;
  readonly search?: string;
  readonly timeZone: string;
}

export interface RouteDescriptor {
  /** Canonical path (e.g. `'/dashboard'`) or prefix when `matchPrefix` is true (e.g. `'/plugin-pages/'`). */
  readonly path: string;
  readonly matchPrefix?: boolean;
  /** Prewarming tier: `critical` warms first on boot/idle, followed by `high`; `normal` warms on intent. */
  readonly priority: RoutePriority;
  /** Skeleton geometry frame rendered while the route's chunk downloads. */
  readonly loadingBody?: RouteLoadingBody;
  /** Concurrent transition mode (`React.startTransition`) vs immediate synchronous navigation. */
  readonly transition?: RouteTransitionMode;
  /** Preloads the route's primary chunk and any critical lazy sub-chunks (e.g. ECharts modules). */
  readonly preloadChunk: () => Promise<unknown>;
  /**
   * Optional silent SWR data prewarmer invoked on authenticated navigation intent.
   * Must only read idempotent, secret-free, non-audited local endpoints (`meta: { silent: true }`).
   */
  readonly prefetchData?: (ctx: RoutePrefetchContext) => Promise<unknown> | void;
}

export interface RouteRegistryOptions {
  /** Cooldown window in ms preventing repeated intent prefetches on pointer sweep. Defaults to `2500`. */
  readonly intentCooldownMs?: number;
  readonly now?: () => number;
  readonly scheduleIdle?: (callback: () => void) => () => void;
  readonly isVisible?: () => boolean;
}

export interface RouteRegistry {
  readonly descriptors: readonly RouteDescriptor[];
  resolve: (pathname: string) => RouteDescriptor | undefined;
  preloadChunk: (pathname: string) => Promise<void>;
  warmIntent: (pathname: string, context?: RoutePrefetchContext) => void;
  /** Progressively prewarms `critical` and `high` route chunks during browser idle periods. */
  scheduleIdlePrewarm: (excludePath?: string) => () => void;
  resetCooldowns: () => void;
}

function normalizePathname(raw: string): string {
  const withoutQuery = raw.split('?')[0]?.split('#')[0] ?? '/';
  if (!withoutQuery || withoutQuery === '/') return '/dashboard';
  return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
}

function defaultScheduleIdle(callback: () => void): () => void {
  const win = typeof window !== 'undefined'
    ? (window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (id: number) => void;
      })
    : undefined;
  if (win && typeof win.requestIdleCallback === 'function') {
    const handle = win.requestIdleCallback(callback, { timeout: 1200 });
    return () => win.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(callback, 120);
  return () => clearTimeout(timer);
}

/**
 * Central registry binding route descriptors to chunk preloading, intent data prewarming, and
 * idle-time progressive warmups.
 */
export function createRouteRegistry(
  descriptors: readonly RouteDescriptor[],
  options: RouteRegistryOptions = {},
): RouteRegistry {
  const intentCooldownMs = options.intentCooldownMs ?? 2500;
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const scheduleIdle = options.scheduleIdle ?? defaultScheduleIdle;
  const isVisible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible');

  const exactMap = new Map<string, RouteDescriptor>();
  const prefixList: RouteDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.matchPrefix) prefixList.push(descriptor);
    else exactMap.set(descriptor.path, descriptor);
  }
  prefixList.sort((left, right) => right.path.length - left.path.length);

  const lastIntentAt = new Map<string, number>();

  const resolve = (rawPath: string): RouteDescriptor | undefined => {
    const pathname = normalizePathname(rawPath);
    const exact = exactMap.get(pathname);
    if (exact) return exact;
    return prefixList.find((entry) => pathname === entry.path || pathname.startsWith(entry.path));
  };

  const preloadChunk = async (rawPath: string): Promise<void> => {
    const descriptor = resolve(rawPath);
    if (!descriptor) return;
    await descriptor.preloadChunk().catch(() => undefined);
  };

  return {
    descriptors,
    resolve,
    preloadChunk,
    warmIntent(rawPath, context) {
      const descriptor = resolve(rawPath);
      if (!descriptor) return;
      void descriptor.preloadChunk().catch(() => undefined);
      if (!context || !descriptor.prefetchData) return;
      const key = `${descriptor.path}:${normalizePathname(rawPath)}`;
      const current = now();
      const previous = lastIntentAt.get(key);
      if (previous !== undefined && current - previous < intentCooldownMs) return;
      lastIntentAt.set(key, current);
      try {
        void Promise.resolve(descriptor.prefetchData(context)).catch(() => undefined);
      } catch {
        // Prefetch hints are strictly advisory and must never disrupt navigation.
      }
    },
    scheduleIdlePrewarm(excludePath) {
      const skipped = excludePath ? normalizePathname(excludePath) : undefined;
      const ordered = [
        ...descriptors.filter((d) => d.priority === 'critical' && d.path !== skipped),
        ...descriptors.filter((d) => d.priority === 'high' && d.path !== skipped),
      ];
      if (ordered.length === 0) return () => undefined;

      let index = 0;
      let cancelled = false;
      let cancelCurrent: (() => void) | undefined;

      const step = () => {
        cancelCurrent = undefined;
        if (cancelled) return;
        if (!isVisible()) return;
        const next = ordered[index++];
        if (!next) return;
        void next.preloadChunk().catch(() => undefined).finally(() => {
          if (!cancelled && index < ordered.length) {
            cancelCurrent = scheduleIdle(step);
          }
        });
      };

      cancelCurrent = scheduleIdle(step);
      return () => {
        cancelled = true;
        cancelCurrent?.();
      };
    },
    resetCooldowns() {
      lastIntentAt.clear();
    },
  };
}

export interface RouteTransitionStoreOptions {
  readonly requestFrame?: (callback: () => void) => unknown;
  readonly pokeScheduler?: () => void;
}

/**
 * Lightweight external store tracking active route transitions so frame-budgeted mounts and
 * `ResizeObserver` notifications yield while a view change commits.
 */
export function createRouteTransitionStore(options: RouteTransitionStoreOptions = {}) {
  const requestFrame = options.requestFrame
    ?? ((cb: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => cb()) : cb()));
  const pokeScheduler = options.pokeScheduler ?? (() => sharedFrameScheduler.poke());
  let activeCount = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
    pokeScheduler();
  };

  return {
    isPending: () => activeCount > 0,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markTransitionStart(): () => void {
      activeCount += 1;
      if (activeCount === 1) notify();
      let ended = false;
      const release = () => {
        if (ended) return;
        ended = true;
        clearTimeout(safetyTimer);
        requestFrame(() => {
          activeCount = Math.max(0, activeCount - 1);
          if (activeCount === 0) notify();
        });
      };
      // Safety ceiling guarantees an interrupted navigation never leaves background mounts frozen.
      const safetyTimer = setTimeout(release, 1200);
      return release;
    },
  };
}

export const routeTransitionStore = createRouteTransitionStore();

bindSchedulerTransitionReader(routeTransitionStore.isPending);
bindResizeHubTransitionSource(routeTransitionStore.isPending, routeTransitionStore.subscribe);

let activeRouteRegistry: RouteRegistry | undefined;

export function bindActiveRouteRegistry(registry: RouteRegistry | undefined): void {
  activeRouteRegistry = registry;
}

export function preloadRegisteredRoute(pathname: string): void {
  if (!activeRouteRegistry) return;
  void activeRouteRegistry.preloadChunk(pathname);
}

/**
 * Wraps `react-router`'s `navigate` in a concurrent React transition while publishing transition
 * activity to the shared frame scheduler and resize hub.
 */
export function useTransitionNavigate(
  navigate: (to: To, options?: NavigateOptions) => void | Promise<void>,
  registry: RouteRegistry | undefined = activeRouteRegistry,
) {
  const [isPending, startTransition] = React.useTransition();
  const pendingFinishRef = React.useRef<(() => void) | null>(null);

  // Runs after every committed render: when `startTransition` settles synchronously (because the
  // target route chunk was already prewarmed and `isPending` stayed `false`), the post-navigation
  // commit still releases `pendingFinishRef` immediately instead of stranding `routeTransitionStore`.
  React.useEffect(() => {
    if (!isPending && pendingFinishRef.current) {
      const finish = pendingFinishRef.current;
      pendingFinishRef.current = null;
      finish();
    }
  });

  React.useEffect(() => () => {
    if (pendingFinishRef.current) {
      const finish = pendingFinishRef.current;
      pendingFinishRef.current = null;
      finish();
    }
  }, []);

  const navigateTo = React.useCallback((to: To, options?: NavigateOptions) => {
    const targetPath = typeof to === 'string' ? to : to.pathname ?? '';
    const descriptor = targetPath && registry ? registry.resolve(targetPath) : undefined;
    if (targetPath && registry) {
      void registry.preloadChunk(targetPath);
    }
    if (descriptor?.transition === 'immediate') {
      void navigate(to, options);
      return;
    }
    pendingFinishRef.current?.();
    const finish = routeTransitionStore.markTransitionStart();
    pendingFinishRef.current = finish;
    startTransition(() => {
      const maybePromise = navigate(to, options);
      if (maybePromise && typeof (maybePromise as Promise<void>).finally === 'function') {
        void (maybePromise as Promise<void>).finally(() => {
          if (pendingFinishRef.current === finish) {
            pendingFinishRef.current = null;
            finish();
          }
        });
      }
    });
  }, [navigate, registry]);

  return { isPending, navigateTo };
}
