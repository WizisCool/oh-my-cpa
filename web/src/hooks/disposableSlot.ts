/**
 * A slot that owns a disposable resource for exactly as long as one React effect
 * lifetime.
 *
 * React runs the sequence mount -> unmount -> mount for every component under
 * StrictMode in a development build. A slot that disposed its resource on the
 * first cleanup and then handed the *same* resource back on the second setup would
 * give every consumer a dead object: operations on it become silent no-ops, so a
 * control still animates and still reports nothing. That is not hypothetical - it
 * is what made the provider toggle stop working on the development server while
 * every production-bundle check passed, because StrictMode's checks do not run in
 * a production build.
 *
 * The rule this encodes: a cleanup disposes the resource and releases the slot, so
 * the next setup builds a fresh one. A cleanup must never leave a disposed
 * resource installed.
 *
 * It is a separate, framework-free unit so the sequence can be tested directly,
 * rather than being a rule that only exists in a comment.
 */
export interface DisposableSlot<T> {
  /** Installs a resource built by the factory, replacing and disposing any current one. */
  setup: () => T;
  /** Disposes the current resource and releases the slot. Idempotent. */
  teardown: () => void;
  /** The installed resource, or undefined when the slot is empty. */
  current: () => T | undefined;
}

export function createDisposableSlot<T extends { dispose: () => void }>(
  create: () => T,
): DisposableSlot<T> {
  let resource: T | undefined;

  return {
    setup: () => {
      // A setup while one is installed would strand the previous resource's timers,
      // so the previous one is disposed rather than dropped.
      resource?.dispose();
      resource = create();
      return resource;
    },
    teardown: () => {
      const installed = resource;
      // Released before disposing: disposing runs callbacks that could re-enter
      // this slot, and they must see an empty one rather than a resource that is
      // being torn down.
      resource = undefined;
      installed?.dispose();
    },
    current: () => resource,
  };
}
