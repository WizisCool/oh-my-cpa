import type {
  QueryClient,
  QueryKey,
  UseMutationOptions,
} from '@tanstack/react-query';
import { invalidateQueriesSilently } from '../utils/progressSources';

/**
 * Describes one TanStack Query cache entry updated optimistically during onMutate
 * and restored automatically on error.
 */
export interface OptimisticCacheTarget<TVariables> {
  readonly queryKey: QueryKey;
  readonly apply: (queryClient: QueryClient, variables: TVariables) => void;
}

export interface CapturedCacheEntry {
  readonly queryKey: QueryKey;
  readonly previous: unknown;
}

export interface OptimisticMutationContext<TCustomContext = undefined> {
  readonly snapshots: ReadonlyArray<CapturedCacheEntry>;
  readonly custom: TCustomContext;
}

export interface OptimisticMutationConfig<
  TData,
  TError = unknown,
  TVariables = void,
  TCustomContext = undefined,
> {
  /**
   * Required mutationKey shared by concurrent invocations of this logical action.
   * Used in onSettled via queryClient.isMutating({ mutationKey }) === 1 to ensure
   * invalidateQueries runs ONLY when the final in-flight mutation settles, preventing
   * earlier out-of-order responses from flashing stale state over newer clicks.
   */
  readonly mutationKey: QueryKey;
  /**
   * Optional TanStack Query v5 mutation scope (`{ id }`) to serialize mutations
   * that rely on positional list indices (such as client API key updates/deletes).
   */
  readonly scope?: { readonly id: string };
  readonly mutationFn: (variables: TVariables) => Promise<TData>;
  /**
   * One or more cache targets cancelled, snapshotted, and mutated synchronously in onMutate.
   */
  readonly targets: ReadonlyArray<OptimisticCacheTarget<TVariables>>;
  /**
   * Additional query keys invalidated alongside targets when the final concurrent mutation settles.
   */
  readonly invalidateKeys?: ReadonlyArray<QueryKey>;
  /**
   * Optional custom preparation inside onMutate after cache snapshots are taken.
   */
  readonly onPrepare?: (variables: TVariables) => TCustomContext | Promise<TCustomContext>;
  readonly onSuccess?: (
    data: TData,
    variables: TVariables,
    context: OptimisticMutationContext<TCustomContext>,
  ) => void | Promise<void>;
  readonly onError?: (
    error: TError,
    variables: TVariables,
    context: OptimisticMutationContext<TCustomContext> | undefined,
  ) => void | Promise<void>;
  readonly onFinalSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
  ) => void | Promise<void>;
}

/**
 * Helper to create a strongly typed OptimisticCacheTarget without erasing TCache at the call site.
 */
export function defineOptimisticTarget<TVariables, TCache>(
  queryKey: QueryKey,
  updater: (current: TCache | undefined, variables: TVariables) => TCache | undefined,
): OptimisticCacheTarget<TVariables> {
  return {
    queryKey,
    apply(queryClient, variables) {
      queryClient.setQueryData<TCache | undefined>(queryKey, (current) =>
        updater(current, variables),
      );
    },
  };
}

/**
 * Builds standard, race-safe TanStack Query optimistic mutation options:
 *  - onMutate: cancels in-flight reads for all target keys, snapshots previous values,
 *    and synchronously applies optimistic cache updates on the click frame.
 *  - onError: restores every snapshotted cache key to its exact pre-mutation value.
 *  - onSettled: checks queryClient.isMutating({ mutationKey }) <= 1 (=== 1 inside
 *    MutationObserver.onSettled for the last queued mutation in TanStack Query v5)
 *    so background revalidation fires ONLY after rapid consecutive clicks finish.
 */
export function buildOptimisticMutationOptions<
  TData,
  TError = unknown,
  TVariables = void,
  TCustomContext = undefined,
>(
  queryClient: QueryClient,
  config: OptimisticMutationConfig<TData, TError, TVariables, TCustomContext>,
): UseMutationOptions<TData, TError, TVariables, OptimisticMutationContext<TCustomContext>> {
  const collectInvalidationKeys = (): QueryKey[] => {
    const seen = new Set<string>();
    const keys: QueryKey[] = [];
    const push = (key: QueryKey) => {
      const id = JSON.stringify(key);
      if (!seen.has(id)) {
        seen.add(id);
        keys.push(key);
      }
    };
    for (const target of config.targets) push(target.queryKey);
    for (const extra of config.invalidateKeys ?? []) push(extra);
    return keys;
  };

  return {
    mutationKey: config.mutationKey,
    ...(config.scope ? { scope: config.scope } : {}),
    mutationFn: config.mutationFn,
    onMutate(variables) {
      // 1. Trigger queryClient.cancelQueries immediately (which synchronously aborts
      //    any in-flight AbortController on matching queries), then snapshot and apply
      //    setQueryData synchronously BEFORE awaiting cancel settlement so React paints
      //    the optimistic UI in the exact click frame with zero microtask delay.
      const cancelPromise = Promise.all(
        config.targets.map((target) =>
          queryClient.cancelQueries({ queryKey: target.queryKey, exact: true }),
        ),
      );

      // 2. Snapshot current cache values before mutating for atomic rollback on failure.
      const snapshots: CapturedCacheEntry[] = config.targets.map((target) => ({
        queryKey: target.queryKey,
        previous: queryClient.getQueryData(target.queryKey),
      }));

      // 3. Apply synchronous in-place cache updates so React renders on the same frame.
      for (const target of config.targets) {
        target.apply(queryClient, variables);
      }

      if (!config.onPrepare) {
        return cancelPromise.then(() => ({
          snapshots,
          custom: undefined as TCustomContext,
        }));
      }
      return cancelPromise.then(async () => ({
        snapshots,
        custom: await config.onPrepare!(variables),
      }));
    },

    async onError(error, variables, context) {
      // Restore pre-mutation snapshots only when no newer mutation for the same
      // mutationKey is still in flight; if a newer click is pending, its own
      // settlement (or final-settle silent revalidation) owns the authoritative state.
      const activeCount = queryClient.isMutating({ mutationKey: config.mutationKey });
      if (activeCount <= 1 && context?.snapshots) {
        for (const entry of context.snapshots) {
          queryClient.setQueryData(entry.queryKey, entry.previous);
        }
      }
      await config.onError?.(error, variables, context);
    },

    async onSuccess(data, variables, context) {
      await config.onSuccess?.(data, variables, context);
    },

    async onSettled(data, error, variables) {
      // Critical anti-flicker guard: inside TanStack Query v5's MutationObserver.onSettled,
      // the settling mutation itself is still counted in isMutating() (returning 1 when it
      // is the final active mutation, or >= 2 when newer clicks are still in flight).
      // Checking <= 1 also covers direct unit-test harnesses that inspect post-transition state.
      const activeCount = queryClient.isMutating({ mutationKey: config.mutationKey });
      if (activeCount <= 1) {
        const keysToInvalidate = collectInvalidationKeys();
        await Promise.all(
          keysToInvalidate.map((queryKey) =>
            invalidateQueriesSilently(queryClient, { queryKey }),
          ),
        );
        await config.onFinalSettled?.(data, error, variables);
      }
    },
  };
}
