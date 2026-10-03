export interface ViewportReading {
  offsetTop: number;
  height: number;
  scale: number;
}

/** Pinch zoom belongs to the browser, not to keyboard-avoidance layout. */
export function resolveVisibleViewport(layoutHeight: number, reading?: ViewportReading | null) {
  if (!reading || reading.scale !== 1 || !Number.isFinite(reading.offsetTop) || !Number.isFinite(reading.height) || reading.height <= 0) {
    return { top: 0, height: layoutHeight, bottom: 0 };
  }
  const top = Math.max(0, reading.offsetTop);
  return { top, height: reading.height, bottom: Math.max(0, layoutHeight - top - reading.height) };
}
