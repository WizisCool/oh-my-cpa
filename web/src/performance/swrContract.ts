import {
  keepPreviousData,
  useQuery,
  type QueryClient,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';

export type SwrPlaceholderStrategy = 'keepPrevious' | 'sameScope' | 'none';

export interface SwrQueryDescriptor<TParams, TData, TKey extends QueryKey = QueryKey> {
  /** Logical namespace used for targeted prefix invalidation (e.g. `'dashboard'`, `'insights-cube'`). */
  readonly scope: string;
  /** Optional cross-cutting invalidation tags (e.g. `['usage', 'pricing']`). */
  readonly tags?: readonly string[];
  /** Freshness TTL in milliseconds during which route remounts render cached data with zero network calls. */
  readonly staleTime: number;
  /** Garbage-collection retention window in milliseconds for warm route revisits. */
  readonly gcTime?: number;
  /** Builds the canonical TanStack Query key including derived context (window, timezone, grouping). */
  readonly key: (params: TParams) => TKey;
  /** Executes the underlying API request; TanStack Query deduplicates concurrent in-flight reads. */
  readonly fetcher: (params: TParams) => Promise<TData>;
  /** Controls how placeholder data behaves when parameters change. Defaults to `'keepPrevious'`. */
  readonly placeholderStrategy?: SwrPlaceholderStrategy;
  /**
   * Optional scope identity extracted from a `QueryKey` when `placeholderStrategy === 'sameScope'`.
   * Prevents stale data from a different query scope leaking across incompatible transitions.
   */
  readonly keyScope?: (queryKey: QueryKey) => unknown;
  /** Suppresses the global top-edge progress bar for background or silent reads. */
  readonly silent?: boolean;
}

export interface SwrQueryRuntimeOverrides<TData, TKey extends QueryKey = QueryKey> {
  readonly enabled?: boolean;
  readonly refetchInterval?: UseQueryOptions<TData, Error, TData, TKey>['refetchInterval'];
  readonly refetchOnWindowFocus?: boolean;
  readonly silent?: boolean;
  readonly staleTime?: number;
}

export interface DefinedSwrQuery<TParams, TData, TKey extends QueryKey = QueryKey> {
  readonly descriptor: SwrQueryDescriptor<TParams, TData, TKey>;
  readonly queryOptions: (params: TParams, overrides?: SwrQueryRuntimeOverrides<TData, TKey>) => UseQueryOptions<TData, Error, TData, TKey>;
  /** Prewarms the cache silently while respecting `staleTime` and deduplicating in-flight requests. */
  readonly prefetch: (queryClient: QueryClient, params: TParams) => Promise<void>;
  /** Synchronously reads the current cached snapshot without triggering a network request. */
  readonly readSnapshot: (queryClient: QueryClient, params: TParams) => TData | undefined;
  /**
   * Atomically writes or folds a snapshot in `QueryClient` cache.
   * Passing `shouldAccept` guards against stale out-of-order responses rolling back newer data.
   */
  readonly writeSnapshot: (
    queryClient: QueryClient,
    params: TParams,
    updater: TData | ((current: TData | undefined) => TData | undefined),
    shouldAccept?: (current: TData | undefined, candidate: TData | undefined) => boolean,
  ) => TData | undefined;
  /** Invalidates either a specific parameterized entry or the entire descriptor `scope`. */
  readonly invalidate: (queryClient: QueryClient, params?: TParams) => Promise<void>;
}

const TAG_REGISTRY = new Map<string, Set<string>>();

function registerScopeTags(scope: string, tags: readonly string[] | undefined): void {
  if (!tags) return;
  for (const tag of tags) {
    let scopes = TAG_REGISTRY.get(tag);
    if (!scopes) {
      scopes = new Set();
      TAG_REGISTRY.set(tag, scopes);
    }
    scopes.add(scope);
  }
}

/**
 * Declares a strongly-typed Stale-While-Revalidate query contract backed directly by TanStack Query.
 *
 * Centralizing key construction, TTLs, snapshot folding, and scoped invalidation gives views 0ms
 * cached rendering on route revisits and monotonic live-tail patching without introducing a second
 * competing cache layer.
 */
export function defineSwrQuery<TParams, TData, TKey extends QueryKey = QueryKey>(
  descriptor: SwrQueryDescriptor<TParams, TData, TKey>,
): DefinedSwrQuery<TParams, TData, TKey> {
  registerScopeTags(descriptor.scope, descriptor.tags);

  const buildOptions = (
    params: TParams,
    overrides: SwrQueryRuntimeOverrides<TData, TKey> = {},
  ): UseQueryOptions<TData, Error, TData, TKey> => {
    const queryKey = descriptor.key(params);
    const strategy = descriptor.placeholderStrategy ?? 'keepPrevious';
    let placeholderData: UseQueryOptions<TData, Error, TData, TKey>['placeholderData'];

    if (strategy === 'keepPrevious') {
      placeholderData = keepPreviousData;
    } else if (strategy === 'sameScope') {
      const resolveScope = descriptor.keyScope ?? ((key: QueryKey) => key[1]);
      const targetScope = resolveScope(queryKey);
      placeholderData = (previousData, previousQuery) =>
        previousQuery && Object.is(resolveScope(previousQuery.queryKey), targetScope)
          ? previousData
          : undefined;
    }

    const isSilent = overrides.silent ?? descriptor.silent;

    return {
      queryKey,
      queryFn: () => descriptor.fetcher(params),
      staleTime: overrides.staleTime ?? descriptor.staleTime,
      ...(descriptor.gcTime !== undefined ? { gcTime: descriptor.gcTime } : {}),
      ...(placeholderData !== undefined ? { placeholderData } : {}),
      ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
      ...(overrides.refetchInterval !== undefined ? { refetchInterval: overrides.refetchInterval } : {}),
      ...(overrides.refetchOnWindowFocus !== undefined ? { refetchOnWindowFocus: overrides.refetchOnWindowFocus } : {}),
      ...(isSilent !== undefined ? { meta: { silent: isSilent } } : {}),
    };
  };

  return {
    descriptor,
    queryOptions: buildOptions,
    async prefetch(queryClient, params) {
      await queryClient.prefetchQuery({
        queryKey: descriptor.key(params),
        queryFn: () => descriptor.fetcher(params),
        staleTime: descriptor.staleTime,
        ...(descriptor.gcTime !== undefined ? { gcTime: descriptor.gcTime } : {}),
        meta: { silent: true },
      });
    },
    readSnapshot(queryClient, params) {
      return queryClient.getQueryData<TData>(descriptor.key(params));
    },
    writeSnapshot(queryClient, params, updater, shouldAccept) {
      const key = descriptor.key(params);
      return queryClient.setQueryData<TData | undefined>(key, (current) => {
        const candidate = typeof updater === 'function'
          ? (updater as (prev: TData | undefined) => TData | undefined)(current)
          : updater;
        if (shouldAccept && !shouldAccept(current, candidate)) return current;
        return candidate;
      });
    },
    async invalidate(queryClient, params) {
      const queryKey = params !== undefined ? descriptor.key(params) : [descriptor.scope];
      await queryClient.invalidateQueries({ queryKey });
    },
  };
}

/**
 * Subscribes a component to a `DefinedSwrQuery` contract with full TanStack Query reactivity.
 */
export function useSwrQuery<TParams, TData, TKey extends QueryKey = QueryKey>(
  contract: DefinedSwrQuery<TParams, TData, TKey>,
  params: TParams,
  overrides?: SwrQueryRuntimeOverrides<TData, TKey>,
): UseQueryResult<TData, Error> {
  return useQuery(contract.queryOptions(params, overrides));
}

/**
 * Invalidates all queries matching one or more scopes or registered tag names.
 */
export async function invalidateSwrScopes(
  queryClient: QueryClient,
  scopesOrTags: string | readonly string[],
): Promise<void> {
  const list = typeof scopesOrTags === 'string' ? [scopesOrTags] : scopesOrTags;
  const prefixes = new Set<string>();
  for (const entry of list) {
    const tagged = TAG_REGISTRY.get(entry);
    if (tagged && tagged.size > 0) {
      for (const scope of tagged) prefixes.add(scope);
    } else {
      prefixes.add(entry);
    }
  }
  await Promise.all(
    [...prefixes].map((scope) => queryClient.invalidateQueries({ queryKey: [scope] })),
  );
}
