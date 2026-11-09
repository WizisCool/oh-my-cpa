import React from 'react';

/** Pixels of a smooth wheel or touchpad stream that make one step; a mouse notch is about 100. */
const WHEEL_STEP_PX = 50;

/**
 * Steps a value with the wheel while the pointer is over `element`: up for a larger value, down for
 * a smaller one. The wheel is taken from the page only over the element, and only vertically, so a
 * sideways swipe and a pinch zoom (a wheel with Ctrl held) pass through.
 *
 * A line- or page-mode wheel reports a notch per event and steps once per event. A pixel stream is
 * summed and steps once per `WHEEL_STEP_PX`, so one swipe on a touchpad does not race through the
 * range.
 *
 * Being over the element is not on its own a request for a change: `isEnabled` and `canStep` are
 * where a caller says the reader has engaged the control - a field holding the caret, an editor
 * that is open - so a wheel that merely crosses the control still scrolls the page.
 *
 * `canStep` is asked on every wheel event, before the page's scroll is taken: a control that is
 * disabled by something other than its own props (a disabled form around it) leaves the page
 * scrolling instead of swallowing the wheel for a step it cannot take.
 */
export function useWheelStep(
  element: HTMLElement | null,
  onStep: (isUp: boolean) => void,
  isEnabled = true,
  canStep?: () => boolean,
): void {
  const latest = React.useRef(onStep);
  latest.current = onStep;
  const latestCanStep = React.useRef(canStep);
  latestCanStep.current = canStep;
  React.useEffect(() => {
    if (!element || !isEnabled) return undefined;
    let travel = 0;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (latestCanStep.current && !latestCanStep.current()) return;
      event.preventDefault();
      if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
        latest.current(event.deltaY < 0);
        return;
      }
      if (Math.sign(travel) !== Math.sign(event.deltaY)) travel = 0;
      travel += event.deltaY;
      if (Math.abs(travel) < WHEEL_STEP_PX) return;
      travel = 0;
      latest.current(event.deltaY < 0);
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [element, isEnabled]);
}
