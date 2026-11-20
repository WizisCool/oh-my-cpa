import type { HTMLAttributes } from 'react';
import clsx from 'clsx';
import { Count } from './Count';
import styles from './StageProgress.module.css';

export interface StageProgressProps extends HTMLAttributes<HTMLDivElement> {
  /** How many stages the run passes through. */
  total: number;
  /** The stage the run is on, from 0; -1 while it waits to begin. */
  current: number;
  /** The current stage in words. */
  label: string;
}

/**
 * A run through a known, ordered sequence of stages: the stage in words with its place in the
 * sequence beside it, over one segment per stage. It is a step count rather than a measured
 * percentage - the stages are known, their durations are not - so finished segments stay filled
 * and the current one breathes, and the reading never rests on the bar alone.
 */
export function StageProgress({ total, current, label, className, ...attributes }: StageProgressProps) {
  return (
    <div {...attributes} className={clsx(styles['progress'], className)}>
      <div className={styles['caption']}>
        <span className={styles['label']}>{label}</span>
        {current >= 0 && (
          // The position is read aloud with the stage; only the segments below are decorative.
          <Count size="small" className={styles['count']}>{`${current + 1}/${total}`}</Count>
        )}
      </div>
      <ol className={styles['track']} aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <li
            key={index}
            className={styles['step']}
            data-state={index < current ? 'done' : index === current ? 'active' : undefined}
            data-reached={index <= current}
          />
        ))}
      </ol>
    </div>
  );
}
