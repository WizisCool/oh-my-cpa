/** One wall clock for visible countdown consumers; no background-tab ticks. */
export function createVisibleClock(intervalMS = 15_000) {
  let nowMS = Date.now();
  let timer: number | undefined;
  const listeners = new Set<() => void>();

  const tick = () => {
    nowMS = Date.now();
    listeners.forEach((listener) => listener());
  };
  const stop = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };
  const updateVisibility = () => {
    stop();
    if (document.visibilityState !== 'visible') return;
    tick();
    timer = window.setInterval(tick, intervalMS);
  };

  return {
    getSnapshot: () => nowMS,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        document.addEventListener('visibilitychange', updateVisibility);
        updateVisibility();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
          document.removeEventListener('visibilitychange', updateVisibility);
        }
      };
    },
  };
}
