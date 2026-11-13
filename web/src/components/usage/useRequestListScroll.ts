import React from 'react';

import type { UsageEvent } from '../../types/usageEvents';
import { consumeWheel } from '../../utils/scrollSmoothing';
import { animateScrollToTop, type ScrollAnimationHandle } from '../../utils/smoothScroll';
import type { RequestListHandle } from './RequestVirtualList';
import { pendingArrivalCount } from './pollingPolicy';
import { createViewFlag } from './viewFlag';

/**
 * A device a finger can scroll. There the list is an ordinary overflowing element the browser
 * scrolls itself, with the platform's own tracking and momentum.
 */
const TOUCH_SCROLL_QUERY = '(any-pointer: coarse)';

function subscribeTouchScroll(onChange: () => void) {
  const query = window.matchMedia(TOUCH_SCROLL_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const readTouchScroll = () => window.matchMedia(TOUCH_SCROLL_QUERY).matches;

/**
 * Distance from the top at which the list counts as "following the live edge".
 * A few pixels of slack avoids fighting the browser's fractional scroll offsets.
 */
const FOLLOW_TOP_PX = 4;

/**
 * Distance past which the reader counts as reading history rather than the live
 * edge. Deliberately larger than FOLLOW_TOP_PX so the state cannot flap while a
 * trackpad coasts to a stop near the top.
 */
const HOLD_FROM_PX = 60;

/** Minimum overflow required before touch scroll auto-folds the header, avoiding short-list clamping. */
const AUTO_COLLAPSE_MIN_OVERFLOW_PX = 140;

/** Downward pull distance at row 1 required to restore the folded header on touch screens. */
const TOUCH_RESTORE_PULL_PX = 28;

/**
 * Upward wheel travel at row 1 that restores the folded header. It is summed over a gesture rather
 * than read from one event: a trackpad flick that coasts into the top arrives as a tail of small
 * deltas, none of which alone would cross a per-event threshold.
 */
const WHEEL_RESTORE_PULL_PX = 24;

/** A pause longer than this between wheel events starts a new gesture's sum. */
const WHEEL_GESTURE_GAP_MS = 250;

/**
 * Upper bound on how long an animated return to the top may hold the collapse
 * state. A smooth scroll to the top is a few hundred milliseconds; this is long
 * enough not to cut a legitimate animation short and short enough that a reader
 * who scrolls back down mid-flight regains full list behaviour promptly.
 */
const BACK_TO_TOP_GUARD_MS = 1_200;

/** Cap animated return runway so returning from deep history never mounts hundreds of transient rows. */
const MAX_BACK_TO_TOP_RUNWAY_PX = 960;

/**
 * The request list's scroll behaviour: following the live edge, holding the rows
 * the reader is reading, the header's collapse gestures and the return to the top.
 */
export function useRequestListScroll({
  viewScope,
  cursor,
}: {
  viewScope: string;
  cursor: string | undefined;
}) {
  const scopeKey = `${viewScope}:${cursor ?? ''}`;
  const heldScopeRef = React.useRef(scopeKey);
  const heldItemsRef = React.useRef<UsageEvent[] | null>(null);
  const heldBoundaryIDRef = React.useRef<number | undefined>(undefined);
  const fetchedBoundaryIDRef = React.useRef<number | undefined>(undefined);
  const latestItemsRef = React.useRef<UsageEvent[]>([]);
  // Only bumped when releasing a hold that actually buffered newer server rows,
  // so ordinary scrolling across HOLD_FROM_PX / FOLLOW_TOP_PX never re-renders
  // UsageEventsPage or triggers a redundant HTTP request.
  const [, bumpHoldRevision] = React.useState(0);

  if (heldScopeRef.current !== scopeKey) {
    heldScopeRef.current = scopeKey;
    heldItemsRef.current = null;
    heldBoundaryIDRef.current = undefined;
    fetchedBoundaryIDRef.current = undefined;
  }

  const pageRef = React.useRef<HTMLDivElement>(null);
  const scrollAreaRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<RequestListHandle>(null);
  const [collapse] = React.useState(() => createViewFlag());
  const [scrolledDown] = React.useState(() => createViewFlag());
  const lastScrollTopRef = React.useRef(0);
  const scrollAnimationRef = React.useRef<ScrollAnimationHandle | null>(null);
  const isNativeScroll = React.useSyncExternalStore(subscribeTouchScroll, readTouchScroll, () => false);
  const isNavigatingPageRef = React.useRef(false);
  const pageNavigationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isReturningToTopRef = React.useRef(false);
  const returnToTopTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const releaseHold = React.useCallback(() => {
    const held = heldItemsRef.current;
    if (!held) return;
    const hadPendingUpdates =
      held !== latestItemsRef.current || fetchedBoundaryIDRef.current !== undefined;
    heldItemsRef.current = null;
    heldBoundaryIDRef.current = undefined;
    fetchedBoundaryIDRef.current = undefined;
    if (hadPendingUpdates) {
      bumpHoldRevision((revision) => revision + 1);
    }
  }, []);

  const schedulePageNavigationReset = React.useCallback(() => {
    if (pageNavigationTimerRef.current) clearTimeout(pageNavigationTimerRef.current);
    pageNavigationTimerRef.current = setTimeout(() => {
      isNavigatingPageRef.current = false;
      lastScrollTopRef.current = 0;
      scrolledDown.set(false);
      pageNavigationTimerRef.current = null;
    }, 300);
  }, [scrolledDown]);

  React.useEffect(
    () => () => {
      if (pageNavigationTimerRef.current) clearTimeout(pageNavigationTimerRef.current);
      if (returnToTopTimerRef.current) clearTimeout(returnToTopTimerRef.current);
      scrollAnimationRef.current?.cancel();
    },
    [],
  );

  const endReturnToTop = React.useCallback(() => {
    isReturningToTopRef.current = false;
    if (returnToTopTimerRef.current) {
      clearTimeout(returnToTopTimerRef.current);
      returnToTopTimerRef.current = null;
    }
  }, []);

  const handleScroll = React.useCallback(
    (e: React.UIEvent<HTMLElement>) => {
      const target = e.currentTarget;
      const { scrollTop } = target;
      const previousScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;

      scrolledDown.set(scrollTop > 60);

      if (scrollTop <= FOLLOW_TOP_PX) {
        releaseHold();
        if (isReturningToTopRef.current) endReturnToTop();
      } else if (scrollTop > HOLD_FROM_PX && !heldItemsRef.current && latestItemsRef.current.length > 0) {
        heldBoundaryIDRef.current = latestItemsRef.current.reduce(
          (highest, event) => Math.max(highest, event.id),
          0,
        );
        heldItemsRef.current = latestItemsRef.current;
      }

      if (isReturningToTopRef.current || isNavigatingPageRef.current) {
        return;
      }

      // Collapse into fullscreen on downward scroll across both desktop and mobile once the
      // list has enough scrollable runway beyond the expanded header tail that folding never
      // clamps the active scroll offset back toward zero.
      const rawHeaderSpace = Number(pageRef.current?.dataset.headerSpace);
      const headerSpace = Number.isFinite(rawHeaderSpace) && rawHeaderSpace > 0 ? rawHeaderSpace : 0;
      if (
        !collapse.get()
        && scrollTop > 50
        && scrollTop > previousScrollTop
        && target.scrollHeight - target.clientHeight > headerSpace + AUTO_COLLAPSE_MIN_OVERFLOW_PX
      ) {
        collapse.set(true);
      }
    },
    [collapse, endReturnToTop, releaseHold, scrolledDown],
  );

  // Non-passive native wheel listener on the scroll area:
  // 1. At the top edge in normal mode, wheeling down collapses the header and prevents
  //    native scroll so row 1 stays pinned without a post-frame jump.
  // 2. At the top edge in collapsed mode, wheeling up restores the header.
  React.useEffect(() => {
    const area = scrollAreaRef.current;
    if (!area) return undefined;

    let upwardPull = 0;
    let lastWheelAt = -Infinity;

    const onWheel = (e: WheelEvent) => {
      // A trackpad swipe almost always drifts a little sideways, so the gesture counts as vertical
      // when its vertical part dominates; requiring a zero horizontal delta ignored most flicks on
      // macOS and left the header folded.
      if (
        isNavigatingPageRef.current || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey
        || Math.abs(e.deltaX) >= Math.abs(e.deltaY)
      ) {
        return;
      }
      if (e.timeStamp - lastWheelAt > WHEEL_GESTURE_GAP_MS) upwardPull = 0;
      lastWheelAt = e.timeStamp;

      if (!collapse.get() && e.deltaY > 10 && lastScrollTopRef.current <= 5) {
        consumeWheel(e);
        if (e.cancelable) e.preventDefault();
        collapse.set(true);
        listRef.current?.scrollTo({ top: 0 });
        lastScrollTopRef.current = 0;
        return;
      }

      if (!collapse.get() || e.deltaY >= 0 || lastScrollTopRef.current > 2) {
        upwardPull = 0;
        return;
      }
      upwardPull -= e.deltaY;
      if (upwardPull >= WHEEL_RESTORE_PULL_PX) {
        consumeWheel(e);
        if (e.cancelable) e.preventDefault();
        upwardPull = 0;
        collapse.set(false);
      }
    };

    let activeTouchId: number | null = null;
    let startX = 0;
    let startY = 0;
    let topAnchorY: number | null = null;
    let hasRestoredInGesture = false;

    const resetTouch = () => {
      activeTouchId = null;
      topAnchorY = null;
      hasRestoredInGesture = false;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        resetTouch();
        return;
      }
      const touch = e.touches[0];
      activeTouchId = touch.identifier;
      startX = touch.clientX;
      startY = touch.clientY;
      topAnchorY = lastScrollTopRef.current <= 2 ? touch.clientY : null;
      hasRestoredInGesture = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (activeTouchId === null || hasRestoredInGesture || !collapse.get() || isNavigatingPageRef.current) {
        return;
      }
      let touch: Touch | undefined;
      for (let i = 0; i < e.touches.length; i += 1) {
        if (e.touches[i].identifier === activeTouchId) {
          touch = e.touches[i];
          break;
        }
      }
      if (!touch) return;
      if (Math.abs(touch.clientX - startX) > Math.abs(touch.clientY - startY)) return;
      if (lastScrollTopRef.current > 2) {
        topAnchorY = null;
        return;
      }
      if (topAnchorY === null) {
        topAnchorY = touch.clientY;
        return;
      }
      if (touch.clientY - topAnchorY >= TOUCH_RESTORE_PULL_PX) {
        hasRestoredInGesture = true;
        collapse.set(false);
      }
    };

    area.addEventListener('wheel', onWheel, { passive: false });
    area.addEventListener('touchstart', onTouchStart, { passive: true });
    area.addEventListener('touchmove', onTouchMove, { passive: true });
    area.addEventListener('touchend', resetTouch, { passive: true });
    area.addEventListener('touchcancel', resetTouch, { passive: true });
    return () => {
      area.removeEventListener('wheel', onWheel);
      area.removeEventListener('touchstart', onTouchStart);
      area.removeEventListener('touchmove', onTouchMove);
      area.removeEventListener('touchend', resetTouch);
      area.removeEventListener('touchcancel', resetTouch);
    };
  }, [collapse]);

  const scrollListToTop = React.useCallback(() => {
    scrollAnimationRef.current?.cancel();
    scrollAnimationRef.current = null;
    listRef.current?.scrollTo({ top: 0 });
    lastScrollTopRef.current = 0;
  }, []);

  const handleBackToTop = React.useCallback(() => {
    isReturningToTopRef.current = true;
    if (returnToTopTimerRef.current) clearTimeout(returnToTopTimerRef.current);
    returnToTopTimerRef.current = setTimeout(endReturnToTop, BACK_TO_TOP_GUARD_MS);
    releaseHold();
    scrollAnimationRef.current?.cancel();
    const startScrollTop = Math.min(lastScrollTopRef.current, MAX_BACK_TO_TOP_RUNWAY_PX);
    if (startScrollTop < lastScrollTopRef.current) {
      listRef.current?.scrollTo({ top: startScrollTop });
      lastScrollTopRef.current = startScrollTop;
    }
    scrollAnimationRef.current = animateScrollToTop(
      startScrollTop,
      (top) => {
        listRef.current?.scrollTo({ top });
      },
      {
        onComplete: () => {
          listRef.current?.scrollTo({ top: 0 });
          lastScrollTopRef.current = 0;
        },
      },
    );
    scrolledDown.set(false);
    collapse.set(false);
  }, [collapse, endReturnToTop, releaseHold, scrolledDown]);

  const handleToggleExpand = React.useCallback(() => {
    collapse.set((isCollapsed) => !isCollapsed);
  }, [collapse]);

  // Reset collapse only on filter / window changes (NOT cursor pagination, and
  // not on a poll: a refresh must never expand or collapse the reader's view).
  React.useEffect(() => {
    collapse.set(false);
    scrolledDown.set(false);
  }, [collapse, scrolledDown, viewScope]);

  const observeLatest = React.useCallback((items: UsageEvent[] | undefined) => {
    latestItemsRef.current = items ?? [];
  }, []);

  const getHeldBoundaryID = React.useCallback(() => heldBoundaryIDRef.current, []);

  const noteFetchedBoundaryID = React.useCallback((boundaryID: number | undefined) => {
    fetchedBoundaryIDRef.current = boundaryID;
  }, []);

  const resolveDisplayedItems = React.useCallback(
    (latest: UsageEvent[] | undefined): UsageEvent[] => heldItemsRef.current ?? latest ?? [],
    [],
  );

  const pendingArrivals = React.useCallback((arrivedCount: number | undefined) => {
    const held = heldItemsRef.current;
    if (!held || fetchedBoundaryIDRef.current !== heldBoundaryIDRef.current) return 0;
    return pendingArrivalCount(held.length, arrivedCount);
  }, []);

  const markPageNavigation = React.useCallback(() => {
    isNavigatingPageRef.current = true;
  }, []);

  return {
    pageRef,
    scrollAreaRef,
    listRef,
    isNativeScroll,
    collapse,
    scrolledDown,
    observeLatest,
    getHeldBoundaryID,
    noteFetchedBoundaryID,
    resolveDisplayedItems,
    pendingArrivals,
    markPageNavigation,
    handleScroll,
    handleBackToTop,
    handleToggleExpand,
    scrollListToTop,
    schedulePageNavigationReset,
  };
}
