/**
 * Logic-level tests for the request list under a finger: the speed a release coasts at, how far a
 * coast carries the list and when it ends, and what a drag is for. The integration half - that the
 * list follows a real finger, coasts, stops on a tap and folds its header - is the
 * `request-list-touch` probe.
 */
import assert from 'node:assert/strict';
import {
  coastDistance,
  COAST_STOP_VELOCITY,
  COAST_TIME_CONSTANT_MS,
  dragIntent,
  isCoasting,
  MAX_COAST_VELOCITY,
  RELEASE_WINDOW_MS,
  releaseVelocity,
  type TouchSample,
} from '../web/src/components/usage/requestListTouch.ts';

/** A finger moving up at `speed` px/ms, reported once per 60Hz frame, from `startAt`. */
function flick(speed: number, frames: number, startAt = 0, startY = 600): TouchSample[] {
  return Array.from({ length: frames + 1 }, (_, frame) => {
    const time = startAt + (frame * 1000) / 60;
    return { time, y: startY - speed * (time - startAt) };
  });
}

// ---- release speed ----

{
  const samples = flick(1.5, 12);
  const releasedAt = samples[samples.length - 1].time;
  assert.ok(Math.abs(releaseVelocity(samples, releasedAt) - 1.5) < 0.01, 'a steady flick coasts at the speed the finger left with');
}
{
  const samples = flick(1.5, 12).map((sample) => ({ ...sample, y: 1200 - sample.y }));
  const releasedAt = samples[samples.length - 1].time;
  assert.ok(releaseVelocity(samples, releasedAt) < -1.4, 'a flick down coasts back up the list');
}
{
  const samples = flick(1.5, 12);
  const releasedAt = samples[samples.length - 1].time + RELEASE_WINDOW_MS + 1;
  assert.equal(releaseVelocity(samples, releasedAt), 0, 'a finger that rested before lifting does not coast');
}
{
  // Slowing to a stop before lifting leaves only a crawl, which is not a flick.
  const samples = flick(0.05, 12);
  const releasedAt = samples[samples.length - 1].time;
  assert.equal(releaseVelocity(samples, releasedAt), 0, 'a crawl does not coast');
}
{
  const samples = flick(40, 3);
  const releasedAt = samples[samples.length - 1].time;
  assert.equal(releaseVelocity(samples, releasedAt), MAX_COAST_VELOCITY, 'one stray report cannot fling the list arbitrarily far');
}
{
  // A busy page delivered the moves 60ms apart; the last one is the only report inside the window,
  // and the speed is still measured, from the report before it.
  const samples: TouchSample[] = [{ time: 0, y: 600 }, { time: 60, y: 540 }, { time: 120, y: 480 }];
  const velocity = releaseVelocity(samples, 130);
  assert.ok(velocity > 0.8 && velocity < 1, `sparse reports still measure a flick (${velocity})`);
}
assert.equal(releaseVelocity([{ time: 0, y: 600 }], 10), 0, 'a touch that never moved does not coast');

// ---- the coast ----

assert.equal(coastDistance(2, 0), 0, 'a coast starts where the finger left the list');
assert.equal(coastDistance(2, -5), 0, 'a frame stamped before the release does not move the list backwards');
{
  let previous = 0;
  for (let elapsed = 16; elapsed <= 4000; elapsed += 16) {
    const distance = coastDistance(2, elapsed);
    assert.ok(distance > previous, 'a coast only ever moves on, never back');
    assert.ok(distance < 2 * COAST_TIME_CONSTANT_MS, 'a coast never passes the distance its speed allows');
    previous = distance;
  }
}
// The first frame moves as far as the finger was moving: a coast that started slower would read as
// the list catching on something at the moment of release.
assert.ok(Math.abs(coastDistance(2, 16) - 2 * 16) < 1, 'the first frame of a coast moves at the release speed');
assert.ok(isCoasting(2, 0), 'a flick coasts');
assert.ok(!isCoasting(COAST_STOP_VELOCITY / 2, 0), 'a coast slower than its stop speed does not run at all');
{
  // Ends in a few seconds for a fast flick, as a native coast does.
  let elapsed = 0;
  while (isCoasting(MAX_COAST_VELOCITY, elapsed)) elapsed += 16;
  assert.ok(elapsed > 1500 && elapsed < 5000, `a fast flick coasts for a few seconds (${elapsed}ms)`);
}

// ---- what a drag is for ----

const list = { hasList: true };
assert.equal(dragIntent({ travelY: -5, isCollapsed: false, isOverList: true, ...list }), 'fold', 'a drag up on an unfolded header folds it, over the list');
assert.equal(dragIntent({ travelY: -5, isCollapsed: false, isOverList: false, ...list }), 'fold', 'a drag up on an unfolded header folds it, over the filters');
assert.equal(dragIntent({ travelY: -5, isCollapsed: true, isOverList: true, ...list }), 'drive', 'with the header folded a drag up moves the list');
assert.equal(dragIntent({ travelY: 5, isCollapsed: false, isOverList: true, ...list }), 'drive', 'a drag down moves the list');
assert.equal(dragIntent({ travelY: 5, isCollapsed: true, isOverList: false, ...list }), 'native', 'a drag outside the list is left to the browser');
// Loading or empty: a folded header there would have no list to pull it back with.
const noList = { isOverList: false, hasList: false };
assert.equal(dragIntent({ travelY: -5, isCollapsed: false, ...noList }), 'native', 'without a list a drag up does not fold the header');
assert.equal(dragIntent({ travelY: 5, isCollapsed: true, ...noList }), 'pull', 'without a list a folded header unfolds on a pull anywhere');
assert.equal(dragIntent({ travelY: -5, isCollapsed: true, ...noList }), 'native', 'without a list a drag up on a folded header is left to the browser');

console.log('request list touch: ok');
