import { getAppConfig } from '../types/config';
import { createLiveChannel, createPageActivityMonitor, type ChannelDeps, type LiveChannelState } from './liveChannel';

/**
 * The live update channel: one server-sent event stream per tab that says "the stored update
 * observations changed".
 *
 * The background sweep writes those observations and no browser is waiting on it, so without
 * this signal the navigation's update indicators could trail a release by a whole polling
 * interval. The stream carries nothing but the fact of the change: on a signal the shell
 * re-reads the ordinary endpoints, which stays correct if a signal is merged or missed.
 *
 * The reconnect, visibility and refusal behaviour is `createLiveChannel`'s. A deployment that
 * answers 204 (a demonstration, or no release service) leaves the shell on its polling interval.
 */
export type UpdateLiveState = LiveChannelState;
export type UpdateLiveSignal = 'ready' | 'updates';

interface Listener {
  onSignal: (signal: UpdateLiveSignal) => void;
  onState?: (state: UpdateLiveState) => void;
}

/** createUpdateLiveChannel builds the channel over injectable primitives for the logic suite. */
export function createUpdateLiveChannel(deps: ChannelDeps) {
  const channel = createLiveChannel({ ...deps, eventName: 'updates' });
  return {
    subscribe(listener: Listener) {
      return channel.subscribe({
        onSignal: (signal) => listener.onSignal(signal as UpdateLiveSignal),
        onState: listener.onState,
      });
    },
    getState: channel.getState,
  };
}

/** The address the console opens for the update stream; the logic suite pins it. */
export function systemLiveURL(): string {
  return `${getAppConfig().apiBaseUrl}/management/system/live`;
}

let sharedChannel: ReturnType<typeof createUpdateLiveChannel> | null = null;

/** The tab's one channel, created on first use. */
export function systemLiveChannel() {
  if (!sharedChannel) {
    const activity = createPageActivityMonitor();
    sharedChannel = createUpdateLiveChannel({
      createSource: (url) => new EventSource(url, { withCredentials: true }),
      url: systemLiveURL,
      isVisible: activity.isActive,
      onVisibilityChange: activity.subscribe,
      setTimer: (handler, ms) => window.setTimeout(handler, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
    });
  }
  return sharedChannel;
}
