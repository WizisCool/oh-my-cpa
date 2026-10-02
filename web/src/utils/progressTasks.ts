/**
 * In-flight work the loading bar counts besides queries: a lazy route's module download, the shell's
 * own download, a sign-in request.
 *
 * A module singleton rather than a context because the work it counts starts below Suspense
 * boundaries and outside any provider the bar can see - the shell's fallback renders before the
 * shell (and the bar inside it) exists at all.
 */

/** A source of in-flight task ids the loading bar reads; the ids only need to be stable while pending. */
export interface ProgressSource {
  read(): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
}

let nextTaskId = 0;
let inFlight: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(next: ReadonlySet<string>) {
  inFlight = next;
  for (const listener of listeners) listener();
}

/** Starts a task and returns the function that settles it; settling twice is harmless. */
export function beginProgressTask(): () => void {
  nextTaskId += 1;
  const id = `task:${nextTaskId}`;
  publish(new Set([...inFlight, id]));
  return () => {
    if (!inFlight.has(id)) return;
    const next = new Set(inFlight);
    next.delete(id);
    publish(next);
  };
}

export const progressTasks: ProgressSource = {
  read: () => inFlight,
  subscribe(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
