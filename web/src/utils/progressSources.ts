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
 * background refresh and stays invisible (docs/design.md §7) - including the poll after a failed
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
  if (query.state.fetchStatus !== 'fetching' || query.meta?.silent === true) return false;
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
