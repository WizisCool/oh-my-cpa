/**
 * The console's overlays, as seen by the browser's Back button.
 *
 * A phone has a hardware Back button and an edge gesture that traverses the same
 * history; a desktop has both plus the browser's own button. None of them knew that
 * a drawer was open, because every overlay in the console is local component state
 * and none of them is a history entry. Measured before this existed, at 390x844:
 * with the navigation sheet open, Back landed on the previous *route*; with a
 * request record open, Back landed on the dashboard and the drawer disappeared only
 * because its page unmounted. The operator loses the list, the filters, the page and
 * the scroll offset they were working in, and their mental model - Back means "put
 * this away" - is contradicted by the most reachable control on the device.
 *
 * The alternative, a swipe gesture implemented in JavaScript, is worse than it
 * looks: iOS Safari and Android predictive back already own the screen edges, so a
 * custom edge-swipe either loses the gesture or fights the browser, and it can only
 * ever be approximately hand-following. Joining the history instead means the
 * platform's own gesture does the work, at native frame rate, with nothing to
 * reconcile.
 *
 * ## The mechanism, and why it is shaped this way
 *
 * Opening an overlay pushes one history entry that holds the same URL and the same
 * router bookkeeping, marked with the overlay's id. The system Back then pops that
 * entry, and the pop is what dismisses the overlay. Nothing about the route changes,
 * so no navigation happens and nothing re-renders for a reason the reader did not
 * ask for.
 *
 * Three constraints shape everything else:
 *
 *   - **History entries cannot be removed.** There is no "unpush". Going back N
 *     entries to tidy up would move the reader N entries ago, which is strictly worse
 *     than the bug being fixed. So a sentinel is only *consumed* by an actual
 *     `back()`, and when that would be wrong the sentinel is abandoned in place. A
 *     dead entry costs one extra Back press at worst and never a wrong navigation.
 *
 *   - **`popstate` reports where the reader landed, not where they left.** A marker
 *     in the event is therefore useless for detecting "this pop dismissed an
 *     overlay"; the decision has to come from this module's own bookkeeping.
 *
 *   - **A dismissed overlay must not take the reader with it.** Closing an overlay
 *     calls `back()` to consume its sentinel - but only while the entry below the
 *     sentinel is still the one the overlay was opened over. Two things can move it:
 *     a router navigation (the filter drawer applies its filters *and* closes, and
 *     the apply pushes a new entry), and another overlay's sentinel pushed on top.
 *     Both are detected before `back()` is called, and the reverted-filters
 *     accident - popping the entry that was just written - is what they prevent.
 *
 * The module owns no React and no timers beyond the scheduler it is given, so its
 * behaviour is pinned by direct tests rather than by re-describing it.
 */

/** What this module needs from the outside, so tests can drive it without a browser. */
export interface OverlayHistoryHost {
  /**
   * The router's identity for the entry currently in force.
   *
   * `@remix-run/router` stores this on the history entry's state and replicates it
   * onto its location, so it changes exactly when the router changes the entry - a
   * push or a replace - and not when an overlay does. That is the signal this module
   * needs, and reading it from the router is why no epoch counter of our own is
   * required: ours would have to be bumped from the same events, and a counter bumped
   * on the wrong ones fails in the direction of navigating the reader away.
   */
  currentKey: () => string | undefined;
  /** Pushes one history entry that keeps the URL and the router's own state. */
  pushSentinel: (id: string) => void;
  /** Traverses one entry backwards. */
  goBack: () => void;
  /** Defers a callback to after the current task. Cancelled work is never run. */
  schedule: (callback: () => void) => void;
}

export interface OverlayHistory {
  /** An overlay became visible. Idempotent per id. */
  open: (id: string) => void;
  /**
   * An overlay was closed by its own UI, so the entry below its sentinel is still the
   * one it was opened over. Consumes the sentinel when it is safe to; see the module note.
   */
  close: (id: string) => void;
  /**
   * An overlay ceased to exist without being closed - its page unmounted, so there is
   * nobody left to tell. Drops the sentinel without navigating.
   *
   * Deferred rather than immediate, and that is load-bearing: React runs
   * setup -> cleanup -> setup for every effect under `StrictMode` in a development
   * build, so an immediate cleanup would strand the first sentinel and push a second
   * one, leaving two entries and an overlay that takes two Back presses to dismiss.
   * Deferring means the re-setup cancels the departure, and only a real unmount
   * reaches the deferred callback.
   */
  forgetSoon: (id: string) => void;
  /**
   * A Back arrived from the platform. Returns the id of the overlay to dismiss, or
   * undefined when the press belonged to the browser rather than to an overlay - in
   * which case the caller has nothing to do and the router handles the entry.
   */
  handlePop: () => string | undefined;
  /** The ids of the sentinels still awaiting a dismissal, bottom first. */
  readonly openStack: readonly string[];
}

interface Sentinel {
  id: string;
  /** The router key of the entry the overlay was opened over. */
  key: string | undefined;
}

export function createOverlayHistory(host: OverlayHistoryHost): OverlayHistory {
  const stack: Sentinel[] = [];
  /**
   * Backs this module issued itself. A `popstate` answering one of them is a sentinel
   * being consumed, not the reader asking for anything: the overlay it belonged to has
   * already closed, and reading it as a fresh press would dismiss whatever sits below
   * it.
   *
   * A count rather than a flag, because two closings can be in flight at once and a
   * flag would let the second pop be read as the reader's.
   */
  let pendingSelfBacks = 0;
  /** Ids with a departure already scheduled, so a second request cannot queue another. */
  const departing = new Set<string>();

  return {
    open: (id) => {
      departing.delete(id);
      if (stack.some((sentinel) => sentinel.id === id)) return;
      stack.push({ id, key: host.currentKey() });
      host.pushSentinel(id);
    },

    close: (id) => {
      departing.delete(id);
      const index = stack.findIndex((sentinel) => sentinel.id === id);
      if (index === -1) return;
      const [entry] = stack.splice(index, 1);
      // Only the top sentinel can be consumed. With one above it, the entries in
      // between belong to that overlay and the reader, not to this one.
      if (index !== stack.length) return;
      // The router changed the entry after this sentinel was pushed, so the entry
      // below it is no longer the one the overlay was opened over. Going back would
      // undo the navigation instead of the overlay.
      if (host.currentKey() !== entry.key) return;
      pendingSelfBacks += 1;
      host.goBack();
    },

    forgetSoon: (id) => {
      if (departing.has(id)) return;
      departing.add(id);
      host.schedule(() => {
        // The flag is the cancellation token, not only a de-duplicator: `open` and `close`
        // clear it, and this callback must then leave the sentinel alone. Without that, a
        // StrictMode remount would push one sentinel and have the *first* effect's deferred
        // departure drop it, leaving the overlay open with nothing tracking it.
        if (!departing.delete(id)) return;
        const index = stack.findIndex((sentinel) => sentinel.id === id);
        if (index !== -1) stack.splice(index, 1);
      });
    },

    handlePop: () => {
      if (pendingSelfBacks > 0) {
        pendingSelfBacks -= 1;
        return undefined;
      }
      return stack.pop()?.id;
    },

    get openStack() {
      return stack.map((sentinel) => sentinel.id);
    },
  };
}
