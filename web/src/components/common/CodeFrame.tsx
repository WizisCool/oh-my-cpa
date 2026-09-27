import React from 'react';
import clsx from 'clsx';
import { CopyButton } from './CopyButton';
import styles from './CodeFrame.module.css';

export interface CodeFrameProps {
  /** The text the copy action copies - the code itself, never a rendered form of it. */
  code: string;
  /** The head's label: a language name, or a short caption for a value. */
  label: React.ReactNode;
  /**
   * The body, when the caller highlights the code itself. Without it the code is drawn as plain
   * monospaced text, which is the right default: most of the console's code is a snippet to copy,
   * and a highlighter is a large dependency for it.
   */
  children?: React.ReactNode;
  className?: string;
}

/**
 * A block of code: a head naming it with a copy action, then the code.
 *
 * The frame is shared by the model transcripts and the quick-start snippets, so a fenced block in
 * an answer and a snippet on a setup page are the same object with the same copy control. The
 * body is a slot because only the transcript highlights - it owns the grammar allowlist and the
 * streaming rule that goes with it.
 */
export function CodeFrame({ code, label, children, className }: CodeFrameProps) {
  return (
    <div className={clsx(styles['code-frame'], className)}>
      <div className={styles['code-frame-head']}>
        <span className={styles['code-frame-label']}>{label}</span>
        <CopyButton text={code} size="small" />
      </div>
      {children ?? <pre className={styles['code-frame-body']}><code>{code}</code></pre>}
    </div>
  );
}
