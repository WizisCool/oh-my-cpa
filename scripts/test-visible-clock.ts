import assert from 'node:assert/strict';
import test from 'node:test';
import { createVisibleClock } from '../web/src/types/visibleClock.ts';

test('visible clock shares one timer, suspends in background, resumes fresh and cleans up', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNow = Date.now;
  let now = 1000;
  let nextId = 0;
  const timers = new Map<number, () => void>();
  const visibilityListeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_: string, fn: () => void) => visibilityListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => visibilityListeners.delete(fn),
  };
  Object.assign(globalThis, {
    window: {
      setInterval: (fn: () => void, ms: number) => { assert.equal(ms, 15000); const id = ++nextId; timers.set(id, fn); return id; },
      clearInterval: (id: number) => timers.delete(id),
    },
    document: doc,
  });
  Date.now = () => now;
  try {
    const clock = createVisibleClock();
    let notifications = 0;
    const unsubscribers = Array.from({ length: 100 }, () => clock.subscribe(() => { notifications++; }));
    assert.equal(timers.size, 1, '100 subscribers share a single timer');
    assert.equal(visibilityListeners.size, 1);
    now += 15000;
    timers.values().next().value!();
    assert.equal(clock.getSnapshot(), now);
    assert.equal(notifications, 101, 'one initial notification and one per subscriber');
    doc.visibilityState = 'hidden';
    visibilityListeners.forEach(fn => fn());
    assert.equal(timers.size, 0);
    const hiddenSnapshot = clock.getSnapshot();
    now += 60000;
    assert.equal(clock.getSnapshot(), hiddenSnapshot, 'no background updates');
    doc.visibilityState = 'visible';
    visibilityListeners.forEach(fn => fn());
    assert.equal(clock.getSnapshot(), now, 'resume updates immediately');
    assert.equal(timers.size, 1);
    visibilityListeners.forEach(fn => fn());
    assert.equal(timers.size, 1, 'repeated visibility events do not accumulate timers');
    unsubscribers.forEach(unsubscribe => unsubscribe());
    assert.equal(timers.size, 0);
    assert.equal(visibilityListeners.size, 0);
    doc.visibilityState = 'hidden';
    const unsubscribe = clock.subscribe(() => {});
    assert.equal(timers.size, 0, 'mounting in a hidden tab starts no timer');
    unsubscribe();
    doc.visibilityState = 'visible';
    const remount = clock.subscribe(() => {});
    assert.equal(timers.size, 1, 'StrictMode remount restarts exactly one timer');
    remount();
    assert.equal(timers.size, 0);
  } finally {
    Date.now = originalNow;
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window'); else globalThis.window = originalWindow;
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document'); else globalThis.document = originalDocument;
  }
});
