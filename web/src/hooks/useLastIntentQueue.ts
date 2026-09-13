import React from 'react';

/**
 * useLastIntentQueue runs one serialised, coalescing queue per key, so that what
 * the server ends up holding is always the operator's *last* intent.
 *
 * The problem it solves: a toggle writes to a remote gateway, and the console
 * only learns the new state by re-reading afterwards. Between the write landing
 * and the re-read arriving, a second click is very likely - the operator clicks,
 * sees nothing change yet, and clicks again. The two naive handlings both lose:
 *
 *   - Firing both requests leaves them racing. The gateway applies them in
 *     arrival order, which is not necessarily click order, and whichever list
 *     read resolves last decides what the screen shows. The result is a control
 *     that disagrees with the gateway, which is the one outcome that must not
 *     happen.
 *   - Dropping the second request while the first is in flight (or locking every
 *     row until it settles) makes the second click a no-op, so the final state is
 *     whatever the first click asked for - the opposite of the operator's last
 *     intent.
 *
 * So a key has at most one request in flight, and a click during that window is
 * *remembered* rather than dropped or sent. When the in-flight request settles,
 * whatever the key remembers now is sent. Three clicks during one round trip
 * therefore cost one extra request, never three - the intermediate values are
 * states nobody wants to observe - and no two requests for one key are ever in
 * flight together, so they cannot land out of order.
 *
 * Serialisation is per key: an update to one provider never blocks another.
 *
 * `onSettled` runs once a key's queue has drained, after the last write landed.
 * Re-reading there rather than after every write is deliberate: two overlapping
 * refetches of the same query are the other way a stale response wins.
 */
export interface LastIntentQueue<T> {
  /** Records the operator's newest intent for a key and starts draining it. */
  request: (key: string, intent: T) => void;
  /**
   * The value the control should display for a key: the operator's newest intent
   * while the queue is working toward it, and nothing once the server holds it.
   * A caller renders `targetFor(key) ?? serverValue`, so a click is visible on
   * the frame it happened instead of flicking back to the old state while the
   * request is in flight.
   */
  targetFor: (key: string) => T | undefined;
  /** Whether a key still has work queued or in flight. */
  isBusy: (key: string) => boolean;
}

export function useLastIntentQueue<T>({
  apply,
  equals = Object.is,
  onError,
  onSettled,
}: {
  /** Applies one intent to the server. */
  apply: (key: string, intent: T) => Promise<void>;
  /** Whether two intents are the same value. */
  equals?: (left: T, right: T) => boolean;
  /** Reports a failure so the row can say what went wrong. */
  onError?: (key: string, error: unknown) => void;
  /** Runs once a key's queue has drained, whether it succeeded or failed. */
  onSettled?: (key: string) => void;
}): LastIntentQueue<T> {
  // The newest intent each key is working toward, and the last value a write
  // confirmed *during the current burst*. Both are Maps rather than state because
  // the drain loop reads them synchronously between awaits; only the busy set is
  // rendered.
  //
  // The confirmed side is scoped to one burst on purpose. Remembering it across
  // drains would let a click be dropped whenever the server changed underneath -
  // someone else toggling the same provider - because the recorded value would
  // still look "already applied". Clearing it when the queue drains means the only
  // write avoided is the genuinely redundant one: the same value the burst just
  // sent.
  const targetRef = React.useRef(new Map<string, T>());
  const confirmedRef = React.useRef(new Map<string, T>());
  const drainingRef = React.useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = React.useState<ReadonlySet<string>>(new Set());

  // Read through refs so `request` stays reference-stable across renders: it is
  // handed to every row, and a new identity per render would defeat React.memo.
  const applyRef = React.useRef(apply);
  const equalsRef = React.useRef(equals);
  const onErrorRef = React.useRef(onError);
  const onSettledRef = React.useRef(onSettled);
  React.useEffect(() => {
    applyRef.current = apply;
    equalsRef.current = equals;
    onErrorRef.current = onError;
    onSettledRef.current = onSettled;
  });

  const drain = React.useCallback(async (key: string) => {
    if (drainingRef.current.has(key)) return;
    drainingRef.current.add(key);
    try {
      for (;;) {
        const target = targetRef.current.get(key);
        // Nothing asked for, so this key is done and the control can fall back to
        // whatever the server reports.
        if (target === undefined) break;
        const confirmed = confirmedRef.current.get(key);
        if (confirmed !== undefined && equalsRef.current(confirmed, target)) {
          // The gateway already holds the newest intent, so sending it again
          // would be a redundant write.
          targetRef.current.delete(key);
          break;
        }
        try {
          await applyRef.current(key, target);
        } catch (error) {
          onErrorRef.current?.(key, error);
          // Both values are dropped rather than retried: the control falls back
          // to a fresh read of the gateway, so a failing server cannot leave the
          // queue fighting the operator's clicks indefinitely.
          targetRef.current.delete(key);
          confirmedRef.current.delete(key);
          break;
        }
        confirmedRef.current.set(key, target);
      }
    } finally {
      drainingRef.current.delete(key);
      // Scoped to this burst; see the note where the map is declared.
      confirmedRef.current.delete(key);
      setBusyKeys((previous) => {
        if (!previous.has(key)) return previous;
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
      onSettledRef.current?.(key);
      // A click that landed after the loop's last check but before this point
      // finds no drainer running, so it is picked up here.
      if (targetRef.current.has(key)) void drain(key);
    }
  }, []);

  const request = React.useCallback(
    (key: string, intent: T) => {
      targetRef.current.set(key, intent);
      setBusyKeys((previous) => {
        if (previous.has(key)) return previous;
        const next = new Set(previous);
        next.add(key);
        return next;
      });
      void drain(key);
    },
    [drain],
  );

  // Both readers depend on the busy set so a component re-renders when a key's
  // work starts or finishes; the maps themselves are read at call time.
  const targetFor = React.useCallback((key: string) => targetRef.current.get(key), [busyKeys]);
  const isBusy = React.useCallback((key: string) => busyKeys.has(key), [busyKeys]);

  return { request, targetFor, isBusy };
}
