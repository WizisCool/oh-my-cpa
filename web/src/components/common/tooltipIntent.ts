/**
 * When a tooltip may open. Shared by the console's `Tooltip` and the request list's delegated
 * popup, so every hint in the console answers the same gestures the same way.
 *
 * A tooltip is an answer to a reader who has stopped on something and wants its name. Ant Design's
 * hover trigger answers any `mouseenter`, and three of those are not a reader stopping: a click,
 * whose pointer then rests on the control it pressed (so the hint rose over the menu the press
 * opened); a layout that moved a control under a still pointer; and a tap, which a touch browser
 * reports as a hover at the finger's last position - where a hint that appears is also a change
 * iOS answers by swallowing the tap, so the control needed a second one.
 */

/** How long a mouse must rest on a control before its hint opens. */
export const HOVER_INTENT_MS = 450;

/**
 * After one hint closes, the next opens at once for this long: a reader moving along a row of tools
 * is reading their names, and waiting again on each would make the row feel unresponsive.
 */
const WARM_WINDOW_MS = 500;

let lastClosedAt = Number.NEGATIVE_INFINITY;

/** The wait before a hint opens, shortened while the reader is already reading hints. */
export function hoverIntentDelay(now = performance.now()): number {
  return now - lastClosedAt < WARM_WINDOW_MS ? 0 : HOVER_INTENT_MS;
}

/** Records that a shown hint closed, which opens the warm window. */
export function noteHintClosed(): void {
  lastClosedAt = performance.now();
}

const CONTROL_SELECTOR = [
  'button', 'a[href]', 'input', 'select', 'textarea', 'summary', 'label',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]', '[role="switch"]',
  '[role="checkbox"]', '[role="option"]', '[contenteditable="true"]',
].join(', ');

/**
 * The element acts when tapped, alone or as part of a control around it. A tap on it means "do it",
 * so its hint never answers a tap; a tap on plain text or a mark is how a touch reader asks for one.
 */
export function isControl(element: Element): boolean {
  return element.closest(CONTROL_SELECTOR) !== null;
}

/**
 * The element has opened a menu or a panel. Its hint stays down while that is open: the reader is
 * looking at what the press produced, and a hint over it would cover the first option.
 */
export function hasOpenPopup(element: Element): boolean {
  return element.matches('[aria-expanded="true"], .ant-dropdown-open, .ant-popover-open')
    || element.querySelector('[aria-expanded="true"]') !== null;
}
