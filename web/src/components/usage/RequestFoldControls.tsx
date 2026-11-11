import React from 'react';
import { Button } from 'antd';

import { useT } from '../../i18n';
import { sharedResizeObserverHub } from '../../performance/resizeObserverHub';
import { MOTION_ROLL_PRESENCE } from '../../theme/themeConfig';
import { isMotionReduced } from '../../utils/motionPreference';
import { FullscreenExitOutlined, FullscreenOutlined, VerticalAlignTopOutlined } from '../icons';
import { Tooltip } from '../common/Tooltip';
import { useViewFlag, type ViewFlag } from './viewFlag';
import './RequestFoldControls.css';

const HEADER_TUCK_PX = 12;

function parseStylePx(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readPageLayoutMetrics(page: HTMLElement): {
  top: number;
  left: number;
  right: number;
  gap: number;
} {
  if (typeof window === 'undefined') {
    return { top: 32, left: 32, right: 32, gap: 16 };
  }
  const style = window.getComputedStyle(page);
  return {
    top: parseStylePx(style.paddingTop, 32),
    left: parseStylePx(style.paddingLeft, 32),
    right: parseStylePx(style.paddingRight, 32),
    gap: parseStylePx(style.rowGap, 16),
  };
}

function setAttrFlag(element: HTMLElement | null, name: string, isActive: boolean) {
  if (!element) return;
  if (isActive) element.setAttribute(name, '');
  else element.removeAttribute(name);
}

function applySettledStreamOffset(page: HTMLElement | null, offsetPx: number) {
  if (!page) return;
  page.dataset.headerSpace = String(offsetPx);
  const stream = page.querySelector<HTMLElement>('.request-stream');
  const pagination = stream?.querySelector<HTMLElement>('.request-pagination') ?? null;
  const list = stream?.querySelector<HTMLElement>('.request-list') ?? null;
  const tail = stream?.querySelector<HTMLElement>('.request-list-tail') ?? null;
  const track = stream?.querySelector<HTMLElement>('.request-scroll-track') ?? null;
  if (stream) {
    stream.style.transform = offsetPx > 0 ? `translateY(${offsetPx}px)` : '';
  }
  if (pagination) {
    pagination.style.transform = offsetPx > 0 ? `translateY(${-offsetPx}px)` : '';
  }
  if (list) {
    list.style.scrollPaddingBottom = offsetPx > 0 ? `${offsetPx}px` : '';
  }
  if (tail) {
    tail.style.height = offsetPx > 0 ? `${offsetPx}px` : '0px';
  }
  if (track) {
    track.style.bottom = offsetPx > 0 ? `${3 + offsetPx}px` : '3px';
  }
}

function clearFoldAnimationState(
  animationsRef: React.MutableRefObject<Animation[]>,
  header: HTMLElement | null,
  stream: HTMLElement | null,
  pagination: HTMLElement | null,
) {
  for (const animation of animationsRef.current) {
    animation.cancel();
  }
  animationsRef.current = [];
  setAttrFlag(header, 'data-fold-active', false);
  setAttrFlag(stream, 'data-fold-active', false);
  setAttrFlag(pagination, 'data-fold-active', false);
}

/**
 * The page header and filter toolbar, folded away while the reader scrolls.
 *
 * The header overlays a permanently fullscreen-sized `.request-stream-slot`, while
 * `.request-stream` and `.request-pagination` rest at direct non-inherited compositor
 * transforms. Folding and unfolding therefore avoid custom-property style cascades,
 * flex/grid layout recalculations, ResizeObserver churn, and row repaints.
 */
export function RequestCollapsibleHeader({
  collapse,
  pageRef,
  children,
}: {
  collapse: ViewFlag;
  pageRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const isCollapsed = useViewFlag(collapse);
  const headerRef = React.useRef<HTMLDivElement>(null);
  const prevCollapsedRef = React.useRef(isCollapsed);
  const animationsRef = React.useRef<Animation[]>([]);
  const generationRef = React.useRef(0);
  const headerSpaceRef = React.useRef(0);

  const resolvePageElement = React.useCallback(
    () => pageRef.current ?? headerRef.current?.parentElement ?? null,
    [pageRef],
  );

  const syncHeaderGeometry = React.useCallback(
    (isCurrentlyCollapsed: boolean, shouldApplyOffset = true) => {
      const header = headerRef.current;
      const page = resolvePageElement();
      if (!page || !header) return 0;
      const metrics = readPageLayoutMetrics(page);
      header.style.top = `${metrics.top}px`;
      header.style.left = `${metrics.left}px`;
      header.style.right = `${metrics.right}px`;
      const height = header.offsetHeight;
      if (height > 0) {
        headerSpaceRef.current = Math.round(height + metrics.gap);
      }
      if (shouldApplyOffset) {
        applySettledStreamOffset(page, isCurrentlyCollapsed ? 0 : headerSpaceRef.current);
      }
      return headerSpaceRef.current;
    },
    [resolvePageElement],
  );

  React.useLayoutEffect(() => {
    const header = headerRef.current;
    const page = resolvePageElement();
    if (!page || !header) return undefined;
    syncHeaderGeometry(collapse.get());
    const unsubHeader = sharedResizeObserverHub.observe(
      header,
      () => {
        if (animationsRef.current.length === 0) {
          syncHeaderGeometry(collapse.get());
        }
      },
      { freezeOnTransition: false, epsilonPx: 1 },
    );
    const unsubPage = sharedResizeObserverHub.observe(
      page,
      () => {
        if (animationsRef.current.length === 0) {
          syncHeaderGeometry(collapse.get());
        }
      },
      { freezeOnTransition: false, epsilonPx: 1 },
    );
    return () => {
      unsubHeader();
      unsubPage();
    };
  }, [collapse, resolvePageElement, syncHeaderGeometry]);

  React.useLayoutEffect(() => {
    const header = headerRef.current;
    const page = resolvePageElement();
    const slot = page?.querySelector<HTMLElement>('.request-stream-slot') ?? null;
    const stream = page?.querySelector<HTMLElement>('.request-stream') ?? null;
    const pagination = stream?.querySelector<HTMLElement>('.request-pagination') ?? null;

    if (
      isCollapsed
      && header
      && typeof document !== 'undefined'
      && document.activeElement instanceof Node
      && header.contains(document.activeElement)
    ) {
      transferFoldFocus(header, 'restore');
    }
    if (header) {
      (header as HTMLElement & { inert?: boolean }).inert = isCollapsed;
      setAttrFlag(header, 'inert', isCollapsed);
    }
    setAttrFlag(stream, 'data-collapsed', isCollapsed);

    if (prevCollapsedRef.current === isCollapsed) {
      syncHeaderGeometry(isCollapsed);
      return;
    }
    prevCollapsedRef.current = isCollapsed;

    generationRef.current += 1;
    const generation = generationRef.current;
    const wasAnimating = animationsRef.current.length > 0;

    if (
      !page
      || !header
      || !slot
      || !stream
      || isMotionReduced()
      || typeof header.animate !== 'function'
      || typeof stream.animate !== 'function'
    ) {
      clearFoldAnimationState(animationsRef, header, stream, pagination);
      syncHeaderGeometry(isCollapsed);
      return;
    }

    const slotRectBefore = wasAnimating ? slot.getBoundingClientRect() : null;
    const liveStreamOffset = wasAnimating && slotRectBefore
      ? stream.getBoundingClientRect().top - slotRectBefore.top
      : null;
    const liveHeaderOpacity = wasAnimating ? Number.parseFloat(getComputedStyle(header).opacity) : null;
    clearFoldAnimationState(animationsRef, header, stream, pagination);

    const fullDeltaY = headerSpaceRef.current > 0
      ? headerSpaceRef.current
      : syncHeaderGeometry(isCollapsed, false);
    if (!(fullDeltaY > 0.5)) {
      applySettledStreamOffset(page, isCollapsed ? 0 : fullDeltaY);
      return;
    }

    // Settle non-layout transforms immediately; defer tail/scrollbar height updates
    // until the 180ms compositor animation finishes so frame 0 triggers zero layout.
    stream.style.transform = isCollapsed ? '' : `translateY(${fullDeltaY}px)`;
    if (pagination) {
      pagination.style.transform = isCollapsed ? '' : `translateY(${-fullDeltaY}px)`;
    }

    setAttrFlag(header, 'data-fold-active', true);
    setAttrFlag(stream, 'data-fold-active', true);
    setAttrFlag(pagination, 'data-fold-active', true);

    const startStreamOffset = liveStreamOffset !== null
      ? liveStreamOffset
      : (isCollapsed ? fullDeltaY : 0);
    const endStreamOffset = isCollapsed ? 0 : fullDeltaY;
    const progress = Math.min(1, Math.max(0, 1 - startStreamOffset / fullDeltaY));
    const startOpacity = liveHeaderOpacity !== null && Number.isFinite(liveHeaderOpacity)
      ? liveHeaderOpacity
      : (isCollapsed ? 1 : 0);
    const endOpacity = isCollapsed ? 0 : 1;
    const startHeaderY = -HEADER_TUCK_PX * progress;
    const endHeaderY = isCollapsed ? -HEADER_TUCK_PX : 0;

    const timing: KeyframeAnimationOptions = {
      duration: MOTION_ROLL_PRESENCE.duration,
      easing: MOTION_ROLL_PRESENCE.easing,
      fill: 'forwards',
    };

    const animations: Animation[] = [
      header.animate(
        [
          { opacity: startOpacity, transform: `translateY(${startHeaderY}px)` },
          { opacity: endOpacity, transform: `translateY(${endHeaderY}px)` },
        ],
        timing,
      ),
      stream.animate(
        [
          { transform: `translateY(${startStreamOffset}px)` },
          { transform: `translateY(${endStreamOffset}px)` },
        ],
        timing,
      ),
    ];
    if (pagination && typeof pagination.animate === 'function') {
      animations.push(
        pagination.animate(
          [
            { transform: `translateY(${-startStreamOffset}px)` },
            { transform: `translateY(${-endStreamOffset}px)` },
          ],
          timing,
        ),
      );
    }
    animationsRef.current = animations;

    void animations[1].finished.then(
      () => {
        if (generationRef.current !== generation) return;
        clearFoldAnimationState(animationsRef, header, stream, pagination);
        syncHeaderGeometry(isCollapsed);
      },
      () => undefined,
    );
  }, [isCollapsed, resolvePageElement, syncHeaderGeometry]);

  React.useEffect(
    () => () => {
      generationRef.current += 1;
      const page = resolvePageElement();
      const stream = page?.querySelector<HTMLElement>('.request-stream') ?? null;
      const pagination = stream?.querySelector<HTMLElement>('.request-pagination') ?? null;
      clearFoldAnimationState(animationsRef, headerRef.current, stream, pagination);
    },
    [resolvePageElement],
  );

  return (
    <div
      ref={headerRef}
      aria-hidden={isCollapsed || undefined}
      className={`request-collapsible-header${isCollapsed ? ' is-collapsed' : ''}`}
    >
      {children}
    </div>
  );
}

function transferFoldFocus(fromElement: HTMLElement | null, targetKind: 'expand' | 'restore') {
  const page = fromElement?.closest<HTMLElement>('.request-events-page') ?? document.body;
  const counterpart = page.querySelector<HTMLElement>(`[data-fold-control="${targetKind}"]`);
  counterpart?.focus({ preventScroll: true });
}

export function RequestRestoreButton({ collapse, onRestore }: { collapse: ViewFlag; onRestore: () => void }) {
  const t = useT();
  const isCollapsed = useViewFlag(collapse);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const shouldTransferFocusRef = React.useRef(false);
  const label = t('events.collapse_view');

  React.useLayoutEffect(() => {
    if (!isCollapsed && shouldTransferFocusRef.current) {
      shouldTransferFocusRef.current = false;
      transferFoldFocus(buttonRef.current, 'expand');
    }
  }, [isCollapsed]);

  return (
    <Tooltip title={isCollapsed ? label : undefined}>
      <Button
        ref={buttonRef}
        data-fold-control="restore"
        className="req-expand-toggle-btn req-restore-header-btn"
        style={isCollapsed ? undefined : { display: 'none' }}
        aria-hidden={!isCollapsed || undefined}
        tabIndex={isCollapsed ? undefined : -1}
        aria-label={label}
        icon={<FullscreenExitOutlined />}
        onClick={(event) => {
          shouldTransferFocusRef.current =
            document.activeElement instanceof Node && event.currentTarget.contains(document.activeElement);
          onRestore();
        }}
      />
    </Tooltip>
  );
}

export function RequestFoldToggle({ collapse, onToggle }: { collapse: ViewFlag; onToggle: () => void }) {
  const t = useT();
  const isCollapsed = useViewFlag(collapse);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const shouldTransferFocusRef = React.useRef(false);
  const label = t(isCollapsed ? 'events.collapse_view' : 'events.expand_view');

  React.useLayoutEffect(() => {
    if (isCollapsed && shouldTransferFocusRef.current) {
      shouldTransferFocusRef.current = false;
      transferFoldFocus(buttonRef.current, 'restore');
    }
  }, [isCollapsed]);

  return (
    <Tooltip title={isCollapsed ? undefined : label}>
      <Button
        ref={buttonRef}
        data-fold-control="expand"
        className="req-expand-toggle-btn"
        tabIndex={isCollapsed ? -1 : undefined}
        aria-label={label}
        icon={<FullscreenOutlined />}
        onClick={(event) => {
          shouldTransferFocusRef.current =
            document.activeElement instanceof Node && event.currentTarget.contains(document.activeElement);
          onToggle();
        }}
      />
    </Tooltip>
  );
}

/** Shown once the reader has left the top, or while records wait above them. */
export function RequestBackToTop({
  scrolledDown,
  pendingCount,
  onBackToTop,
}: {
  scrolledDown: ViewFlag;
  pendingCount: number;
  onBackToTop: () => void;
}) {
  const t = useT();
  const isScrolledDown = useViewFlag(scrolledDown);
  if (!isScrolledDown && pendingCount <= 0) return null;
  const label = pendingCount > 0 ? t('events.new_records', { n: pendingCount }) : t('events.back_to_top');
  return (
    <button
      type="button"
      className={`req-back-to-top-btn${pendingCount > 0 ? ' is-live' : ''}`}
      onClick={onBackToTop}
      aria-label={label}
    >
      <VerticalAlignTopOutlined className="req-back-to-top-icon" />
      <span className="req-back-to-top-text">{label}</span>
    </button>
  );
}
