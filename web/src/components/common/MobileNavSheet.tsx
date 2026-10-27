import React from 'react';
import { useDrag } from '@use-gesture/react';
import { isMotionReduced } from '../../utils/motionPreference';

/**
 * Faster than this (px/ms) over at least `FLING_DISTANCE_PX`, a release is a fling: the sheet settles
 * the way it was thrown, wherever it stands.
 */
const FLING_VELOCITY = 0.35;
const FLING_DISTANCE_PX = 32;
/**
 * How far a swipe the other way on an open sheet has to travel to read as Back. Well past a tap's
 * jitter, short enough that a thumb's flick reaches it.
 */
const BACK_SWIPE_PX = 48;
/** Longer than the slide; the transition's own end normally arrives first. */
const SETTLE_FALLBACK_MS = 400;

/**
 * Touch events rather than pointer events, so a page scroll cannot cancel a drag; not passive, so a
 * drag the sheet takes does not also scroll what is under the finger. `axis` leaves a drag that starts
 * vertical to the browser, and the threshold leaves a tap's jitter to the control under it and
 * gives the first move a direction. `filterTaps` stays off: after any drag it swallows the next
 * click on the element, and that would be the console's next tap.
 */
const DRAG_OPTIONS = {
  pointer: { touch: true },
  axis: 'x',
  threshold: 10,
  eventOptions: { passive: false },
  // A fling is read from the release alone, however long the finger held the sheet before it.
  swipe: { velocity: FLING_VELOCITY, distance: FLING_DISTANCE_PX, duration: Infinity },
} as const;

/**
 * Where a sideways swipe means something else: text to select or edit, an editor, a chart, a slider,
 * and anything that handles touch itself or asks to be left alone.
 */
const SWIPE_EXCLUDED = 'input, textarea, select, [contenteditable="true"], .monaco-editor, canvas, [role="slider"], [data-swipe-ignore]';

/**
 * Whether a swipe that starts on `target` may open the sheet. A strip scrolled away from its start
 * takes a swipe back towards it; at its start it has nowhere to go, so the swipe opens the sheet.
 */
function canOpenFrom(target: EventTarget | null, page: HTMLElement): boolean {
  if (!(target instanceof Element) || target.closest(SWIPE_EXCLUDED)) return false;
  if (window.getSelection()?.isCollapsed === false) return false;
  for (let element: Element | null = target; element && element !== page; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (style.touchAction === 'none') return false;
    if (element.scrollLeft > 0 && /auto|scroll/.test(style.overflowX)) return false;
  }
  return true;
}

/** What the finger on the sheet is doing: drawing it out, pushing it back, or swiping Back. */
type DragMode = 'open' | 'close' | 'back';

export interface MobileNavSheetProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /**
   * The page beside the sheet. A sideways swipe across it opens the sheet, and it is inert while
   * the sheet is open.
   */
  pageRef: React.RefObject<HTMLElement | null>;
  label: string;
  children: React.ReactNode;
}

/**
 * The navigation rail on a phone, as a sheet that follows the finger.
 *
 * A swipe towards the trailing edge anywhere on the page draws the sheet out with the finger, and a
 * swipe back on the sheet or the dimmed page puts it away; on release it settles open or closed by
 * where it stands and how fast it was moving. A swipe towards the trailing edge on the open sheet is
 * read as Back and closes it too. A tap on the dimmed page, Escape and Back (through the
 * caller's overlay history) close it as well. The gestures are `@use-gesture/react`'s; what is
 * decided here is what each one means for the sheet. The drag writes one custom property per move and
 * nothing renders: the panel's transform and the mask's opacity are both derived from it in CSS, so
 * a move costs a style recalculation on two layers.
 */
export function MobileNavSheet({ isOpen, onOpenChange, pageRef, label, children }: MobileNavSheetProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  // The rail is drawn the first time the sheet is asked for, then kept so the next drag starts at once.
  const [hasContent, setHasContent] = React.useState(isOpen);
  const isOpenRef = React.useRef(isOpen);
  isOpenRef.current = isOpen;
  const onOpenChangeRef = React.useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const settleTimerRef = React.useRef<number | undefined>(undefined);

  /** Slides the sheet to an end; a closed sheet leaves the screen once it has slid away. */
  const settle = React.useCallback((shouldOpen: boolean) => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    window.clearTimeout(settleTimerRef.current);
    root.classList.remove('is-dragging');
    if (shouldOpen && !root.classList.contains('is-active')) {
      root.classList.add('is-active');
      // The closed position has to be laid out before the open one, or there is nothing to slide from.
      void panel.getBoundingClientRect();
    }
    root.style.setProperty('--nav-sheet-progress', shouldOpen ? '1' : '0');
    if (shouldOpen) return;
    const hide = () => {
      window.clearTimeout(settleTimerRef.current);
      panel.removeEventListener('transitionend', onEnd);
      if (!isOpenRef.current && !root.classList.contains('is-dragging')) root.classList.remove('is-active');
    };
    const onEnd = (event: TransitionEvent) => { if (event.target === panel) hide(); };
    if (isMotionReduced()) {
      hide();
      return;
    }
    panel.addEventListener('transitionend', onEnd);
    settleTimerRef.current = window.setTimeout(hide, SETTLE_FALLBACK_MS);
  }, []);

  React.useLayoutEffect(() => {
    if (isOpen) setHasContent(true);
    if (isOpen || rootRef.current?.classList.contains('is-active')) settle(isOpen);
  }, [isOpen, settle]);

  React.useEffect(() => () => window.clearTimeout(settleTimerRef.current), []);

  // While open the sheet is the only thing on screen that takes input: the page is inert, focus moves
  // into the sheet and returns to where it was when the sheet closes.
  React.useEffect(() => {
    if (!isOpen) return undefined;
    const page = pageRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    page?.setAttribute('inert', '');
    panelRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChangeRef.current(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      page?.removeAttribute('inert');
      document.removeEventListener('keydown', onKeyDown);
      if (opener && panelRef.current?.contains(document.activeElement)) opener.focus({ preventScroll: true });
    };
  }, [isOpen, pageRef]);

  const dragRef = React.useRef<{ mode: DragMode; width: number } | null>(null);

  /** Takes the sheet under the finger: no transition, so it is exactly where the finger puts it. */
  const track = (mode: DragMode) => {
    dragRef.current = { mode, width: panelRef.current?.offsetWidth || 1 };
    if (mode === 'back') return;
    window.clearTimeout(settleTimerRef.current);
    if (mode === 'open') setHasContent(true);
    rootRef.current?.classList.add('is-active', 'is-dragging');
  };
  const follow = (progress: number) => {
    rootRef.current?.style.setProperty('--nav-sheet-progress', String(Math.min(1, Math.max(0, progress))));
  };
  /** Settles a released drag: a fling goes where it was thrown, a slow release to the nearer end. */
  const release = (progress: number, swipeX: number, isCanceled: boolean) => {
    dragRef.current = null;
    const shouldOpen = isCanceled ? isOpenRef.current : swipeX !== 0 ? swipeX > 0 : progress >= 0.5;
    settle(shouldOpen);
    if (shouldOpen !== isOpenRef.current) onOpenChangeRef.current(shouldOpen);
  };

  useDrag(({ first, last, tap, initial: [fromX], xy: [x], swipe: [swipeX], event, cancel }) => {
    const page = pageRef.current;
    if (tap || !page) return;
    // From where the finger landed: `movement` leaves out the threshold, and the sheet would trail it.
    const moveX = x - fromX;
    if (first) {
      if (isOpenRef.current || moveX <= 0 || !canOpenFrom(event.target, page)) {
        cancel();
        return;
      }
      track('open');
    }
    const drag = dragRef.current;
    if (drag?.mode !== 'open') return;
    if (event.cancelable) event.preventDefault();
    const progress = moveX / drag.width;
    follow(progress);
    if (last) release(progress, swipeX, event.type === 'touchcancel');
  }, { ...DRAG_OPTIONS, target: pageRef });

  useDrag(({ first, last, tap, initial: [fromX], xy: [x], swipe: [swipeX], event, cancel }) => {
    if (tap) return;
    const moveX = x - fromX;
    if (first) {
      if (!isOpenRef.current) {
        cancel();
        return;
      }
      // A swipe towards the trailing edge is the gesture that means Back everywhere else on a phone.
      // The sheet cannot follow it - it is already fully out - so it closes on release instead.
      track(moveX > 0 ? 'back' : 'close');
    }
    const drag = dragRef.current;
    if (!drag || drag.mode === 'open') return;
    if (event.cancelable) event.preventDefault();
    if (drag.mode === 'back') {
      if (!last) return;
      dragRef.current = null;
      if (event.type !== 'touchcancel' && (moveX >= BACK_SWIPE_PX || swipeX > 0)) onOpenChangeRef.current(false);
      return;
    }
    const progress = 1 + moveX / drag.width;
    follow(progress);
    if (last) release(progress, swipeX, event.type === 'touchcancel');
  }, { ...DRAG_OPTIONS, target: rootRef });

  return (
    <div ref={rootRef} className="mobile-nav-sheet">
      <div className="mobile-nav-sheet-mask" aria-hidden="true" onClick={() => onOpenChange(false)} />
      <div ref={panelRef} className="mobile-nav-sheet-panel" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {hasContent && children}
      </div>
    </div>
  );
}
