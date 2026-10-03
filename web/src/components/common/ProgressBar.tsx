import React from 'react';
import clsx from 'clsx';
import { createProgressController } from '../../utils/progressController';
import type { ProgressSource } from '../../utils/progressTasks';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

export interface ProgressBarProps {
  source: ProgressSource;
  /** Localized accessible name; the task estimate is not a measured percentage. */
  label: string;
  className?: string;
}

/**
 * Rough progress and waiting activity are separate: a stalled estimate still has a moving marker.
 * CSS owns the activity loop; only the fill and its marker anchor are written on drawing frames,
 * outside React, so this 2px line never makes the page render at animation-frame frequency.
 */
export function ProgressBar({ source, label, className }: ProgressBarProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const fillRef = React.useRef<HTMLDivElement>(null);
  const activityRef = React.useRef<HTMLDivElement>(null);
  const controllerRef = React.useRef<ReturnType<typeof createProgressController> | null>(null);
  const isReducedMotion = usePrefersReducedMotion();
  const motionRef = React.useRef(isReducedMotion);
  motionRef.current = isReducedMotion;

  React.useEffect(() => {
    const root = rootRef.current;
    const fill = fillRef.current;
    const activity = activityRef.current;
    if (!root || !fill || !activity) return;
    const duration = getComputedStyle(root).getPropertyValue('--motion-base').trim();
    let renderedState: string | undefined;
    let renderedValue = -1;
    const controller = createProgressController(source, {
      now: () => performance.now(),
      isHidden: () => document.hidden,
      isReducedMotion: () => motionRef.current,
      completionDuration: Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000),
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: (handle) => window.clearTimeout(handle),
      render({ state, value, isSuspended }) {
        if (state !== renderedState) {
          renderedState = state;
          root.hidden = state === 'hidden';
          if (state === 'hidden') delete root.dataset.state;
          else root.dataset.state = state;
          if (state === 'running') root.setAttribute('aria-busy', 'true');
          else root.removeAttribute('aria-busy');
        }
        if (root.hasAttribute('data-paused') !== isSuspended) root.toggleAttribute('data-paused', isSuspended);
        if (value !== renderedValue) {
          renderedValue = value;
          fill.style.transform = `scaleX(${value})`;
          activity.style.transform = `translateX(${value * 100}%)`;
        }
      },
    });
    controllerRef.current = controller;
    const onTransitionStop = (event: TransitionEvent) => {
      if (event.target === root && event.propertyName === 'opacity') controller.finishFade();
    };
    root.addEventListener('transitionend', onTransitionStop);
    root.addEventListener('transitioncancel', onTransitionStop);
    document.addEventListener('visibilitychange', controller.refresh);
    return () => {
      controller.dispose();
      controllerRef.current = null;
      root.removeEventListener('transitionend', onTransitionStop);
      root.removeEventListener('transitioncancel', onTransitionStop);
      document.removeEventListener('visibilitychange', controller.refresh);
    };
  }, [source]);

  React.useEffect(() => { controllerRef.current?.refresh(); }, [isReducedMotion]);

  return (
    <div ref={rootRef} className={clsx('progress-bar', className)} role="progressbar" aria-label={label} hidden>
      <div ref={fillRef} className="progress-bar-fill" />
      <div ref={activityRef} className="progress-bar-activity" aria-hidden="true">
        <div className="progress-bar-activity-window">
          <div className="progress-bar-activity-mark" />
        </div>
      </div>
    </div>
  );
}
