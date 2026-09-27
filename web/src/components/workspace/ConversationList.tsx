import React from 'react';
import { Bubble } from '@ant-design/x';
import type { BubbleItemType, BubbleListProps } from '@ant-design/x';
import type { BubbleListRef } from '@ant-design/x/es/bubble/interface';
import { ArrowDownOutlined } from '../icons';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import styles from './Workspace.module.css';

export interface ConversationListHandle {
  /** Returns the reader to the newest message and resumes following the stream. */
  followLatest: (behavior?: 'instant' | 'smooth') => void;
}

export interface ConversationListProps {
  items: BubbleItemType[];
  roles: BubbleListProps['role'];
  latestLabel: string;
}

/**
 * How far above the newest message the reader may be and still count as following it.
 *
 * A few lines rather than a pixel: a wheel notch that lands just short of the bottom should not
 * turn the "back to latest" control on, and a reader who has scrolled one message up clearly has.
 */
const FOLLOW_THRESHOLD_PX = 48;

/**
 * The transcript, anchored to its newest message by the browser rather than by script.
 *
 * Ant Design X's list lays its scroll box out in reverse (`column-reverse`), so a growing answer
 * keeps the bottom where it is without a line of JavaScript per token, and once the reader has
 * scrolled away the library holds their position while content grows below. Following in script
 * instead - a resize observer pinning `scrollTop` - costs a write per frame and has to find a
 * scroll box that is recreated whenever the conversation is reset; the native anchoring has
 * neither cost.
 *
 * In a reversed box `scrollTop` is zero at the newest message and negative above it, which is why
 * the distance is read as its magnitude.
 */
export const ConversationList = React.forwardRef<ConversationListHandle, ConversationListProps>(
  function ConversationList({ items, roles, latestLabel }, ref) {
    const listRef = React.useRef<BubbleListRef>(null);
    const [isAway, setIsAway] = React.useState(false);
    const isReducedMotion = usePrefersReducedMotion();

    const followLatest = React.useCallback((behavior: 'instant' | 'smooth' = 'instant') => {
      setIsAway(false);
      listRef.current?.scrollTo({ top: 'bottom', behavior });
    }, []);

    React.useImperativeHandle(ref, () => ({ followLatest }), [followLatest]);

    const onScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
      const box = event.currentTarget;
      // The library marks a reversed box with this class; reading the class rather than the
      // computed style keeps a scroll frame from forcing a style recalculation.
      const distance = box.classList.contains('ant-bubble-list-autoscroll')
        ? Math.abs(box.scrollTop)
        : box.scrollHeight - box.scrollTop - box.clientHeight;
      setIsAway(distance > FOLLOW_THRESHOLD_PX);
    }, []);

    return (
      <div className={styles['conversation']}>
        <Bubble.List
          ref={listRef}
          items={items}
          role={roles}
          autoScroll
          className={styles['transcript']}
          onScroll={onScroll}
        />
        {isAway && (
          <button
            type="button"
            className={styles['latest']}
            onClick={() => followLatest(isReducedMotion ? 'instant' : 'smooth')}
          >
            <ArrowDownOutlined aria-hidden="true" />
            <span>{latestLabel}</span>
          </button>
        )}
      </div>
    );
  },
);
