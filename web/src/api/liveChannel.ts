/**
 * The shared server-sent event channel behind a console surface.
 *
 * Two surfaces use it - live usage data and the stored update observations - and both need the
 * same lifecycle, so it lives here once rather than twice: one stream per tab shared by every
 * reader, a signal that means "re-read" and carries nothing, a reconnect that is the browser's
 * job until the server refuses the stream, and a hidden tab that holds no server slot.
 *
 * States:
 * - `connecting`: opening, or the browser is reconnecting after a drop or after the
 *   server ended the stream's lifetime. Readers keep their fallback poll.
 * - `live`: the stream is open. Readers rely on signals.
 * - `unavailable`: the server answered without a stream - 204 when the deployment has no
 *   source (a demonstration, or a build without one), or 503 at the reader limit.
 *   EventSource does not retry a non-200 answer, so this module retries after
 *   `UNAVAILABLE_RETRY_MS`; readers poll meanwhile.
 *
 * The stream is closed while the tab is hidden and reopened when it is shown. Reopening emits
 * `ready`, which every reader treats as a signal, so a tab returning from the background
 * catches up.
 */
export type LiveChannelState = 'connecting' | 'live' | 'unavailable';

export const UNAVAILABLE_RETRY_MS = 30_000;

/** EventSource.CLOSED, spelled out so the logic suite runs where EventSource does not exist. */
const EVENT_SOURCE_CLOSED = 2;

interface Listener {
  onSignal: (signal: string) => void;
  onState?: (state: LiveChannelState) => void;
}

export interface LiveChannelDeps {
  /** The event name the server sends for a change, beside `ready`. */
  eventName: string;
  createSource: (url: string) => EventSource;
  url: () => string;
  isVisible: () => boolean;
  onVisibilityChange: (handler: () => void) => () => void;
  setTimer: (handler: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

/**
 * The browser primitives a channel is built over. Each consumer supplies its own event name, so
 * the per-surface modules declare only this shape and the shared implementation owns the
 * lifecycle.
 */
export type ChannelDeps = Omit<LiveChannelDeps, 'eventName'>;

/** createLiveChannel builds a channel over injectable browser primitives, so the logic suite can drive reconnects and visibility without a browser. */
export function createLiveChannel(deps: LiveChannelDeps) {
  const listeners = new Set<Listener>();
  let source: EventSource | null = null;
  let state: LiveChannelState = 'connecting';
  let retryTimer: unknown = null;
  let detachVisibility: (() => void) | null = null;

  const setState = (next: LiveChannelState) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener.onState?.(next);
  };
  const signal = (kind: string) => {
    for (const listener of listeners) listener.onSignal(kind);
  };

  const close = () => {
    if (retryTimer !== null) {
      deps.clearTimer(retryTimer);
      retryTimer = null;
    }
    if (source) {
      source.close();
      source = null;
    }
  };

  const open = () => {
    if (source || retryTimer !== null || listeners.size === 0 || !deps.isVisible()) return;
    setState('connecting');
    let opened: EventSource;
    try {
      opened = deps.createSource(deps.url());
    } catch {
      setState('unavailable');
      retryTimer = deps.setTimer(() => { retryTimer = null; open(); }, UNAVAILABLE_RETRY_MS);
      return;
    }
    source = opened;
    opened.addEventListener('ready', () => {
      if (source !== opened) return;
      setState('live');
      signal('ready');
    });
    opened.addEventListener(deps.eventName, () => {
      if (source !== opened) return;
      signal(deps.eventName);
    });
    opened.addEventListener('error', () => {
      if (source !== opened) return;
      // CONNECTING means the browser is already retrying (a dropped connection, or the server
      // ending the stream's lifetime). CLOSED means it gave up: the answer was not a stream, so
      // retrying is this module's job.
      if (opened.readyState === EVENT_SOURCE_CLOSED) {
        source = null;
        setState('unavailable');
        retryTimer = deps.setTimer(() => { retryTimer = null; open(); }, UNAVAILABLE_RETRY_MS);
      } else {
        setState('connecting');
      }
    });
  };

  const handleVisibility = () => {
    if (deps.isVisible()) open();
    else {
      close();
      setState('connecting');
    }
  };

  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      listener.onState?.(state);
      if (!detachVisibility) detachVisibility = deps.onVisibilityChange(handleVisibility);
      open();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size > 0) return;
        close();
        detachVisibility?.();
        detachVisibility = null;
        state = 'connecting';
      };
    },
    getState: () => state,
  };
}
