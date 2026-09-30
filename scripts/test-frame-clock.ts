import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrameClock } from '../web/src/types/frameClock.ts';
import { elapsedLabel } from '../web/src/types/liveElapsed.ts';

test('live labels use 10ms and 100ms quanta across minute boundaries', () => {
  for (const [milliseconds, label] of [[0, '0ms'], [19, '10ms'], [999, '990ms'], [1000, '1.0s'], [1199, '1.1s'], [31167, '31.1s'], [60199, '60.1s']] as const) assert.equal(elapsedLabel(milliseconds), label);
});

test('all live labels share one animation frame, freeze when hidden and stop when unsubscribed', () => {
  const originalNow = Date.now;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let now = 1034;
  let sequence = 0;
  let updates = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const visibilityListeners = new Set<() => void>();
  const doc = { visibilityState: 'visible', addEventListener: (_: string, callback: () => void) => visibilityListeners.add(callback), removeEventListener: (_: string, callback: () => void) => visibilityListeners.delete(callback) };
  const host = { requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: (id: number) => frames.delete(id) };
  try {
    Date.now = () => now;
    globalThis.window = host as unknown as Window & typeof globalThis;
    globalThis.document = doc as unknown as Document;
    const clock = createFrameClock();
    const unsubscribe = clock.subscribe(() => { updates += 1; });
    const second = clock.subscribe(() => {});
    assert.equal(clock.getSnapshot(), 1030);
    assert.equal(frames.size, 1);
    const nextFrame = () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(0); };
    now = 1039; nextFrame(); assert.equal(updates, 1, 'unchanged 10ms bucket is not published');
    now = 1041; nextFrame(); assert.equal(updates, 2);
    doc.visibilityState = 'hidden'; visibilityListeners.forEach(callback => callback());
    assert.equal(frames.size, 0);
    now = 9917; doc.visibilityState = 'visible'; visibilityListeners.forEach(callback => callback());
    assert.equal(clock.getSnapshot(), 9910);
    assert.equal(frames.size, 1);
    unsubscribe(); assert.equal(frames.size, 1);
    second(); assert.equal(frames.size, 0); assert.equal(visibilityListeners.size, 0);
    const remount = clock.subscribe(() => {}); assert.equal(frames.size, 1); remount(); assert.equal(frames.size, 0);
  } finally {
    Date.now = originalNow;
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window'); else globalThis.window = originalWindow;
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document'); else globalThis.document = originalDocument;
  }
});
