import React from 'react';
import clsx from 'clsx';
import {
  advanceDrawnProgress,
  estimateProgress,
  getProgressPercent,
  isProgressBatchComplete,
  PROGRESS_FLOOR,
  PROGRESS_SHOW_DELAY_MS,
  reconcileProgressBatch,
  shouldShowProgress,
  type ProgressBatch,
} from '../../utils/loadProgress';
import type { ProgressSource } from '../../utils/progressTasks';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

export interface ProgressBarProps {
  source: ProgressSource;
  /** The accessible name; the bar is a progressbar whose value is the batch's measured share. */
  label: string;
  className?: string;
}

/**
 * A 2px bar whose length is the share of the counted work that has arrived (`loadProgress`).
 *
 * The frame loop writes the fill's transform and the ARIA value straight to the DOM: the bar moves
 * every frame while work is in flight, and routing that through React state would re-render its
 * parent sixty times a second for a 2px line. Only `transform` and `opacity` change, so the bar
 * stays on the compositor (design.md §7 rule 1). The loop runs only while the bar is painted.
 */
export function ProgressBar({ source, label, className }: ProgressBarProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const fillRef = React.useRef<HTMLDivElement>(null);
  const isReducedMotion = usePrefersReducedMotion();
  const motionRef = React.useRef(isReducedMotion);
  // A live preference changes drawing, not the identity or accounting of the current batch.
  motionRef.current = isReducedMotion;

  React.useEffect(() => {
    const root = rootRef.current;
    const fill = fillRef.current;
    if (!root || !fill) return;

    let batch: ProgressBatch | null = null;
    let drawn = 0;
    let announced = -1;
    let isPainted = false;
    let frame = 0;
    let lastFrameAt = 0;
    let showTimer = 0;

    const draw = () => {
      fill.style.transform = `scaleX(${drawn})`;
      // Announced in tenths: a value that changes every frame is noise to assistive technology.
      const percent = getProgressPercent(drawn);
      if (percent !== announced) {
        announced = percent;
        root.setAttribute('aria-valuenow', String(percent));
      }
    };

    const hide = () => {
      isPainted = false;
      batch = null;
      drawn = 0;
      root.hidden = true;
      delete root.dataset.state;
      root.removeAttribute('aria-busy');
    };

    const loop = (now: number) => {
      frame = 0;
      if (!batch || !isPainted) return;
      const isReducedMotion = motionRef.current;
      const target = estimateProgress(batch, now, !isReducedMotion);
      drawn = isReducedMotion ? Math.max(drawn, target) : advanceDrawnProgress(drawn, target, now - lastFrameAt);
      lastFrameAt = now;
      draw();
      if (isProgressBatchComplete(batch) && drawn >= 1) {
        // Full, then gone: the stylesheet holds the completed bar for a beat and fades it, and the
        // fade's end or cancellation hides it. Reduced motion has no fade to wait for.
        root.dataset.state = 'done';
        root.removeAttribute('aria-busy');
        if (isReducedMotion) hide();
        return;
      }
      frame = requestAnimationFrame(loop);
    };

    const paint = (now: number) => {
      if (!isPainted) {
        isPainted = true;
        drawn = PROGRESS_FLOOR;
        root.hidden = false;
      }
      root.dataset.state = 'running';
      root.setAttribute('aria-busy', 'true');
      draw();
      lastFrameAt = now;
      if (!frame) frame = requestAnimationFrame(loop);
    };

    const sync = () => {
      const now = performance.now();
      const previous = batch;
      batch = reconcileProgressBatch(batch, source.read(), now);
      if (!batch) return;
      if (isPainted && previous && isProgressBatchComplete(previous) && !isProgressBatchComplete(batch)) {
        // New work while the last batch is still on screen: a new episode starts from the left
        // rather than inheriting a bar that already reads as finished.
        drawn = PROGRESS_FLOOR;
      }
      if (isProgressBatchComplete(batch)) {
        window.clearTimeout(showTimer);
        showTimer = 0;
        // Settled before it ever painted: a fast batch leaves no trace at all.
        if (!isPainted) { batch = null; return; }
        if (!frame) frame = requestAnimationFrame(loop);
        return;
      }
      if (isPainted || shouldShowProgress(batch, now)) {
        paint(now);
      } else if (!showTimer) {
        const wait = batch.startedAt + PROGRESS_SHOW_DELAY_MS - now;
        showTimer = window.setTimeout(() => {
          showTimer = 0;
          if (batch && !isProgressBatchComplete(batch)) paint(performance.now());
        }, wait);
      }
    };

    const onTransitionStop = (event: TransitionEvent) => {
      if (event.target === root && event.propertyName === 'opacity' && root.dataset.state === 'done') hide();
    };

    hide();
    root.ontransitionend = root.ontransitioncancel = onTransitionStop;
    const unsubscribe = source.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      root.ontransitionend = root.ontransitioncancel = null;
      window.clearTimeout(showTimer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [source]);

  return (
    <div
      ref={rootRef}
      className={clsx('progress-bar', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      hidden
    >
      <div ref={fillRef} className="progress-bar-fill" />
    </div>
  );
}
