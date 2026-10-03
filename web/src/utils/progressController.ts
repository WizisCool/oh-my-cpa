import {
  advanceDrawnProgress,
  estimateProgress,
  isProgressBatchComplete,
  PROGRESS_FLOOR,
  PROGRESS_SHOW_DELAY_MS,
  reconcileProgressBatch,
  shouldShowProgress,
  type ProgressBatch,
} from './loadProgress';
import type { ProgressSource } from './progressTasks';

export interface ProgressPresentation {
  state: 'hidden' | 'running' | 'finishing' | 'done';
  value: number;
  isSuspended: boolean;
}

interface ProgressHost {
  now(): number;
  isHidden(): boolean;
  isReducedMotion(): boolean;
  /** Resolved from the stylesheet's base motion token, not a second animation budget. */
  completionDuration: number;
  render(presentation: ProgressPresentation): void;
  requestFrame(callback: (now: number) => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(handle: number): void;
}

/** Clock and effects are injected so lifecycle races are tested without real-time waits or a DOM. */
export function createProgressController(source: ProgressSource, host: ProgressHost) {
  let batch: ProgressBatch | null = null;
  let state: ProgressPresentation['state'] = 'hidden';
  let drawn = 0;
  let frame = 0;
  let showTimer = 0;
  let lastFrameAt = 0;
  let finishingAt = 0;
  let finishingFrom = 0;

  const render = () => host.render({ state, value: drawn, isSuspended: host.isHidden() });
  const cancelFrame = () => {
    if (frame) host.cancelFrame(frame);
    frame = 0;
  };
  const clearShowTimer = () => {
    if (showTimer) host.clearTimer(showTimer);
    showTimer = 0;
  };
  const resetPresentation = () => {
    cancelFrame();
    clearShowTimer();
    state = 'hidden';
    drawn = 0;
    render();
  };
  const hide = () => { batch = null; resetPresentation(); };

  const scheduleFrame = () => {
    if (!frame && !host.isHidden() && !host.isReducedMotion()) frame = host.requestFrame(drawFrame);
  };
  const drawFrame = (now: number) => {
    frame = 0;
    if (!batch || host.isHidden()) return;
    if (host.isReducedMotion()) { refresh(); return; }
    if (state === 'finishing') {
      const fraction = host.completionDuration > 0
        ? Math.min(1, Math.max(0, (now - finishingAt) / host.completionDuration)) : 1;
      drawn = finishingFrom + (1 - finishingFrom) * (1 - (1 - fraction) ** 3);
      if (fraction >= 1) { drawn = 1; state = 'done'; }
    } else if (state === 'running') {
      drawn = advanceDrawnProgress(drawn, estimateProgress(batch, now), now - lastFrameAt);
    } else return;
    lastFrameAt = now;
    render();
    if (state !== 'done') scheduleFrame();
  };

  const paint = (now: number) => {
    clearShowTimer();
    if (state === 'hidden') {
      drawn = PROGRESS_FLOOR;
      lastFrameAt = now;
    }
    state = 'running';
    if (host.isReducedMotion()) {
      cancelFrame();
      drawn = Math.max(drawn, estimateProgress(batch!, now, false));
    } else if (!frame) {
      // Cache notifications do not own this clock. Only a new/resumed frame loop resets it.
      lastFrameAt = now;
      scheduleFrame();
    }
    render();
  };

  const refresh = () => {
    const now = host.now();
    const previous = batch;
    batch = reconcileProgressBatch(batch, source.read(), now);
    if (!batch) return;
    if (host.isHidden()) {
      cancelFrame();
      clearShowTimer();
      if (isProgressBatchComplete(batch)) hide();
      else render();
      return;
    }
    if (isProgressBatchComplete(batch)) {
      clearShowTimer();
      if (state === 'hidden' || host.isReducedMotion()) { hide(); return; }
      if (state === 'running') {
        state = 'finishing';
        finishingAt = now;
        finishingFrom = drawn;
        render();
        scheduleFrame();
      }
      return;
    }
    // A new episode must earn its own show delay even if the preceding bar is still fading.
    if (previous && isProgressBatchComplete(previous)) resetPresentation();
    if (state !== 'hidden' || shouldShowProgress(batch, now)) paint(now);
    else if (!showTimer) {
      showTimer = host.setTimer(() => {
        showTimer = 0;
        refresh();
      }, batch.startedAt + PROGRESS_SHOW_DELAY_MS - now);
    }
  };

  render();
  const unsubscribe = source.subscribe(refresh);
  refresh();
  return {
    refresh,
    finishFade() { if (state === 'done') hide(); },
    dispose() { unsubscribe(); cancelFrame(); clearShowTimer(); },
  };
}
