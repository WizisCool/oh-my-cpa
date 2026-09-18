import React from 'react';

import type { ListyRef } from 'antd';

import type { UsageEvent } from '../../types/usageEvents';
import { animateScrollToTop, type ScrollAnimationHandle } from '../../utils/smoothScroll';
import { pendingArrivalCount } from './pollingPolicy';

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

/**
 * Upper bound on how long an animated return to the top may hold the collapse
 * state. A smooth scroll to the top is a few hundred milliseconds; this is long
 * enough not to cut a legitimate animation short and short enough that a reader
 * who scrolls back down mid-flight regains full list behaviour promptly.
 */
const BACK_TO_TOP_GUARD_MS = 1_200;

/**
 * The request list's scroll behaviour: following the live edge, holding the rows
 * the reader is reading, the header's collapse gestures and the return to the top.
 *
 * Scroll and the live edge are one hook because they are one mechanism: the
 * scroll position is what decides whether the list follows or holds, and the
 * return-to-top gesture is what resumes it. The hold also feeds the list query,
 * which is why this runs before it.
 */
export function useRequestListScroll({
  viewScope,
  cursor,
}: {
  viewScope: string;
  cursor: string | undefined;
}) {

  /**
   * The rows the reader is holding while scrolled away, or null when following.
   *
   * Declared here rather than beside the live-tail logic below because the list
   * query depends on it: while holding, the request carries the newest visible
   * request time so the server can report how much has arrived since. See the
   * live-tail section for what holding means.
   */
  const [heldItems, setHeldItems] = React.useState<UsageEvent[] | null>(null);
  // The arrival count is anchored to the row id the reader held when Hold began.
  // Keeping it separate from the rendered rows prevents a poll that carries the
  // new row from moving the boundary forward and hiding the count it should show.
  const heldBoundaryIDRef = React.useRef<number | undefined>(undefined);

  // Full-height scroll-down expansion & top-bounce expand mode & back-to-top
  const listRef = React.useRef<ListyRef>(null);
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [isScrolledDown, setIsScrolledDown] = React.useState(false);
  /**
   * The reader's scroll position, captured from the list's own scroll events.
   *
   * A gesture animates from here, and the value has to come from the element that
   * actually scrolls: the virtualizer nests the rows in an inner holder, so the
   * host node's own `scrollTop` is always zero and animating from it would move
   * nothing.
   */
  const lastScrollTopRef = React.useRef(0);
  /** The in-flight return-to-top animation, so a second gesture replaces it. */
  const scrollAnimationRef = React.useRef<ScrollAnimationHandle | null>(null);
  const isNavigatingPageRef = React.useRef(false);
  const justCollapsedFromTopRef = React.useRef(false);
  const pageNavigationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Set while an animated return to the top is in flight.
   *
   * A smooth scroll emits scroll events the whole way up, and the early ones
   * still carry a large `scrollTop` - so without this guard the collapse rule
   * below would re-collapse the header on the first frame of the very gesture
   * that was expanding it. The guard is cleared on reaching the top, or by its
   * own deadline if the reader interrupts the animation and it never arrives.
   */
  const isReturningToTopRef = React.useRef(false);
  const returnToTopTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePageNavigationReset = React.useCallback(() => {
    if (pageNavigationTimerRef.current) clearTimeout(pageNavigationTimerRef.current);
    pageNavigationTimerRef.current = setTimeout(() => {
      isNavigatingPageRef.current = false;
      lastScrollTopRef.current = 0;
      setIsScrolledDown(false);
      pageNavigationTimerRef.current = null;
    }, 300);
  }, []);

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
      const { scrollTop } = e.currentTarget;
      lastScrollTopRef.current = scrollTop;

      // Show back-to-top button when scrolled down
      setIsScrolledDown(scrollTop > 60);

      // Following vs. holding. The top of the list is the live edge: at the top
      // the list follows new records, and scrolling away freezes the rows on
      // screen so the reader keeps their place.
      if (scrollTop <= FOLLOW_TOP_PX) {
        if (heldItemsRef.current) {
          heldBoundaryIDRef.current = undefined;
          setHeldItems(null);
        }
        if (isReturningToTopRef.current) endReturnToTop();
      } else if (scrollTop > HOLD_FROM_PX && !heldItemsRef.current && latestItemsRef.current.length > 0) {
        heldBoundaryIDRef.current = latestItemsRef.current.reduce(
          (highest, event) => Math.max(highest, event.id),
          0,
        );
        setHeldItems(latestItemsRef.current);
      }

      // An in-flight return to the top owns the collapse state until it lands;
      // see isReturningToTopRef for why this cannot be left to the scroll event.
      if (isReturningToTopRef.current) {
        return;
      }

      // Programmatic scroll-to-top during page change must not cancel collapse
      if (isNavigatingPageRef.current) {
        return;
      }

      // If we just collapsed into full-screen mode from the very top,
      // keep the list pinned at row 1 (scrollTop = 0) so the first record is never skipped
      if (justCollapsedFromTopRef.current) {
        justCollapsedFromTopRef.current = false;
        if (scrollTop > 0) {
          listRef.current?.scrollTo({ top: 0 });
          lastScrollTopRef.current = 0;
        }
        return;
      }
      // Scrolling down collapses header into full-screen mode
      if (scrollTop > 50) {
        if (!isCollapsed) setIsCollapsed(true);
      }
    },
    [endReturnToTop, isCollapsed],
  );

  // Wheel handling:
  // 1. When at top edge and wheeling down in normal mode: collapse header and keep row 1 visible.
  // 2. When at top edge and wheeling up in collapsed mode: intentional top-bounce overscroll expands header.
  const handleWheel = React.useCallback(
    (e: React.WheelEvent<HTMLElement>) => {
      if (isNavigatingPageRef.current) return;

      if (!isCollapsed && e.deltaY > 10 && lastScrollTopRef.current <= 5) {
        // First wheel down from top: enter full-screen mode, but freeze scroll at top
        // so row 1 stays visible in full screen mode!
        justCollapsedFromTopRef.current = true;
        setIsCollapsed(true);
        listRef.current?.scrollTo({ top: 0 });
        if (e.cancelable) {
          e.preventDefault();
        }
        return;
      }

      if (isCollapsed && e.deltaY < -15 && lastScrollTopRef.current <= 2) {
        // Intentional top-bounce when already at the very top: unfold header
        setIsCollapsed(false);
      }
    },
    [isCollapsed],
  );

  /**
   * Scrolling a virtualized list to row one takes two passes. The first pass
   * lands against the content height the list is holding; committing the new
   * rows then makes it re-measure, and it re-applies the offset it was holding,
   * which leaves a residual scroll of roughly one row's top margin. The second
   * pass lands after that commit.
   *
   * This is a correction, so it is never animated: its callers (page navigation,
   * collapsing into full-screen mode) need row one on screen before their next
   * statement runs. Any gesture still in flight is stopped first, so a correction
   * cannot be dragged back by an animation that outlived its click.
   */
  const scrollListToTop = React.useCallback(() => {
    scrollAnimationRef.current?.cancel();
    scrollAnimationRef.current = null;
    listRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: 0 }));
  }, []);

  const handleBackToTop = React.useCallback(() => {
    // The one scroll the reader directly asked for, so it is the one that moves.
    // The animation is driven through Listy's own `scrollTo` rather than through
    // CSS on the holder: the virtualizer keeps writing `scrollTop` itself, so a
    // holder-level `scroll-behavior` fights it and, measured on the real list, the
    // holder never moves at all.
    isReturningToTopRef.current = true;
    if (returnToTopTimerRef.current) clearTimeout(returnToTopTimerRef.current);
    returnToTopTimerRef.current = setTimeout(endReturnToTop, BACK_TO_TOP_GUARD_MS);
    // Resuming is explicit here: the scroll events that follow will also clear it,
    // but the reader clicked "apply", so do not depend on event timing.
    heldBoundaryIDRef.current = undefined;
    setHeldItems(null);
    scrollAnimationRef.current?.cancel();
    scrollAnimationRef.current = animateScrollToTop(
      lastScrollTopRef.current,
      (top) => {
        listRef.current?.scrollTo({ top });
      },
      {
        onComplete: () => {
          listRef.current?.scrollTo({ top: 0 });
          requestAnimationFrame(() => listRef.current?.scrollTo({ top: 0 }));
        },
      },
    );
    setIsScrolledDown(false);
    setIsCollapsed(false);
  }, [endReturnToTop]);

  const handleToggleExpand = React.useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  // Reset collapse only on filter / window changes (NOT cursor pagination, and
  // not on a poll: a refresh must never expand or collapse the reader's view).
  React.useEffect(() => {
    setIsCollapsed(false);
    setIsScrolledDown(false);
  }, [viewScope]);

  const heldBoundaryID = heldItems ? heldBoundaryIDRef.current : undefined;

  // ---- live tail ----
  // While the reader is at the top the list follows the newest records. Once
  // they scroll away it holds the rows they are reading and reports how many
  // have arrived since, the way log viewers do it: applying the update would
  // move text out from under the cursor, and jumping to the top is the worst
  // version of that. Scrolling back to the top resumes and applies the backlog.
  const latestItemsRef = React.useRef<UsageEvent[]>([]);
  const heldItemsRef = React.useRef<UsageEvent[] | null>(null);
  heldItemsRef.current = heldItems;

  /**
   * The page reports the rows its current read returned.
   *
   * A render-time ref write rather than an effect, and it has to stay one: a
   * scroll event can arrive before an effect would have run, and it must observe
   * the rows of the render the reader is actually looking at.
   */
  const observeLatest = React.useCallback((items: UsageEvent[] | undefined) => {
    latestItemsRef.current = items ?? [];
  }, []);

  // A different view, or a different page, starts following again.
  React.useEffect(() => {
    heldBoundaryIDRef.current = undefined;
    setHeldItems(null);
  }, [viewScope, cursor]);

  /**
   * How much has been recorded since the reader stopped following, counted by
   * the server against the boundary the request carried. Diffing the loaded rows
   * would under-report: the list is sorted by request time, so a request that
   * started earlier and finished later arrives below the first page rather than
   * at the top of it. Zero while the reader is at the live edge, where arriving
   * records are simply part of the list.
   */
  const pendingArrivals = React.useCallback(
    (arrivedCount: number | undefined) => pendingArrivalCount(heldItems?.length ?? 0, arrivedCount),
    [heldItems],
  );

  /** A page change owns the scroll until it settles; see `isNavigatingPageRef`. */
  const markPageNavigation = React.useCallback(() => {
    isNavigatingPageRef.current = true;
  }, []);

  return {
    listRef,
    isCollapsed,
    isScrolledDown,
    heldItems,
    heldBoundaryID,
    observeLatest,
    pendingArrivals,
    markPageNavigation,
    handleScroll,
    handleWheel,
    handleBackToTop,
    handleToggleExpand,
    scrollListToTop,
    schedulePageNavigationReset,
  };
}
