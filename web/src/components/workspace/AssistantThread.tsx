import React from 'react';
import { AuiIf, ThreadPrimitive } from '@assistant-ui/react';
import type { MessageState } from '@assistant-ui/react';
import { clsx } from 'clsx';
import { ArrowDownOutlined } from '../icons';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import styles from './Workspace.module.css';

export interface AssistantThreadProps {
  /** Shown instead of the transcript while the thread has no messages. */
  empty?: React.ReactNode;
  /** Rendered inside the thread root, where a selection toolbar can scope itself. */
  toolbar?: React.ReactNode;
  latestLabel: string;
  /** Takes only the height its content needs, for a page that centres an empty thread with its composer. */
  isCompact?: boolean;
  testId?: string;
  /** Draws one message; the page decides how a user and an assistant message look. */
  children: (value: { message: MessageState }) => React.ReactNode;
}

/**
 * The transcript both workspaces share, on assistant-ui's own thread primitives.
 *
 * The viewport follows the newest message while the reader is at the bottom and holds their place
 * once they scroll away, and "back to latest" exists only while they are away - all of it the
 * primitive's own behaviour, so neither page keeps scroll state of its own. The messages sit in a
 * centred reading column inside a full-width scroll box, which keeps the scrollbar at the pane's
 * edge.
 */
export function AssistantThread({ empty, latestLabel, isCompact = false, testId, toolbar, children }: AssistantThreadProps) {
  const isReducedMotion = usePrefersReducedMotion();
  return (
    <ThreadPrimitive.Root className={clsx(styles['conversation'], isCompact && styles['is-compact'])}>
      <ThreadPrimitive.Viewport className={styles['transcript']} data-testid={testId} autoScroll>
        {empty && <AuiIf condition={state => state.thread.isEmpty}>{empty}</AuiIf>}
        <div className={styles['transcript-column']}>
          <ThreadPrimitive.Messages>{children}</ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom className={styles['latest']} behavior={isReducedMotion ? 'instant' : 'smooth'}>
        <ArrowDownOutlined aria-hidden="true" />
        <span>{latestLabel}</span>
      </ThreadPrimitive.ScrollToBottom>
      {toolbar}
    </ThreadPrimitive.Root>
  );
}
