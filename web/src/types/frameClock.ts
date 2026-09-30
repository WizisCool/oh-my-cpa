/** A shared visible-only animation clock. Consumers render only changed display quanta; no
 * workspace or network request is polled, and settled views schedule no animation frames. */
export function createFrameClock() {
  let nowMS = 0;
  let frame: number | undefined;
  const listeners = new Set<() => void>();
  const stop = () => { if (frame !== undefined) window.cancelAnimationFrame(frame); frame = undefined; };
  const tick = () => {
    frame = undefined;
    const next = Math.floor(Date.now() / 10) * 10;
    if (next !== nowMS) { nowMS = next; listeners.forEach(listener => listener()); }
    if (listeners.size && document.visibilityState === 'visible') frame = window.requestAnimationFrame(tick);
  };
  const visibility = () => { stop(); if (document.visibilityState === 'visible' && listeners.size) tick(); };
  return {
    getSnapshot: () => nowMS,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) { document.addEventListener('visibilitychange', visibility); visibility(); }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { stop(); document.removeEventListener('visibilitychange', visibility); }
      };
    },
  };
}
