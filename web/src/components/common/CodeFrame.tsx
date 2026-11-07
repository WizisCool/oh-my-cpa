import React from 'react';
import clsx from 'clsx';
import { CopyButton } from './CopyButton';
import { CodeBody } from './CodeBody';
import styles from './CodeFrame.module.css';

export interface CodeFrameProps {
  /** The text the copy action copies - the code itself, never a rendered form of it. */
  code: string;
  /** The head's label: a language name, or a short caption for a value. */
  label: React.ReactNode;
  /** The grammar the default body is highlighted in; the label is a caption, not a language. */
  lang?: string;
  /** Controls the head offers beside the copy action: a view switch, an export. */
  actions?: React.ReactNode;
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
 * The frame is shared by model transcripts and code previews, so a fenced block in
 * an answer and a snippet on a setup page are the same object with the same copy control. The
 * body is a slot because a transcript may draw something other than code in it - a rendered page.
 */
export function CodeFrame({ code, label, lang, actions, children, className }: CodeFrameProps) {
  return (
    <div className={clsx(styles['code-frame'], className)}>
      <div className={styles['code-frame-head']}>
        <span className={styles['code-frame-label']}>{label}</span>
        <span className={styles['code-frame-actions']}>
          {actions}
          <CopyButton text={code} size="small" />
        </span>
      </div>
      {children ?? <CodeBody code={code} lang={lang} />}
    </div>
  );
}
