/**
 * Logic-level tests for the request list's smooth-scroll schedule.
 *
 * The schedule is the part that can be asserted deterministically: which intent
 * resolves to which duration, that reduced motion wins over the intent, and that
 * the easing actually lands exactly on the top instead of near it. The
 * integration half — that the gesture moves the real list and the corrections do
 * not animate — is covered by the browser acceptance suite.
 */
import assert from 'node:assert/strict';
import {
  animateScrollToTop,
  easeOutCubic,
  prefersReducedMotion,
  scrollDurationFor,
  scrollTopAt,
  SCROLL_ANIMATION_MS,
} from '../web/src/utils/smoothScroll.ts';

// Node has no `window`, so this is the "no platform opinion" state: motion is
// allowed, so a gesture animates and a correction does not.
assert.equal(typeof globalThis.window, 'undefined', 'this test relies on running without a DOM');
assert.equal(prefersReducedMotion(), false, 'no platform opinion means motion is allowed');
assert.ok(scrollDurationFor('smooth') > 0, 'a gesture animates');
assert.equal(scrollDurationFor('instant'), 0, 'a correction never animates');

// ---- the schedule lands exactly on the top ----

// The whole point of a return-to-top is that it arrives. Every value is a
// position, so an approximation would leave the reader short of row one.
assert.equal(scrollTopAt(1376, 0), 1376, 'the first frame starts where the reader was');
assert.equal(scrollTopAt(1376, SCROLL_ANIMATION_MS), 0, 'the last frame is exactly the top');
assert.equal(scrollTopAt(1376, SCROLL_ANIMATION_MS * 2), 0, 'past the end it stays at the top');
assert.equal(scrollTopAt(1376, SCROLL_ANIMATION_MS, SCROLL_ANIMATION_MS), 0, 'a zero-length gesture jumps');

// Monotone decreasing, never negative, never overshooting past the top: an
// interpolation that overshot would scroll above the list and bounce back.
let previous = Number.POSITIVE_INFINITY;
for (let elapsed = 0; elapsed <= SCROLL_ANIMATION_MS; elapsed += 8) {
  const top = scrollTopAt(1376, elapsed);
  assert.ok(top <= previous, `the schedule must not go back up at ${elapsed}ms`);
  assert.ok(top >= 0, `the schedule must not go negative at ${elapsed}ms`);
  assert.ok(top <= 1376, `the schedule must not overshoot the start at ${elapsed}ms`);
  previous = top;
}
assert.equal(previous, 0, 'the schedule ends at the top');

// It decelerates: the first eighth of the duration covers more ground than the
// last eighth, which is what makes the arrival read as settling rather than
// stopping dead.
const early = 1376 - scrollTopAt(1376, SCROLL_ANIMATION_MS / 8);
const late = scrollTopAt(1376, (SCROLL_ANIMATION_MS * 7) / 8) - scrollTopAt(1376, SCROLL_ANIMATION_MS);
assert.ok(early > late * 2, `early=${early} late=${late}`);

// Starting at the top is a no-op rather than a scroll.
assert.equal(scrollTopAt(0, SCROLL_ANIMATION_MS / 2), 0);

// ---- the easing ----

assert.equal(easeOutCubic(0), 0);
assert.equal(easeOutCubic(1), 1);
// Clamped, because the value doubles as the interpolation weight.
assert.equal(easeOutCubic(-5), 0);
assert.equal(easeOutCubic(5), 1);
assert.ok(easeOutCubic(0.5) > 0.5, 'the curve is ahead of linear, so it decelerates');

// ---- the animation loop ----

// No DOM here, so the frame clock is supplied by the test. That also pins the
// "final write" rule: the loop must land on exactly 0 even if the last frame it
// observes is still short of the end.
const originalRaf = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;
const originalNow = performance.now;

let frames: Array<() => void> = [];
globalThis.requestAnimationFrame = ((callback: () => void) => {
  frames.push(callback);
  return frames.length;
}) as typeof globalThis.requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => undefined) as typeof globalThis.cancelAnimationFrame;

let clock = 0;
performance.now = () => clock;

const positions: number[] = [];
const handle = animateScrollToTop(1376, (top) => positions.push(top));
assert.ok(positions.length === 0, 'the first frame is scheduled, not applied synchronously');

// Run the frames, advancing the clock by a full duration on the second one so the
// loop sees an elapsed time past the end.
const pending = [...frames];
frames = [];
pending[0]();
clock = SCROLL_ANIMATION_MS / 2;
const midFrame = frames.shift();
assert.ok(midFrame, 'the loop schedules the next frame');
midFrame();
clock = SCROLL_ANIMATION_MS;
const lastFrame = frames.shift();
assert.ok(lastFrame, 'the loop keeps scheduling until the duration elapses');
lastFrame();

assert.ok(positions.length >= 3, `expected several frames, got ${positions.length}`);
assert.equal(positions.at(-1), 0, 'the animation writes the top explicitly at the end');
assert.ok(
  positions.every((top) => top >= 0 && top <= 1376),
  `positions stayed in range: ${positions.join(',')}`,
);

// Cancelling stops it: a correction that follows must not be dragged back.
frames = [];
const cancelledPositions: number[] = [];
const cancelled = animateScrollToTop(1376, (top) => cancelledPositions.push(top));
cancelled.cancel();
const afterCancel = [...frames];
frames = [];
for (const frame of afterCancel) frame();
assert.equal(cancelledPositions.length, 0, 'a cancelled animation applies nothing further');

// A gesture that begins at the top resolves immediately rather than scheduling a
// frame it does not need.
let completedImmediate = false;
const immediate: number[] = [];
handle.cancel();
frames = [];
animateScrollToTop(0, (top) => immediate.push(top), { onComplete: () => { completedImmediate = true; } });
assert.deepEqual(immediate, [0], 'starting at the top applies the top once');
assert.equal(frames.length, 0, 'starting at the top schedules no animation');
assert.equal(completedImmediate, true, 'starting at the top invokes onComplete');

performance.now = originalNow;
globalThis.requestAnimationFrame = originalRaf;
globalThis.cancelAnimationFrame = originalCancel;

// ---- reduced motion ----

// With the platform asking for less motion, a gesture becomes a correction.
// Resolving it in the schedule rather than at the call site is what keeps one
// caller from forgetting - docs/design.md §7 requires every animated transition
// to disappear under this preference.
const originalWindow = globalThis.window;
globalThis.window = {
  matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }),
} as unknown as Window & typeof globalThis;
assert.equal(prefersReducedMotion(), true);
assert.equal(scrollDurationFor('smooth'), 0, 'reduced motion collapses a gesture to a correction');
assert.equal(scrollDurationFor('instant'), 0);
assert.equal(scrollTopAt(1376, SCROLL_ANIMATION_MS / 2, scrollDurationFor('smooth')), 0);

// A platform whose matchMedia disagrees, or is absent, must not throw: the
// fallback is to animate, which is the default behaviour.
globalThis.window = { matchMedia: () => ({ matches: false }) } as unknown as Window & typeof globalThis;
assert.equal(prefersReducedMotion(), false);
assert.ok(scrollDurationFor('smooth') > 0);

globalThis.window = {} as unknown as Window & typeof globalThis;
assert.equal(prefersReducedMotion(), false, 'a platform without matchMedia still animates');
assert.ok(scrollDurationFor('smooth') > 0);

globalThis.window = originalWindow;

console.log(
  'PASS scroll schedule: gestures animate and land exactly on the top, corrections stay instant, reduced motion wins',
);
