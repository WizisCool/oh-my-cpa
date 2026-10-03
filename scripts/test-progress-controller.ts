import assert from 'node:assert/strict';
import test from 'node:test';
import { createProgressController, type ProgressPresentation } from '../web/src/utils/progressController.ts';
import { PROGRESS_FLOOR } from '../web/src/utils/loadProgress.ts';

function createFixture() {
  let now = 0;
  let isHidden = false;
  let isReducedMotion = false;
  let nextHandle = 0;
  let pending = new Set<string>();
  const listeners = new Set<() => void>();
  const frames = new Map<number, (now: number) => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const readings: ProgressPresentation[] = [];
  const controller = createProgressController({
    read: () => pending,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, {
    now: () => now,
    isHidden: () => isHidden,
    isReducedMotion: () => isReducedMotion,
    completionDuration: 100,
    render: (reading) => readings.push(reading),
    requestFrame(callback) { nextHandle += 1; frames.set(nextHandle, callback); return nextHandle; },
    cancelFrame: (handle) => { frames.delete(handle); },
    setTimer(callback, delay) { nextHandle += 1; timers.set(nextHandle, { at: now + delay, callback }); return nextHandle; },
    clearTimer: (handle) => { timers.delete(handle); },
  });
  return {
    controller, frames, timers, listeners, readings,
    get current() { return readings.at(-1)!; },
    notify(tasks: string[], time = now) { now = time; pending = new Set(tasks); for (const listener of listeners) listener(); },
    frame(time: number) {
      now = time;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(now);
    },
    runTimers(time: number) {
      now = time;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(handle); timer.callback(); }
      }
    },
    setHidden(isNextHidden: boolean, time = now) { now = time; isHidden = isNextHidden; controller.refresh(); },
    setReducedMotion(isNextReducedMotion: boolean, time = now) { now = time; isReducedMotion = isNextReducedMotion; controller.refresh(); },
  };
}

test('a fast batch is invisible and cancels its show timer', () => {
  const fixture = createFixture();
  fixture.notify(['read']);
  fixture.notify([], 199);
  fixture.runTimers(200);
  assert.equal(fixture.current.state, 'hidden');
  assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.timers.size, 0);
});

test('frequent source notifications cannot reset the drawing clock', () => {
  const busy = createFixture();
  const quiet = createFixture();
  for (const fixture of [busy, quiet]) { fixture.notify(['read']); fixture.runTimers(200); }
  for (const time of [204, 208, 212, 215]) busy.notify(['read'], time);
  busy.frame(216);
  quiet.frame(216);
  assert.ok(busy.current.value > PROGRESS_FLOOR);
  assert.equal(busy.current.value, quiet.current.value);
  assert.equal(busy.frames.size, 1);
});

test('late work holds rough progress without ending the running activity state', () => {
  const fixture = createFixture();
  fixture.notify(['slow']); fixture.runTimers(200); fixture.frame(2000);
  const before = fixture.current.value;
  fixture.notify(['slow', 'late'], 2000); fixture.frame(2016);
  assert.equal(fixture.current.value, before);
  assert.equal(fixture.current.state, 'running');
  fixture.frame(10000);
  assert.ok(fixture.current.value >= before && fixture.current.value < 1);
});

test('completion uses one injected base beat then waits for the fade, not more query notifications', () => {
  const fixture = createFixture();
  fixture.notify(['read']); fixture.runTimers(200); fixture.frame(216);
  fixture.notify([], 220);
  assert.equal(fixture.current.state, 'finishing');
  fixture.notify([], 250); fixture.frame(270);
  assert.equal(fixture.current.state, 'finishing');
  assert.ok(fixture.current.value < 1);
  fixture.frame(320);
  assert.equal(fixture.current.value, 1);
  assert.equal(fixture.current.state, 'done');
  assert.equal(fixture.frames.size, 0);
  fixture.controller.finishFade();
  assert.equal(fixture.current.state, 'hidden');
});

test('new work during finishing or fading opens a fresh episode and ignores the old fade end', () => {
  for (const shouldFinish of [false, true]) {
    const fixture = createFixture();
    fixture.notify(['old']); fixture.runTimers(200); fixture.notify([], 220);
    if (shouldFinish) fixture.frame(320);
    fixture.notify(['new'], 330);
    assert.equal(fixture.current.state, 'hidden');
    fixture.controller.finishFade();
    assert.equal(fixture.current.state, 'hidden');
    fixture.runTimers(530);
    assert.equal(fixture.current.state, 'running');
    assert.equal(fixture.current.value, PROGRESS_FLOOR);
    fixture.frame(546);
    assert.ok(fixture.current.value < 1);
  }
});

test('live reduced motion preserves the batch, stops frames and updates only on task events', () => {
  const fixture = createFixture();
  fixture.notify(['slow', 'other']); fixture.runTimers(200); fixture.frame(2000);
  const before = fixture.current.value;
  fixture.setReducedMotion(true, 2001);
  assert.equal(fixture.current.value, before);
  assert.equal(fixture.frames.size, 0);
  fixture.notify(['slow'], 2100);
  assert.ok(fixture.current.value >= 0.5);
  fixture.setReducedMotion(false, 2200);
  assert.equal(fixture.current.state, 'running');
  assert.equal(fixture.frames.size, 1);
  fixture.notify([], 2250); fixture.setReducedMotion(true, 2251);
  assert.equal(fixture.current.state, 'hidden');
  assert.equal(fixture.frames.size, 0);
});

test('reduced motion during a fade hides without waiting for a CSS transition event', () => {
  const fixture = createFixture();
  fixture.notify(['read']); fixture.runTimers(200); fixture.notify([], 210); fixture.frame(310);
  fixture.setReducedMotion(true);
  assert.equal(fixture.current.state, 'hidden');
});

test('hidden documents stop timers and frames, retain pending work and never replay completed work', () => {
  const fixture = createFixture();
  fixture.notify(['read']); fixture.setHidden(true, 100);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.frames.size, 0);
  fixture.setHidden(false, 500);
  assert.equal(fixture.current.state, 'running');
  fixture.frame(516);
  const before = fixture.current.value;
  fixture.setHidden(true, 520);
  assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.current.isSuspended, true);
  fixture.setHidden(false, 700);
  assert.ok(fixture.current.value >= before);
  fixture.setHidden(true, 710); fixture.notify([], 720); fixture.setHidden(false, 1000);
  assert.equal(fixture.current.state, 'hidden');
  assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.timers.size, 0);
});

test('hiding during completion or fading retires the completed episode', () => {
  for (const shouldFinish of [false, true]) {
    const fixture = createFixture();
    fixture.notify(['read']); fixture.runTimers(200); fixture.notify([], 210);
    if (shouldFinish) fixture.frame(310);
    fixture.setHidden(true, 320); fixture.setHidden(false, 400);
    assert.equal(fixture.current.state, 'hidden');
    assert.equal(fixture.frames.size, 0);
  }
});

test('disposing releases subscriptions and scheduled work for StrictMode remounts', () => {
  for (const shouldPaint of [false, true]) {
    const fixture = createFixture();
    fixture.notify(['read']);
    if (shouldPaint) fixture.runTimers(200);
    fixture.controller.dispose();
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.frames.size, 0);
    assert.equal(fixture.timers.size, 0);
    const count = fixture.readings.length;
    fixture.notify([], 500);
    assert.equal(fixture.readings.length, count);
  }
});


test('a fast new episode during a fade never paints or inherits completion', () => {
  const fixture = createFixture();
  fixture.notify(['old']); fixture.runTimers(200); fixture.notify([], 220); fixture.frame(320);
  fixture.notify(['quick'], 330); fixture.notify([], 400); fixture.runTimers(530);
  assert.equal(fixture.current.state, 'hidden');
  assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.timers.size, 0);
});

test('an initially reduced-motion batch has no time-based progress or scheduled frames', () => {
  const fixture = createFixture();
  fixture.setReducedMotion(true);
  fixture.notify(['read']); fixture.runTimers(200);
  assert.equal(fixture.current.value, PROGRESS_FLOOR);
  fixture.frame(10000);
  assert.equal(fixture.current.value, PROGRESS_FLOOR);
  assert.equal(fixture.frames.size, 0);
  fixture.notify([], 10010);
  assert.equal(fixture.current.state, 'hidden');
});
