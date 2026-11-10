import React from 'react';

import { usageLiveChannel, type UsageLiveState } from '../api/usageLive';
import { createCoalescedSignalGate } from '../performance/streamBuffer';

/** Default trailing-edge coalesce interval for bursty SSE invalidations (leading edge stays 0ms). */
export const DEFAULT_LIVE_COALESCE_MS = 240;

export interface LiveRevisionOptions {
  /** Off means no signals and no polling: the reader asked the view to hold still. */
  isEnabled: boolean;
  /** The poll cadence used only while the live stream is not open. */
  fallbackPollMs: number;
  /**
   * Whether a read is already in flight (or a manual sync owns the next one). Read
   * through a ref so the subscription and the timer keep one identity across renders:
   * naming the flag in a dependency list rebuilt the timer on every fetch.
   */
  isBusyRef: { current: boolean };
  /**
   * Trailing-edge coalesce window in ms for high-frequency SSE bursts; `0` disables time coalescing.
   * The first signal after a quiet interval always fires immediately without delay.
   */
  coalesceMs?: number;
}

/**
 * Binds the shared live usage channel to a revision counter or callback.
 *
 * Uses `createCoalescedSignalGate` so an isolated signal triggers an immediate re-read (`0ms`
 * latency) while high-frequency SSE bursts merge into bounded trailing reads without overlapping
 * in-flight requests or leaking timers across unmounts.
 */
export function useLiveRevision({
  isEnabled,
  fallbackPollMs,
  isBusyRef,
  coalesceMs = DEFAULT_LIVE_COALESCE_MS,
}: LiveRevisionOptions) {
  const [revision, setRevision] = React.useState(0);
  const [liveState, setLiveState] = React.useState<UsageLiveState>('connecting');
  const bump = React.useCallback(() => setRevision((value) => value + 1), []);

  const gate = React.useMemo(
    () =>
      createCoalescedSignalGate({
        coalesceMs,
        isBusy: () => isBusyRef.current,
        isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
        onEmit: bump,
      }),
    [coalesceMs, isBusyRef, bump],
  );

  React.useEffect(() => {
    if (!isEnabled) {
      gate.reset();
      return undefined;
    }
    const unsubscribe = usageLiveChannel().subscribe({
      onSignal: () => gate.onSignal(),
      onState: setLiveState,
    });
    return () => {
      unsubscribe();
      gate.reset();
    };
  }, [isEnabled, gate]);

  const isLive = isEnabled && liveState === 'live';
  React.useEffect(() => {
    if (!isEnabled || isLive) return undefined;
    const timer = setInterval(() => {
      gate.onFallbackTick(isLive);
    }, fallbackPollMs);
    return () => clearInterval(timer);
  }, [isEnabled, isLive, fallbackPollMs, gate]);

  const notifySettled = React.useCallback(() => {
    if (!isEnabled) return;
    gate.onSettled();
  }, [isEnabled, gate]);

  return {
    revision,
    liveState: isEnabled ? liveState : ('connecting' as UsageLiveState),
    notifySettled,
  };
}
