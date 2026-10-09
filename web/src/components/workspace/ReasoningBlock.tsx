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
  /** False when the caller already names the live phase in a separate status row. */
  shouldShowThinkingLabel?: boolean;
}

/**
 * A model's reasoning, as a disclosure.
 *
 * It opens while reasoning streams, because reading it live is the reason to show it at all, and
 * it starts closed for an answer that has already finished. The initial state is read once, at
 * mount; a live block folds when reasoning finishes, and a settled block stays under the reader's
 * control. The text has no frame: it is the model's own writing, set on the
 * page in a quieter ink.
 */
export const ReasoningBlock = React.memo(function ReasoningBlock({ text, isThinking, shouldShowThinkingLabel = true }: ReasoningBlockProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = React.useState(isThinking);
  const contentID = React.useId();
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const isFollowingRef = React.useRef(true);
  const [scrollState, setScrollState] = React.useState({ isFollowing: true, hasHiddenHistory: false });
  const hasText = !!text;
  const wasThinkingRef = React.useRef(isThinking);

  // Live reasoning is a rolling read: it stays pinned to its newest output until the reader scrolls
  // up, and a stream that finishes folds the block back so the answer reads first. The initial
  // state is read once, at mount; a block an operator opens after the fact stays open.
  React.useEffect(() => {
    if (wasThinkingRef.current && !isThinking) setIsOpen(false);
    wasThinkingRef.current = isThinking;
  }, [isThinking]);
  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!isOpen || !isThinking || !body || !content) return;
    let lastScrollTop = body.scrollTop;
    const followContent = () => {
      const maxScrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
      // A resize can arrive before the pending scroll event. Read movement before correcting
      // either callback, but allow the browser to clamp the old offset when content shrinks.
      const previousTop = Math.min(lastScrollTop, maxScrollTop);
      const isAtLatest = maxScrollTop - body.scrollTop <= 8;
      if (body.scrollTop < previousTop && !isAtLatest) isFollowingRef.current = false;
      else if (body.scrollTop > previousTop && isAtLatest) isFollowingRef.current = true;
      if (isFollowingRef.current) body.scrollTop = maxScrollTop;
      lastScrollTop = body.scrollTop;
      const next = { isFollowing: isFollowingRef.current, hasHiddenHistory: body.scrollTop > 1 };
      setScrollState(current => current.isFollowing === next.isFollowing && current.hasHiddenHistory === next.hasHiddenHistory ? current : next);
    };
    // Markdown commits its streaming cache and animated text after this component's effects.
    // Observe the unbounded content as well as the viewport; a capped body stops resizing.
    const observer = new ResizeObserver(followContent);
    observer.observe(content, { box: 'border-box' });
    observer.observe(body, { box: 'border-box' });
    body.addEventListener('scroll', followContent, { passive: true });
    followContent();
    return () => {
      observer.disconnect();
      body.removeEventListener('scroll', followContent);
    };
  }, [hasText, isOpen, isThinking]);
  return (
    <div className={clsx(styles['reasoning'], isThinking && styles['is-thinking'])}>
      <button
        type="button"
        className={styles['reasoning-toggle']}
        data-reasoning-toggle
        aria-expanded={isOpen}
        aria-controls={contentID}
        onClick={() => {
          if (!isOpen && isThinking) isFollowingRef.current = true;
          setIsOpen(value => !value);
        }}
      >
        <span className={styles['reasoning-mark']} data-step-mark aria-hidden="true"><BulbOutlined /></span>
        <span className={isThinking && shouldShowThinkingLabel ? styles['live-text'] : undefined}>{t(isThinking && shouldShowThinkingLabel ? 'conversation.thinking' : 'conversation.thought_process')}</span>
        <RightOutlined className={styles['reasoning-caret']} aria-hidden="true" />
      </button>
      {isOpen && text ? (
        <div
          id={contentID}
          ref={bodyRef}
          className={styles['reasoning-body']}
          data-reasoning-body
          data-following={scrollState.isFollowing || undefined}
          data-hidden-history={scrollState.hasHiddenHistory || undefined}
        >
          <div ref={contentRef} className={styles['reasoning-content']}>
            <ModelMarkdown content={text} isStreaming={isThinking} externalImageLabel={t('conversation.external_image')} className={styles['reasoning-text']} />
          </div>
        </div>
      ) : null}
    </div>
  );
});
