import React from 'react';
import { clsx } from 'clsx';
import styles from './Workspace.module.css';

// Each cell's place in the nine-step cycle. Doubling the index sends the lit run across the grid
// diagonally instead of row by row, which is what makes it read as work rather than as a scanner.
const CELL_PHASES = Array.from({ length: 9 }, (_, index) => (index * 2) % 9);

export interface GenerationLoaderProps {
  /** `mark` sits in a line of text; `block` stands alone where the result will be drawn. */
  size?: 'mark' | 'block';
  className?: string;
}

/**
 * Something is being generated: a three-by-three field with a run of lit cells travelling through
 * it. Decorative on its own - the label beside it names the work to assistive technology.
 */
export function GenerationLoader({ size = 'block', className }: GenerationLoaderProps) {
  return (
    <span className={clsx(styles['generation-loader'], className)} data-size={size} aria-hidden="true">
      {CELL_PHASES.map((phase, index) => (
        <span key={index} className={styles['generation-loader-cell']} style={{ '--loader-phase': phase } as React.CSSProperties} />
      ))}
    </span>
  );
}
