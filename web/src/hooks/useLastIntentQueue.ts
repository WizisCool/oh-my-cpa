import React from 'react';
import {
  createLastIntentQueue,
  LastIntentQueueController,
  LastIntentControllerOptions,
} from './lastIntentQueue';
import { createDisposableSlot, DisposableSlot } from './disposableSlot';

export type { LastIntentQueueController } from './lastIntentQueue';
export { LastIntentTimeoutError } from './lastIntentQueue';

/**
 * useLastIntentQueue binds the framework-free last-intent controller to a React
 * component.
 *
 * The queue's policy - one write in flight per key, a click during that window
 * replaces the remembered value, bounded retries, one deadline per burst - lives
 * in `lastIntentQueue.ts` and is tested there directly. This wrapper owns only
 * what needs a component: the queue's lifetime, re-rendering when a key's busy
 * state or newest intent changes, and reading the latest callbacks so the queue is
 * never rebuilt mid-burst.
 *
 * The queue instance is created by the effect that owns it, and its cleanup
 * releases it, and both halves of that are load bearing. React runs mount ->
 * unmount -> mount for every component under StrictMode in development. An instance
 * created during render and disposed by that first cleanup would be reinstated
 * unchanged by the remount, leaving consumers holding a dead queue: every click
 * becomes a silent no-op, so the switch animates and sends nothing. Production
 * builds do not double-invoke effects, so this only ever appeared on the
 * development server while every production-bundle check passed.
 * `disposableSlot.ts` owns that rule so it can be tested on its own.
 *
 * Callbacks are read through a ref rather than captured: the page hands in
 * closures over its own state, and a controller that captured the first render's
 * closures would keep writing to stale ones.
 */
export function useLastIntentQueue<T>(
  options: Omit<LastIntentControllerOptions<T>, 'onChange'>,
): LastIntentQueueController<T> {
  const [, forceRender] = React.useReducer((count: number) => count + 1, 0);

  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  });

  const slotRef = React.useRef<DisposableSlot<LastIntentQueueController<T>> | undefined>(undefined);
  if (slotRef.current === undefined) {
    slotRef.current = createDisposableSlot(() =>
      createLastIntentQueue<T>({
        ...optionsRef.current,
        apply: (key, intent, signal) => optionsRef.current.apply(key, intent, signal),
        equals: (left, right) => (optionsRef.current.equals ?? Object.is)(left, right),
        isRetryable: (error) => optionsRef.current.isRetryable?.(error) ?? false,
        onError: (key, error) => optionsRef.current.onError?.(key, error),
        onConfirmed: (key, intent) => optionsRef.current.onConfirmed?.(key, intent),
        onSettled: (key) => optionsRef.current.onSettled?.(key),
        onChange: () => forceRender(),
      }),
    );
  }
  const slot = slotRef.current;

  React.useEffect(() => {
    slot.setup();
    // The rows rendered before this effect ran have no queue to read, so one render
    // is forced to publish it; otherwise the first paint after mount would show an
    // idle row backed by a queue that cannot accept a click.
    forceRender();
    // Teardown releases the slot as well as disposing the queue, so a StrictMode
    // remount builds a live one instead of reinstating the disposed queue. See
    // `disposableSlot.ts` for why that distinction is the whole point.
    return () => slot.teardown();
  }, [slot]);

  // Stable identities that read the queue at call time. Capturing it at render
  // would keep handing consumers whichever instance existed then, which is the same
  // stale-instance failure the slot exists to prevent.
  const request = React.useCallback(
    (key: string, intent: T) => slot.current()?.request(key, intent),
    [slot],
  );
  const targetFor = React.useCallback((key: string) => slot.current()?.targetFor(key), [slot]);
  const isBusy = React.useCallback((key: string) => slot.current()?.isBusy(key) ?? false, [slot]);
  const dispose = React.useCallback(() => slot.current()?.dispose(), [slot]);

  return { request, targetFor, isBusy, dispose };
}
