import { getAppConfig } from '../types/config';

/**
 * The live usage channel: one server-sent event stream per tab that says "stored
 * usage data changed", shared by every page that shows request records.
 *
 * The stream carries no records. A signal means "re-read", and each reader re-reads
 * with its own filters and cursor, so a merged or missed signal never loses a row -
 * the next read returns everything past the reader's boundary. That keeps this
 * module free of any knowledge of what a page shows.
 *
 * States:
 * - `connecting`: opening, or the browser is reconnecting after a drop or after the
 *   server ended the stream's lifetime. Readers keep their fallback poll.
 * - `live`: the stream is open. Readers rely on signals and stop polling.
 * - `unavailable`: the server answered without a stream - 204 when the deployment
 *   has no collector (ingestion off, the public demonstration), or 503 at the reader
 *   limit. EventSource does not retry a non-200 answer, so this module retries after
 *   `UNAVAILABLE_RETRY_MS`; readers poll meanwhile.
 *
 * The stream is closed while the tab is hidden and reopened when it is shown: a
 * hidden reader spends a server slot on nobody. Reopening emits `ready`, which every
 * reader treats as a signal, so a tab returning from the background catches up.
 */
export type UsageLiveState = 'connecting' | 'live' | 'unavailable';
export type UsageLiveSignal = 'ready' | 'usage';

export const UNAVAILABLE_RETRY_MS = 30_000;

/** EventSource.CLOSED, spelled out so the logic suite runs where EventSource does not exist. */
const EVENT_SOURCE_CLOSED = 2;

interface Listener {
  onSignal: (signal: UsageLiveSignal) => void;
  onState?: (state: UsageLiveState) => void;
}

interface ChannelDeps {
  createSource: (url: string) => EventSource;
  url: () => string;
  isVisible: () => boolean;
  onVisibilityChange: (handler: () => void) => () => void;
  setTimer: (handler: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

/**
 * createUsageLiveChannel builds the shared channel over injectable browser
 * primitives, so the logic suite can drive reconnects and visibility without a
 * browser.
 */
export function createUsageLiveChannel(deps: ChannelDeps) {
  const listeners = new Set<Listener>();
  let source: EventSource | null = null;
  let state: UsageLiveState = 'connecting';
  let retryTimer: unknown = null;
  let detachVisibility: (() => void) | null = null;

  const setState = (next: UsageLiveState) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener.onState?.(next);
  };
  const signal = (kind: UsageLiveSignal) => {
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
    opened.addEventListener('usage', () => {
      if (source !== opened) return;
      signal('usage');
    });
    opened.addEventListener('error', () => {
      if (source !== opened) return;
      // CONNECTING means the browser is already retrying (a dropped connection,
      // or the server ending the stream's lifetime). CLOSED means it gave up: the
      // answer was not a stream, so retrying is this module's job.
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

/**
 * createLiveReadPolicy decides, for one reader, when a signal or a fallback tick
 * turns into a read.
 *
 * - A signal while a read is in flight (or a manual sync owns the next one) is held,
 *   not dropped and not stacked; when that read settles, exactly one more runs. However
 *   many records land during a slow read, they cost one follow-up read, and none is missed.
 * - A fallback tick runs only while no stream is open, the tab is visible and nothing
 *   is reading. It is skipped rather than queued, so a slow gateway cannot turn the
 *   cadence into a burst of reads the moment it answers.
 */
export function createLiveReadPolicy() {
  let isPending = false;
  return {
    /** A live signal arrived; true means read now. */
    onSignal(isBusy: boolean): boolean {
      if (isBusy) {
        isPending = true;
        return false;
      }
      isPending = false;
      return true;
    },
    /** The reader's read settled; true means the held signal is read now. */
    onSettled(isBusy: boolean): boolean {
      if (!isPending || isBusy) return false;
      isPending = false;
      return true;
    },
    /** One fallback tick; true means read now. */
    onTick({ isLive, isVisible, isBusy }: { isLive: boolean; isVisible: boolean; isBusy: boolean }): boolean {
      return !isLive && isVisible && !isBusy;
    },
    reset() {
      isPending = false;
    },
  };
}

let sharedChannel: ReturnType<typeof createUsageLiveChannel> | null = null;

/** The tab's one channel, created on first use. */
export function usageLiveChannel() {
  if (!sharedChannel) {
    sharedChannel = createUsageLiveChannel({
      createSource: (url) => new EventSource(url, { withCredentials: true }),
      url: () => `${getAppConfig().apiBaseUrl}/usage/live`,
      isVisible: () => document.visibilityState === 'visible',
      onVisibilityChange: (handler) => {
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
      },
      setTimer: (handler, ms) => window.setTimeout(handler, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
    });
  }
  return sharedChannel;
}
