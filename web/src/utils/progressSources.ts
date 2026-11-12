import type { QueryCache } from '@tanstack/react-query';
import type { ProgressSource } from './progressTasks';

/** Several sources read as one: the union of their ids, which must not collide across sources. */
export function mergeProgressSources(...sources: ProgressSource[]): ProgressSource {
  return {
    read() {
      const ids = new Set<string>();
      for (const source of sources) for (const id of source.read()) ids.add(id);
      return ids;
    },
    subscribe(listener) {
      const unsubscribers = sources.map((source) => source.subscribe(listener));
      return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
    },
  };
}

type RefetchInterval = number | false | undefined | ((query: never) => number | false | undefined);

const silentBackgroundQueries = new Set<string>();

/**
 * Invalidates a query for background SWR reconciliation without lighting the app-wide top-edge
 * DataProgress bar while cached data is already rendered on screen. If no fetch starts (for
 * example, no active observer), the marker is skipped cleanly; once a fetch begins, the marker
 * clears automatically as soon as fetchStatus returns to idle.
 */
export async function invalidateQueriesSilently(
  queryClient: {
    getQueryCache(): {
      findAll(filters?: { queryKey?: readonly unknown[]; exact?: boolean }): Array<{
        queryHash: string;
        state: { data: unknown; fetchStatus: string };
      }>;
      subscribe(listener: (event: { type?: string; query?: { queryHash: string; state: { fetchStatus: string } } }) => void): () => void;
    };
    invalidateQueries(filters?: { queryKey?: readonly unknown[]; exact?: boolean }): Promise<void>;
  },
  filters: { queryKey: readonly unknown[]; exact?: boolean },
): Promise<void> {
  const cache = queryClient.getQueryCache();
  const candidates = cache
    .findAll(filters)
    .filter((query) => query.state.data !== undefined)
    .map((query) => query.queryHash);

  if (candidates.length === 0) {
    await queryClient.invalidateQueries(filters);
    return;
  }

  for (const hash of candidates) {
    silentBackgroundQueries.add(hash);
  }

  let didStartFetching = false;
  const unsubscribe = cache.subscribe((event) => {
    const query = event.query;
    if (!query || !silentBackgroundQueries.has(query.queryHash)) return;
    if (query.state.fetchStatus === 'fetching') {
      didStartFetching = true;
    } else if (didStartFetching) {
      // Only clear once a background fetch actually ran and transitioned back to idle.
      // Ignoring the synchronous 'invalidated' cache event (where fetchStatus is still 'idle'
      // before refetchQueries starts the request) is what keeps DataProgress suppressed!
      silentBackgroundQueries.delete(query.queryHash);
    }
  });

  try {
    await queryClient.invalidateQueries(filters);
  } finally {
    unsubscribe();
    for (const query of cache.findAll(filters)) {
      if (query.state.fetchStatus !== 'fetching') {
        silentBackgroundQueries.delete(query.queryHash);
      }
    }
  }
}

/** The slice of a query the bar reads; structural so the policy is tested without a client. */
export interface ProgressQuery {
  queryHash: string;
  meta?: { silent?: boolean };
  state: { status: string; fetchStatus: string; data: unknown; isInvalidated: boolean };
  observers: ReadonlyArray<{ options: { refetchInterval?: RefetchInterval } }>;
}

/** Whether any mounted reader re-reads this query on a timer right now. */
function isPolled(query: ProgressQuery): boolean {
  return query.observers.some(({ options: { refetchInterval } }) => {
    const interval = typeof refetchInterval === 'function' ? refetchInterval(query as never) : refetchInterval;
    return typeof interval === 'number' && interval > 0;
  });
}

/**
 * Whether a fetch is work the reader is waiting on.
 *
 * A read counts when nothing is on screen for it yet (a first load, a new key, a retry after a
 * failure), when an action invalidated data that last read successfully, or when a query nobody
 * polls is re-read (a refresh button). A polled query re-reading the data it already shows is
 * background refresh and stays invisible - including the poll after a failed
 * one, since a failed fetch also marks its query invalidated.
 *
 * This is decided from the query rather than by each poll opting in: an opt-in that one poll forgot
 * raised the bar on every page whenever that poll outlasted the show delay, which on a slow link was
 * every tick. The query state cannot say what started a fetch - an interval tick and a manual
 * `refetch()` look the same - so a refresh that must report waiting on a polled query invalidates it.
 *
 * `meta.silent` still silences what the query cannot tell apart: a live read that moves to a new
 * key on every signal, and background reads that are silent even on their first load.
 */
export function isQueryProgressWork(query: ProgressQuery): boolean {
  if (query.state.fetchStatus !== 'fetching') {
    return false;
  }
  if (query.meta?.silent === true) return false;
  if (silentBackgroundQueries.has(query.queryHash) && query.state.data !== undefined) {
    return false;
  }
  const { data, isInvalidated, status } = query.state;
  return data === undefined || (isInvalidated && status === 'success') || !isPolled(query);
}

/** The queries the bar counts, by hash. */
export function queryProgressSource(cache: Pick<QueryCache, 'subscribe'> & { getAll(): ProgressQuery[] }): ProgressSource {
  return {
    read() {
      const ids = new Set<string>();
      for (const query of cache.getAll()) {
        if (isQueryProgressWork(query)) ids.add(`query:${query.queryHash}`);
      }
      return ids;
    },
    subscribe: (listener) => cache.subscribe(listener),
  };
}
