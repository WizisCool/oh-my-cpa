/**
 * Logic-level tests for the console-wide wheel and keyboard glide.
 *
 * What is decided without a DOM is asserted here: which wheel events count as a notch, how far a
 * notch or a key moves, that a glide lands exactly on its destination, and how the preference and
 * the reduced-motion signal combine. That the glide reaches a real scroller, a virtualized list
 * included, is the `scroll-smoothing` browser probe's claim.
 */
import assert from 'node:assert/strict';
import { MOTION_SCROLL } from '../web/src/theme/themeConfig.ts';
import {
  DEFAULT_SCROLL_SMOOTHING,
  glidePosition,
  isDiscreteWheel,
  isScrollSmoothingActive,
  keyScrollFor,
  pageDistance,
  parseScrollSmoothing,
  wheelDistance,
  type WheelSample,
} from '../web/src/utils/scrollSmoothing.ts';

const notch = (overrides: Partial<WheelSample> = {}): WheelSample => ({
  deltaMode: 0,
  deltaX: 0,
  deltaY: 100,
  wheelDeltaY: -120,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});
const windows = { isApple: false };
const mac = { isApple: true };

// ---- a notch is told apart from a stream ----

assert.equal(isDiscreteWheel(notch(), windows), true, 'a Windows notch steps, so it glides');
assert.equal(isDiscreteWheel(notch({ deltaY: 125, wheelDeltaY: -120 }), windows), true, 'display scaling keeps the notch signature');
assert.equal(isDiscreteWheel(notch({ deltaY: -200, wheelDeltaY: 240 }), windows), true, 'a coalesced double notch is still a notch');
assert.equal(isDiscreteWheel(notch({ deltaY: 4.5, wheelDeltaY: -5 }), windows), false, 'a precision touchpad already glides');
assert.equal(isDiscreteWheel(notch({ deltaMode: 1, deltaY: 3, wheelDeltaY: undefined }), windows), true, 'line mode is always a notch');
assert.equal(isDiscreteWheel(notch({ deltaMode: 1, deltaY: 3, wheelDeltaY: undefined }), mac), true, 'line mode is a notch on Apple platforms too');
assert.equal(isDiscreteWheel(notch(), mac), false, 'macOS already smooths pixel-mode wheels');
assert.equal(isDiscreteWheel(notch({ wheelDeltaY: undefined, deltaY: 102 }), windows), true, 'without the legacy field a whole large step is a notch');
assert.equal(isDiscreteWheel(notch({ wheelDeltaY: undefined, deltaY: 7.25 }), windows), false, 'without the legacy field a fractional step is a stream');

// Modified and horizontal wheels keep their native meaning.
assert.equal(isDiscreteWheel(notch({ ctrlKey: true }), windows), false, 'Ctrl+wheel zooms');
assert.equal(isDiscreteWheel(notch({ metaKey: true }), windows), false, 'Meta+wheel is the platform\'s');
assert.equal(isDiscreteWheel(notch({ shiftKey: true }), windows), false, 'Shift+wheel scrolls sideways');
assert.equal(isDiscreteWheel(notch({ altKey: true }), windows), false, 'Alt+wheel is the platform\'s');
assert.equal(isDiscreteWheel(notch({ deltaX: 30 }), windows), false, 'a horizontal component is left native');
assert.equal(isDiscreteWheel(notch({ deltaY: 0 }), windows), false, 'a horizontal-only event is left native');

// ---- distances ----

assert.equal(wheelDistance({ deltaMode: 0, deltaY: -100 }, 800), -100, 'pixel mode glides by exactly what it would have jumped');
assert.equal(wheelDistance({ deltaMode: 1, deltaY: 3 }, 800), 120, 'line mode is three 40px lines');
assert.equal(wheelDistance({ deltaMode: 2, deltaY: 1 }, 800), 760, 'page mode is one Page Down');
assert.equal(pageDistance(800), 760, 'a tall viewport keeps a 40px overlap');
assert.equal(pageDistance(200), 175, 'a short viewport keeps an eighth');

assert.deepEqual(keyScrollFor('ArrowDown', false, 800), { by: 40 });
assert.deepEqual(keyScrollFor('ArrowUp', false, 800), { by: -40 });
assert.deepEqual(keyScrollFor('PageDown', false, 800), { by: 760 });
assert.deepEqual(keyScrollFor('PageUp', false, 800), { by: -760 });
assert.deepEqual(keyScrollFor(' ', false, 800), { by: 760 }, 'Space pages down');
assert.deepEqual(keyScrollFor(' ', true, 800), { by: -760 }, 'Shift+Space pages up');
assert.deepEqual(keyScrollFor('Home', false, 800), { to: 'start' });
assert.deepEqual(keyScrollFor('End', false, 800), { to: 'end' });
assert.equal(keyScrollFor('ArrowDown', true, 800), null, 'Shift+Arrow extends a selection');
assert.equal(keyScrollFor('End', true, 800), null, 'Shift+End extends a selection');
assert.equal(keyScrollFor('Enter', false, 800), null, 'other keys do not scroll');

// ---- the glide lands exactly ----

const duration = MOTION_SCROLL.duration;
assert.ok(duration > 0 && duration <= 200, 'the scroll token stays short enough not to trail the hand');
assert.equal(glidePosition(300, 400, 0, duration), 300, 'the first frame starts where the scroller was');
assert.equal(glidePosition(300, 400, duration, duration), 400, 'the last frame is exactly the destination');
assert.equal(glidePosition(300, 400, duration * 3, duration), 400, 'a late frame does not overshoot');
assert.equal(glidePosition(300, 400, 10, 0), 400, 'a zero duration jumps');
let previous = 300;
for (let elapsed = 0; elapsed <= duration; elapsed += 4) {
  const position = glidePosition(300, 400, elapsed, duration);
  assert.ok(position >= previous && position <= 400, `monotone and inside the range at ${elapsed}ms`);
  previous = position;
}
// The curve decelerates from a moving start: half the distance is covered well before half the
// time, which is what keeps a turning wheel from stalling at every notch.
assert.ok(glidePosition(0, 100, duration * 0.25, duration) > 50, 'a glide starts moving at once');
assert.ok(glidePosition(400, 300, duration / 2, duration) < 350, 'an upward glide uses the same curve');

// ---- preference and reduced motion ----

assert.equal(DEFAULT_SCROLL_SMOOTHING, 'on');
assert.equal(isScrollSmoothingActive('on', false), true);
assert.equal(isScrollSmoothingActive('on', true), true, '`on` glides even when the system reports reduced motion');
assert.equal(isScrollSmoothingActive('system', false), true);
assert.equal(isScrollSmoothingActive('system', true), false, '`system` defers to reduced motion');
assert.equal(isScrollSmoothingActive('off', false), false);
assert.equal(parseScrollSmoothing('system'), 'system');
assert.equal(parseScrollSmoothing('smooth'), undefined, 'an unknown word falls back to the default');
assert.equal(parseScrollSmoothing(true), undefined);

console.log('scroll smoothing tests passed');
