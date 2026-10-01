/**
 * Console-wide smoothing for the reader's own wheel and keyboard scrolls.
 *
 * A trackpad, a phone and macOS all deliver scrolls as a stream of small, already-smoothed offsets,
 * so the page glides. A notched mouse wheel on Windows or Linux delivers one 100px jump per notch,
 * and whether the browser animates that jump is the operating system's call: Chromium and Firefox
 * both stop animating it as soon as Windows' "Animation effects" is off. The same build therefore
 * glides on one desk and steps on the next, and the request list - a virtualized list that applies
 * every wheel delta itself - steps on every Windows desk regardless of the setting.
 *
 * This layer turns each discrete step into a glide over the `scroll` motion token
 * (`MOTION_SCROLL`, `docs/design.md` §7) and leaves every continuous source alone: a trackpad
 * stream is already smooth, and re-smoothing it would only add latency. Touch input is never
 * intercepted, because a phone's own momentum is the smooth scroll and anything layered on top of it
 * fights the finger.
 *
 * Programmatic scrolls are not touched. A correction (`smoothScroll.ts`) must land before the next
 * statement runs, and a glide that is moving an element stops the moment anything else writes its
 * offset, so a correction always wins over a glide still in flight.
 */

import { MOTION_SCROLL } from '../theme/themeConfig';
import { easeOutCubic } from './smoothScroll';

/** Whether wheel and keyboard scrolls glide: always, unless the system asks for reduced motion, or never. */
export type ScrollSmoothingPreference = 'on' | 'system' | 'off';

export const SCROLL_SMOOTHING_PREFERENCES: readonly ScrollSmoothingPreference[] = ['on', 'system', 'off'];

export const SCROLL_SMOOTHING_PREFERENCE_KEY = 'omc_scroll_smoothing';

/**
 * On by default, including for a reader whose system reports reduced motion. See ADR 0046: on
 * Windows that report is the "Animation effects" switch, which most readers turn off to make the
 * desktop feel faster, and it is also what disables the browser's own wheel animation. A glide that
 * follows the reader's own wheel is input, not decoration - macOS and iOS keep inertial scrolling
 * under Reduce Motion for the same reason - and `system` is one click away for a reader who wants
 * the operating system's switch to decide.
 */
export const DEFAULT_SCROLL_SMOOTHING: ScrollSmoothingPreference = 'on';

export function parseScrollSmoothing(raw: unknown): ScrollSmoothingPreference | undefined {
  return SCROLL_SMOOTHING_PREFERENCES.includes(raw as ScrollSmoothingPreference)
    ? (raw as ScrollSmoothingPreference)
    : undefined;
}

export function isScrollSmoothingActive(preference: ScrollSmoothingPreference, prefersReducedMotion: boolean): boolean {
  if (preference === 'off') return false;
  if (preference === 'system') return !prefersReducedMotion;
  return true;
}

/** Pixels one line of a line-mode wheel delta (Firefox) moves; Chromium's own line height for wheels. */
export const WHEEL_LINE_PX = 40;

/** Pixels an arrow key moves, matching what Chromium and Firefox scroll per key press. */
export const ARROW_KEY_PX = 40;

/**
 * How long after a continuous wheel event a stream is still treated as continuous.
 *
 * A trackpad occasionally emits a delta that happens to look like a notch; inside a stream that has
 * already shown itself to be continuous, that one event must not be smoothed and lag behind its
 * neighbours.
 */
export const CONTINUOUS_STREAM_MS = 200;

/**
 * A notch's legacy `wheelDeltaY` is a multiple of 120 on every engine that reports it; a trackpad's
 * is an arbitrary value. The legacy field is the only signal that separates the two in pixel mode.
 */
const WHEEL_NOTCH = 120;

/** The parts of a `WheelEvent` the classification reads, so it can be decided without a DOM. */
export interface WheelSample {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  wheelDeltaY?: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * isDiscreteWheel decides whether a wheel event is a notch that steps rather than a stream that
 * already glides.
 *
 * Line and page modes are always notches. In pixel mode a notch is recognised by its legacy delta,
 * except on Apple platforms, where the operating system already accelerates and smooths every
 * pixel-mode source and the reader reports the console as smooth. Zoom (Ctrl/⌘), horizontal
 * (Shift, or any horizontal component) and Alt-modified wheels keep their native meaning.
 */
export function isDiscreteWheel(sample: WheelSample, { isApple }: { isApple: boolean }): boolean {
  if (sample.ctrlKey || sample.metaKey || sample.altKey || sample.shiftKey) return false;
  if (sample.deltaY === 0 || sample.deltaX !== 0) return false;
  if (sample.deltaMode !== 0) return true;
  if (isApple) return false;
  if (typeof sample.wheelDeltaY === 'number' && sample.wheelDeltaY !== 0) {
    return sample.wheelDeltaY % WHEEL_NOTCH === 0;
  }
  // An engine without the legacy field: a notch is a whole, large step; a trackpad's deltas are
  // small or fractional.
  return Number.isInteger(sample.deltaY) && Math.abs(sample.deltaY) >= WHEEL_LINE_PX;
}

/** wheelDistance converts a wheel delta to pixels, so every mode glides by what it would have jumped. */
export function wheelDistance(sample: Pick<WheelSample, 'deltaMode' | 'deltaY'>, viewportHeight: number): number {
  if (sample.deltaMode === 1) return sample.deltaY * WHEEL_LINE_PX;
  if (sample.deltaMode === 2) return sample.deltaY * pageDistance(viewportHeight);
  return sample.deltaY;
}

/**
 * pageDistance is one Page Down: the viewport less a 40px overlap, and never less than seven eighths
 * of it, which is the overlap rule both Chromium and Firefox use so the last line read stays on screen.
 */
export function pageDistance(viewportHeight: number): number {
  return Math.max(viewportHeight * 0.875, viewportHeight - ARROW_KEY_PX);
}

/** Where a key moves a scroller: by a distance, or to one of its ends. */
export type KeyScroll = { by: number } | { to: 'start' | 'end' };

/** keyScrollFor maps a key press to a scroll, or null when the key does not scroll. */
export function keyScrollFor(key: string, shiftKey: boolean, viewportHeight: number): KeyScroll | null {
  switch (key) {
    case 'ArrowDown':
      return shiftKey ? null : { by: ARROW_KEY_PX };
    case 'ArrowUp':
      return shiftKey ? null : { by: -ARROW_KEY_PX };
    case 'PageDown':
      return { by: pageDistance(viewportHeight) };
    case 'PageUp':
      return { by: -pageDistance(viewportHeight) };
    case ' ':
      return { by: shiftKey ? -pageDistance(viewportHeight) : pageDistance(viewportHeight) };
    case 'Home':
      return shiftKey ? null : { to: 'start' };
    case 'End':
      return shiftKey ? null : { to: 'end' };
    default:
      return null;
  }
}

/**
 * glidePosition is the offset for one frame of a glide.
 *
 * Like `scrollTopAt`, a pure function of elapsed time rather than an accumulator, so a dropped frame
 * cannot drift the glide, and it returns the destination exactly once the token's duration has
 * elapsed. The easing decelerates from a non-zero start: a curve that starts at rest (the console's
 * `ease` token does) would stall at every notch of a wheel that is still turning, because each notch
 * restarts the glide from where it is.
 */
export function glidePosition(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  return from + (to - from) * easeOutCubic(elapsedMs / durationMs);
}

/**
 * A wheel event nested virtual lists coordinate through. `@rc-component/virtual-list` - every antd
 * virtualized list, the request list among them - applies a wheel delta itself in one jump unless an
 * earlier listener has claimed the event with this flag, which is the library's own mechanism for a
 * list nested in another.
 */
type ClaimableEvent = Event & { _virtualHandled?: boolean };

/**
 * A virtualized list's holder clips its overflow (`overflow-y: hidden`) and owns its wheel; its
 * `scrollTop` is the list's offset, but it is not the list's state. The filler inside it is the
 * library's structural signature.
 */
function isVirtualHolder(element: Element): boolean {
  return element.querySelector(':scope > div > [class*="-holder-inner"]') !== null;
}

function maxScrollTop(element: Element): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function isVerticalScroller(element: Element): boolean {
  if (maxScrollTop(element) < 1) return false;
  const overflowY = getComputedStyle(element).overflowY;
  if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return true;
  if (element === document.scrollingElement) {
    return getComputedStyle(document.body).overflowY !== 'hidden' && overflowY !== 'hidden';
  }
  return overflowY === 'hidden' && isVirtualHolder(element);
}

function containsOverscroll(element: Element): boolean {
  const behaviour = getComputedStyle(element).overscrollBehaviorY;
  return behaviour === 'contain' || behaviour === 'none';
}

/**
 * The editable controls and composite widgets that own their keys. An arrow in a listbox moves the
 * selection, a Space on a button presses it; scrolling as well would answer one key press twice.
 */
const KEY_OWNER_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="grid"]',
  '[role="treegrid"]',
  '[role="tree"]',
  '[role="tablist"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="radiogroup"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="application"]',
].join(',');

const SPACE_OWNER_SELECTOR = 'button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"]';

/** Wheel events a component has consumed; see `consumeWheel`. */
const consumedWheels = new WeakSet<Event>();
/** Wheel events this layer took over from a virtualized list, which therefore did not move for them. */
const claimedWheels = new WeakSet<Event>();

/**
 * consumeWheel tells the smoothing layer that a component has given this wheel event a meaning of
 * its own and nothing must scroll for it.
 *
 * `preventDefault` cannot say this from a React handler: React attaches its wheel listener as
 * passive, so the call is ignored and `defaultPrevented` stays false. A component that turns a notch
 * into something other than a scroll - the request list collapsing its header - calls this with the
 * native event instead.
 *
 * Returns whether the layer had taken the event over from a virtualized list. When it had, the list
 * did not apply the notch either, so nothing moved; when it had not (smoothing is off, or the notch
 * was not one this layer glides), the list has already scheduled its own jump and the caller still
 * has to undo it.
 */
export function consumeWheel(event: Event): boolean {
  consumedWheels.add(event);
  return claimedWheels.has(event);
}

interface Glide {
  from: number;
  to: number;
  startedAt: number;
  /** The offset this glide last wrote or requested, so a write by anyone else is detectable. */
  written: number;
  /**
   * Whether the scroller is a virtualized list's holder, which is moved through the list rather than
   * by writing its offset. Writing `scrollTop` there is undone: the list keeps the offset in React
   * state and re-applies it from an updater that runs after the next write, so every frame of the
   * glide would be dragged back one frame and the glide would read its own echo as a foreign write.
   * The list is instead handed each frame's step as a wheel event of its own, which it applies
   * through the same functional update it applies a real wheel with - one authority over the offset.
   */
  isVirtual: boolean;
  /** The last two frames' steps: a virtual list applies a step a frame late, so its offset trails by up to both. */
  recentSteps: [number, number];
}

/**
 * A write by someone else - a correction, the scrollbar thumb, a virtualizer re-applying the row it
 * holds - shows up as an offset more than this far from the one the glide wrote. Fractional offsets
 * round differently across engines and zoom levels, so an exact comparison would cancel every glide.
 */
const FOREIGN_WRITE_PX = 2;

export interface ScrollSmoothing {
  setEnabled: (isEnabled: boolean) => void;
  dispose: () => void;
}

/**
 * installScrollSmoothing attaches the console-wide wheel and keyboard listeners.
 *
 * Wheel handling is split across two phases on `window`. The capture phase runs before any element
 * listener: it decides whether the event is a notch this layer will glide and, when the scroller is a
 * virtualized list, claims it so the list does not jump as well. The bubble phase runs after every
 * element listener: a component that called `preventDefault` natively, or `consumeWheel` from React
 * (the request list does, to collapse its header on the first notch instead of scrolling), has said
 * the scroll must not happen, and the glide is dropped. Only then does this layer take the scroll
 * over.
 */
export function installScrollSmoothing({ durationMs = MOTION_SCROLL.duration }: { durationMs?: number } = {}): ScrollSmoothing {
  let isEnabled = true;
  let lastContinuousAt = Number.NEGATIVE_INFINITY;
  let pendingWheel: { event: WheelEvent; scroller: Element; distance: number } | null = null;
  let lastPointerTarget: Element | null = null;
  let frame = 0;
  const glides = new Map<Element, Glide>();
  const isApple = /Mac|iPhone|iPad|iPod/.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '',
  );

  /** The destination a scroller is heading to: a glide's target, or where it already is. */
  const destinationOf = (element: Element) => glides.get(element)?.to ?? element.scrollTop;

  /**
   * The nearest scroller from `start` outward that can still move in `direction`. The walk reaches
   * the document's own scroller last, and stops early at a scroller that contains its overscroll,
   * as the native scroll would.
   */
  const findScroller = (start: Element | null, direction: number): Element | null => {
    for (let element = start; element; element = element.parentElement) {
      if (!isVerticalScroller(element)) continue;
      const destination = destinationOf(element);
      const canMove = direction > 0 ? destination < maxScrollTop(element) - 0.5 : destination > 0.5;
      if (canMove) return element;
      if (containsOverscroll(element)) return null;
    }
    return null;
  };

  const step = (now: number) => {
    frame = 0;
    for (const [element, glide] of glides) {
      const slack = glide.isVirtual ? Math.abs(glide.recentSteps[0]) + Math.abs(glide.recentSteps[1]) : 0;
      if (!element.isConnected || Math.abs(element.scrollTop - glide.written) > FOREIGN_WRITE_PX + slack) {
        glides.delete(element);
        continue;
      }
      // Content can grow or shrink under a glide (a virtualized list measures rows as they render),
      // so the destination is re-clamped every frame rather than trusted from the input.
      glide.to = Math.min(glide.to, maxScrollTop(element));
      const elapsed = now - glide.startedAt;
      const position = glidePosition(glide.from, glide.to, elapsed, durationMs);
      if (glide.isVirtual) {
        const stepPx = position - glide.written;
        if (stepPx !== 0) element.dispatchEvent(new WheelEvent('wheel', { deltaY: stepPx, cancelable: true }));
        glide.recentSteps = [stepPx, glide.recentSteps[0]];
        glide.written = position;
      } else {
        element.scrollTop = position;
        glide.written = element.scrollTop;
      }
      if (elapsed >= durationMs) glides.delete(element);
    }
    if (glides.size > 0) frame = requestAnimationFrame(step);
  };

  const glideTo = (element: Element, destination: number) => {
    const to = Math.min(Math.max(destination, 0), maxScrollTop(element));
    const current = glides.get(element);
    const isVirtual = isVirtualHolder(element);
    // A virtual list's offset trails the glide by a frame, so a retarget continues from where the
    // glide asked it to be rather than from where it has got to.
    const from = isVirtual && current ? current.written : element.scrollTop;
    // A new step retargets the glide from where it is now, so a turning wheel accelerates instead of
    // queueing notches behind each other.
    glides.set(element, {
      from,
      to,
      startedAt: performance.now(),
      written: from,
      isVirtual,
      recentSteps: current?.recentSteps ?? [0, 0],
    });
    if (!frame) frame = requestAnimationFrame(step);
  };

  const onWheelCapture = (event: WheelEvent) => {
    pendingWheel = null;
    // The steps this layer hands a virtual list are wheel events too; they are already smooth.
    if (!isEnabled || !event.cancelable || !event.isTrusted) return;
    if (!isDiscreteWheel(event, { isApple })) {
      lastContinuousAt = event.timeStamp;
      return;
    }
    if (event.timeStamp - lastContinuousAt < CONTINUOUS_STREAM_MS) return;
    const target = event.target instanceof Element ? event.target : null;
    const direction = Math.sign(event.deltaY);
    const scroller = findScroller(target, direction);
    if (!scroller) return;
    const distance = wheelDistance(event, scroller.clientHeight);
    if (isVirtualHolder(scroller)) {
      (event as ClaimableEvent)._virtualHandled = true;
      claimedWheels.add(event);
    }
    pendingWheel = { event, scroller, distance };
  };

  const onWheelBubble = (event: WheelEvent) => {
    const pending = pendingWheel;
    pendingWheel = null;
    if (!pending || pending.event !== event || event.defaultPrevented || consumedWheels.has(event)) return;
    event.preventDefault();
    glideTo(pending.scroller, destinationOf(pending.scroller) + pending.distance);
  };

  const onPointerDown = (event: PointerEvent) => {
    lastPointerTarget = event.target instanceof Element ? event.target : null;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isEnabled || event.defaultPrevented || event.isComposing) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const focused = event.target instanceof Element ? event.target : null;
    if (focused?.closest(KEY_OWNER_SELECTOR)) return;
    if (event.key === ' ' && focused?.closest(SPACE_OWNER_SELECTOR)) return;
    // With nothing focused the browser scrolls the region the reader last clicked in, so start there.
    const isUnfocused = !focused || focused === document.body || focused === document.documentElement;
    const start = isUnfocused
      ? lastPointerTarget?.isConnected
        ? lastPointerTarget
        : document.querySelector('[data-scroll-root]')
      : focused;
    const probe = keyScrollFor(event.key, event.shiftKey, 0);
    if (!probe) return;
    const direction = 'by' in probe ? Math.sign(probe.by) : probe.to === 'end' ? 1 : -1;
    const scroller = findScroller(start, direction);
    if (!scroller) return;
    const move = keyScrollFor(event.key, event.shiftKey, scroller.clientHeight);
    if (!move) return;
    event.preventDefault();
    if ('by' in move) {
      glideTo(scroller, destinationOf(scroller) + move.by);
    } else {
      glideTo(scroller, move.to === 'start' ? 0 : maxScrollTop(scroller));
    }
  };

  window.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
  window.addEventListener('wheel', onWheelBubble, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });

  return {
    setEnabled: (next) => {
      isEnabled = next;
      if (!next) glides.clear();
    },
    dispose: () => {
      window.removeEventListener('wheel', onWheelCapture, { capture: true });
      window.removeEventListener('wheel', onWheelBubble);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      if (frame) cancelAnimationFrame(frame);
      glides.clear();
    },
  };
}
