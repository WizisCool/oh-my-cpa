import { getAppConfig } from '../types/config';
import { createLiveChannel, type ChannelDeps, type LiveChannelState } from './liveChannel';

/**
 * The live usage channel: one server-sent event stream per tab that says "stored
 * usage data changed", shared by every page that shows request records.
 *
 * The stream carries no records. A signal means "re-read", and each reader re-reads
 * with its own filters and cursor, so a merged or missed signal never loses a row -
 * the next read returns everything past the reader's boundary. That keeps this
 * module free of any knowledge of what a page shows.
 *
 * The reconnect, visibility and refusal behaviour is `createLiveChannel`'s; this module names
 * the event and keeps the read policy that turns signals into reads.
 */
export type UsageLiveState = LiveChannelState;
export type UsageLiveSignal = 'ready' | 'usage';

interface Listener {
  onSignal: (signal: UsageLiveSignal) => void;
  onState?: (state: UsageLiveState) => void;
}

/**
 * createUsageLiveChannel builds the shared channel over injectable browser
 * primitives, so the logic suite can drive reconnects and visibility without a
 * browser.
 */
export function createUsageLiveChannel(deps: ChannelDeps) {
  const channel = createLiveChannel({ ...deps, eventName: 'usage' });
  return {
    subscribe(listener: Listener) {
      return channel.subscribe({
        onSignal: (signal) => listener.onSignal(signal as UsageLiveSignal),
        onState: listener.onState,
      });
    },
    getState: channel.getState,
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
