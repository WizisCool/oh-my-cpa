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

/** The slice of a query the bar reads; structural so the policy is tested without a client. */
export interface ProgressQuery {
  queryHash: string;
  meta?: { silent?: boolean };
  state: { status: string; fetchStatus: string; data: unknown; isInvalidated: boolean };
}

/**
 * Whether a fetch is work the reader is waiting on.
 *
 * A read counts when nothing is on screen for it yet (a first load, a new key, a retry after a
 * failure) or when an action declared its data stale (an invalidation). A re-read of data already
 * shown - an interval poll, a reconnect, a stale remount - is background refresh and stays
 * invisible (docs/design.md §7). This is decided from the query's state rather than by each poll
 * opting in: an opt-in that one poll forgot raised the bar on every page whenever that poll took
 * longer than the show delay, which on a slow link was every tick.
 *
 * A failed fetch also marks a query invalidated, so the invalidation counts only on data that last
 * read successfully: otherwise one dropped poll on a slow link would raise the bar on every poll
 * after it until one succeeded.
 *
 * `meta.silent` still silences what the state cannot tell apart: a poll that moves to a new key on
 * every tick, and background reads that are silent even on their first load.
 */
export function isQueryProgressWork(query: ProgressQuery): boolean {
  if (query.state.fetchStatus !== 'fetching' || query.meta?.silent === true) return false;
  const { data, isInvalidated, status } = query.state;
  return data === undefined || (isInvalidated && status === 'success');
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
