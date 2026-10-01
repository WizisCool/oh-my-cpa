/**
 * The request list under a finger: the list follows the finger, coasts when it is flicked, and the
 * page header folds and unfolds with the same gestures a wheel uses (docs/design.md §7).
 *
 * The virtualized list clips its own overflow, so the browser cannot scroll it for a finger, and the
 * library's own touch emulation runs ahead of the finger: it restarts a fixed-interval coast after
 * every move, and that coast keeps firing between moves while the finger is still down. Every touch
 * move over the list is therefore taken from the library and the list is moved here, by exactly the
 * distance the finger travelled. A release coasts at the speed the finger left with.
 */

/** A finger's position at a moment, in the clock of `performance.now()` and event time stamps. */
export interface TouchSample {
  time: number;
  y: number;
}

/**
 * How quickly a coast loses speed: the time for it to fall to 1/e. This is iOS's normal
 * deceleration (98% of the speed kept per 10ms), the coast a phone reader's hand is used to.
 */
export const COAST_TIME_CONSTANT_MS = -1 / Math.log(0.998);

/** Only the last stretch of a drag says how fast the finger left. */
export const RELEASE_WINDOW_MS = 100;

/** Slower than this at release (px/ms) is a finger that stopped before lifting, not a flick. */
export const MIN_COAST_VELOCITY = 0.1;

/** A bound on a flick's speed (px/ms), so one stray touch report cannot fling the list a whole page. */
export const MAX_COAST_VELOCITY = 6;

/** A coast ends below this speed (px/ms): a few pixels a second, less than a pixel a frame. */
export const COAST_STOP_VELOCITY = 0.01;

/**
 * How far a finger has to travel up before a drag folds the header away. Above a finger's jitter
 * on a tap, and well under the distance of a deliberate drag.
 */
export const FOLD_DRAG_PX = 10;

/**
 * How far a finger has to pull the list down past its top before the header unfolds. The touch
 * counterpart of the wheel's top bounce, so it has to be deliberate: a reader dragging back to the
 * top must not unfold it on arrival.
 */
export const UNFOLD_PULL_PX = 48;

/**
 * The speed the list should coast at after release, in content pixels per millisecond: positive
 * moves further down the list. Measured up to the release itself, so a finger that slowed before
 * lifting coasts slowly, and one that rested for `RELEASE_WINDOW_MS` does not coast at all. The
 * measurement starts at the last sample before that window, so a busy page that reported only one
 * move inside it still has a distance to measure.
 */
export function releaseVelocity(samples: readonly TouchSample[], releasedAt: number): number {
  const firstRecent = samples.findIndex((sample) => releasedAt - sample.time <= RELEASE_WINDOW_MS);
  if (firstRecent < 0) return 0;
  const anchor = samples[Math.max(0, firstRecent - 1)];
  const last = samples[samples.length - 1];
  const duration = releasedAt - anchor.time;
  if (anchor === last || duration <= 0) return 0;
  const velocity = (anchor.y - last.y) / duration;
  if (Math.abs(velocity) < MIN_COAST_VELOCITY) return 0;
  return Math.max(-MAX_COAST_VELOCITY, Math.min(MAX_COAST_VELOCITY, velocity));
}

/** How far a coast that started at `velocity` has carried the list after `elapsed` milliseconds. */
export function coastDistance(velocity: number, elapsed: number): number {
  const time = Math.max(0, elapsed);
  return velocity * COAST_TIME_CONSTANT_MS * (1 - Math.exp(-time / COAST_TIME_CONSTANT_MS));
}

/** Whether a coast that started at `velocity` is still moving after `elapsed` milliseconds. */
export function isCoasting(velocity: number, elapsed: number): boolean {
  return Math.abs(velocity * Math.exp(-Math.max(0, elapsed) / COAST_TIME_CONSTANT_MS)) >= COAST_STOP_VELOCITY;
}

/**
 * What a vertical drag is for, decided on its first vertical move. An unfolded header is folded by
 * a drag up wherever it starts; any other drag over the list moves the list; anything else is left
 * to the browser.
 */
export function dragIntent({
  travelY,
  isCollapsed,
  isOverList,
}: {
  travelY: number;
  isCollapsed: boolean;
  isOverList: boolean;
}): 'fold' | 'drive' | 'native' {
  if (!isCollapsed && travelY < 0) return 'fold';
  return isOverList ? 'drive' : 'native';
}

interface Gesture {
  startX: number;
  startY: number;
  /** `claimed`: the gesture has folded or unfolded the header and moves nothing else. */
  intent: 'undecided' | 'fold' | 'drive' | 'native' | 'claimed';
  /** The list's holder when the finger landed on the list. */
  holder: HTMLElement | null;
  startOffset: number;
  samples: TouchSample[];
}

export interface RequestListTouchOptions {
  page: HTMLElement;
  /** The virtualized list's scrolling holder, when `target` is inside the list. */
  findHolder: (target: EventTarget | null) => HTMLElement | null;
  /** Moves the list to `top` and has it on screen before returning. */
  scrollListTo: (top: number) => void;
  isCollapsed: () => boolean;
  setCollapsed: (isCollapsed: boolean) => void;
  /** True while something else owns the list's offset, such as a page change. */
  isPaused: () => boolean;
  /** A finger has started moving the list: anything else moving it has to stop. */
  onDriveStart: () => void;
}

export interface RequestListTouch {
  /** Stops a coast in flight, so a correction or another gesture is not dragged along by it. */
  stopCoast: () => void;
  dispose: () => void;
}

/**
 * Takes a touch move away from the virtual list and, when it is cancelable, from the browser.
 *
 * The list scrolls a finger itself from a listener on the touched row, and skips a move another
 * handler has flagged; the page's listener runs in the capture phase, before it.
 */
function takeFromList(event: TouchEvent) {
  (event as TouchEvent & { _virtualHandled?: boolean })._virtualHandled = true;
}

function claim(event: TouchEvent) {
  takeFromList(event);
  if (event.cancelable) event.preventDefault();
}

function maxOffset(holder: HTMLElement) {
  return Math.max(0, holder.scrollHeight - holder.clientHeight);
}

export function installRequestListTouch(options: RequestListTouchOptions): RequestListTouch {
  const { page } = options;
  let gesture: Gesture | null = null;
  let coastFrame = 0;
  /** A tap that stopped a coast only stops it, as on a native scroller; it must not open a row. */
  let shouldSwallowClick = false;

  const stopCoast = () => {
    if (!coastFrame) return false;
    cancelAnimationFrame(coastFrame);
    coastFrame = 0;
    return true;
  };

  const moveList = (holder: HTMLElement, top: number) => {
    const clamped = Math.max(0, Math.min(maxOffset(holder), top));
    if (Math.abs(clamped - holder.scrollTop) >= 0.5) options.scrollListTo(clamped);
    return clamped;
  };

  const startCoast = (holder: HTMLElement, velocity: number, releasedAt: number) => {
    const from = holder.scrollTop;
    const step = (now: number) => {
      const elapsed = now - releasedAt;
      const target = from + coastDistance(velocity, elapsed);
      const landed = moveList(holder, target);
      const isAtEnd = landed !== target;
      coastFrame = !isAtEnd && isCoasting(velocity, elapsed) && holder.isConnected ? requestAnimationFrame(step) : 0;
    };
    coastFrame = requestAnimationFrame(step);
  };

  const handleTouchStart = (event: TouchEvent) => {
    const wasCoasting = stopCoast();
    shouldSwallowClick = wasCoasting;
    if (event.touches.length !== 1) {
      gesture = null;
      return;
    }
    const touch = event.touches[0];
    const holder = options.findHolder(event.target);
    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      intent: 'undecided',
      holder,
      startOffset: holder?.scrollTop ?? 0,
      samples: [{ time: event.timeStamp, y: touch.clientY }],
    };
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (!gesture) return;
    if (gesture.holder) takeFromList(event);
    if (event.touches.length !== 1 || options.isPaused()) return;
    const touch = event.touches[0];
    const travelY = touch.clientY - gesture.startY;
    if (gesture.intent === 'undecided') {
      const travelX = touch.clientX - gesture.startX;
      if (Math.abs(travelY) > Math.abs(travelX)) {
        gesture.intent = dragIntent({ travelY, isCollapsed: options.isCollapsed(), isOverList: gesture.holder !== null });
        if (gesture.intent === 'drive') {
          options.onDriveStart();
          gesture.startOffset = gesture.holder!.scrollTop;
        }
      } else if (Math.abs(travelX) > FOLD_DRAG_PX) {
        gesture.intent = 'native';
      } else {
        return;
      }
    }
    switch (gesture.intent) {
      case 'claimed':
        claim(event);
        return;
      case 'fold':
        claim(event);
        if (-travelY >= FOLD_DRAG_PX) {
          gesture.intent = 'claimed';
          options.setCollapsed(true);
        }
        return;
      case 'drive': {
        claim(event);
        const holder = gesture.holder!;
        gesture.samples.push({ time: event.timeStamp, y: touch.clientY });
        if (gesture.samples.length > 32) gesture.samples.splice(0, gesture.samples.length - 32);
        const target = gesture.startOffset - travelY;
        if (options.isCollapsed() && -target >= UNFOLD_PULL_PX) {
          gesture.intent = 'claimed';
          options.setCollapsed(false);
          return;
        }
        moveList(holder, target);
        return;
      }
      default:
    }
  };

  const handleTouchEnd = (event: TouchEvent) => {
    // Only a tap ends in a click; a drag that stopped a coast leaves the next click alone.
    if (gesture && gesture.intent !== 'undecided') shouldSwallowClick = false;
    if (gesture?.intent === 'drive' && gesture.holder && event.touches.length === 0 && !options.isPaused()) {
      const velocity = releaseVelocity(gesture.samples, event.timeStamp);
      if (velocity !== 0) startCoast(gesture.holder, velocity, event.timeStamp);
    }
    if (event.touches.length === 0) gesture = null;
  };

  const handleTouchCancel = () => {
    gesture = null;
  };

  const handleClick = (event: MouseEvent) => {
    if (!shouldSwallowClick) return;
    shouldSwallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // A wheel or a key while the list coasts is the reader taking over.
  const handleOtherInput = () => {
    stopCoast();
  };

  page.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
  page.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
  page.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
  page.addEventListener('touchcancel', handleTouchCancel, { capture: true, passive: true });
  page.addEventListener('click', handleClick, { capture: true });
  page.addEventListener('wheel', handleOtherInput, { capture: true, passive: true });
  page.addEventListener('keydown', handleOtherInput, { capture: true });

  return {
    stopCoast: () => {
      stopCoast();
    },
    dispose: () => {
      stopCoast();
      page.removeEventListener('touchstart', handleTouchStart, { capture: true });
      page.removeEventListener('touchmove', handleTouchMove, { capture: true });
      page.removeEventListener('touchend', handleTouchEnd, { capture: true });
      page.removeEventListener('touchcancel', handleTouchCancel, { capture: true });
      page.removeEventListener('click', handleClick, { capture: true });
      page.removeEventListener('wheel', handleOtherInput, { capture: true });
      page.removeEventListener('keydown', handleOtherInput, { capture: true });
    },
  };
}
