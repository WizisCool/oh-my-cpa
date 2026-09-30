import React from 'react';
import { clsx } from 'clsx';
import { useI18n } from '../../i18n';
import { BulbOutlined, RightOutlined } from '../icons';
import { ModelMarkdown } from './ModelMarkdown';
import styles from './Workspace.module.css';

export interface ReasoningBlockProps {
  text?: string;
  /** Reasoning is still arriving. */
  isThinking: boolean;
}

/**
 * A model's reasoning, as a disclosure.
 *
 * It opens while reasoning streams, because reading it live is the reason to show it at all, and
 * it starts closed for an answer that has already finished. The initial state is read once, at
 * mount; after that the disclosure is the reader's, so an answer that starts arriving never closes
 * a block someone is reading. The live state is a steady label, not a sweeping gradient: §7 of the
 * design system rules that out, and the activity strip already says the phase is live.
 */
export const ReasoningBlock = React.memo(function ReasoningBlock({ text, isThinking }: ReasoningBlockProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = React.useState(isThinking);
  const contentID = React.useId();
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const isFollowingRef = React.useRef(true);
  const wasThinkingRef = React.useRef(isThinking);

  // Live reasoning is a rolling read: it stays pinned to its newest output until the reader scrolls
  // up, and a stream that finishes folds the block back so the answer reads first. The initial
  // state is read once, at mount; a block an operator opens after the fact stays open.
  React.useEffect(() => {
    if (wasThinkingRef.current && !isThinking) setIsOpen(false);
    wasThinkingRef.current = isThinking;
  }, [isThinking]);
  React.useEffect(() => {
    const body = bodyRef.current;
    if (!isThinking || !body || !isFollowingRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [isThinking, text]);
  return (
    <div className={clsx(styles['reasoning'], isThinking && styles['is-thinking'])}>
      <button
        type="button"
        className={styles['reasoning-toggle']}
        aria-expanded={isOpen}
        aria-controls={contentID}
        onClick={() => setIsOpen(value => !value)}
      >
        <BulbOutlined aria-hidden="true" />
        <span>{t(isThinking ? 'pg.thinking' : 'pg.thought_process')}</span>
        <RightOutlined className={styles['reasoning-caret']} aria-hidden="true" />
      </button>
      {isOpen && text ? (
        <div
          id={contentID}
          ref={bodyRef}
          className={styles['reasoning-body']}
          onScroll={() => {
            const body = bodyRef.current;
            if (!body) return;
            isFollowingRef.current = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
          }}
        >
          <ModelMarkdown content={text} isStreaming={isThinking} externalImageLabel={t('pg.external_image')} className={styles['reasoning-text']} />
        </div>
      ) : null}
    </div>
  );
});
