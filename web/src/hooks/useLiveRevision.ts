import React from 'react';

import { createLiveReadPolicy, usageLiveChannel, type UsageLiveState } from '../api/usageLive';

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
}

/**
 * useLiveRevision binds the shared live usage channel to a revision counter a
 * query can key on. When to read is `createLiveReadPolicy`'s decision; the reader
 * calls `notifySettled` whenever its read finishes, so a held signal runs then.
 */
export function useLiveRevision({ isEnabled, fallbackPollMs, isBusyRef }: LiveRevisionOptions) {
  const [revision, setRevision] = React.useState(0);
  const [liveState, setLiveState] = React.useState<UsageLiveState>('connecting');
  const policy = React.useMemo(createLiveReadPolicy, []);
  const bump = React.useCallback(() => setRevision((value) => value + 1), []);

  React.useEffect(() => {
    if (!isEnabled) {
      policy.reset();
      return;
    }
    return usageLiveChannel().subscribe({
      onSignal: () => {
        if (policy.onSignal(isBusyRef.current)) bump();
      },
      onState: setLiveState,
    });
  }, [isEnabled, policy, isBusyRef, bump]);

  const isLive = isEnabled && liveState === 'live';
  React.useEffect(() => {
    if (!isEnabled || isLive) return;
    const timer = setInterval(() => {
      if (policy.onTick({ isLive, isVisible: document.visibilityState === 'visible', isBusy: isBusyRef.current })) bump();
    }, fallbackPollMs);
    return () => clearInterval(timer);
  }, [isEnabled, isLive, fallbackPollMs, policy, isBusyRef, bump]);

  const notifySettled = React.useCallback(() => {
    if (policy.onSettled(isBusyRef.current)) bump();
  }, [policy, isBusyRef, bump]);

  return { revision, liveState: isEnabled ? liveState : ('connecting' as UsageLiveState), notifySettled };
}
