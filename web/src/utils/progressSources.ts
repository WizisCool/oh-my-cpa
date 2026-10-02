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
