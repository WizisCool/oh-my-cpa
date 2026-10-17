/**
 * The live usage channel and the read policy that turns its signals into reads.
 *
 * The channel is driven over injected primitives - a fake EventSource, a visibility
 * switch and a manual timer - so reconnects, a stream the server refused, and a tab
 * going to the background are asserted without a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLiveReadPolicy,
  createUsageLiveChannel,
  UNAVAILABLE_RETRY_MS,
  type UsageLiveSignal,
  type UsageLiveState,
} from '../web/src/api/usageLive.ts';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeSource {
  readyState = CONNECTING;
  isClosed = false;
  private handlers = new Map<string, Array<() => void>>();
  addEventListener(name: string, handler: () => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }
  emit(name: string) {
    for (const handler of this.handlers.get(name) ?? []) handler();
  }
  close() {
    this.isClosed = true;
    this.readyState = CLOSED;
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const timers: Array<{ handler: () => void; ms: number; isCleared: boolean }> = [];
  let isVisible = true;
  let visibilityHandler: (() => void) | null = null;
  const channel = createUsageLiveChannel({
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source as unknown as EventSource;
    },
    url: () => '/omc/api/v1/usage/live',
    isVisible: () => isVisible,
    onVisibilityChange: (handler) => {
      visibilityHandler = handler;
      return () => {
        visibilityHandler = null;
      };
    },
    setTimer: (handler, ms) => {
      const timer = { handler, ms, isCleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { isCleared: boolean }).isCleared = true;
    },
  });
  const signals: UsageLiveSignal[] = [];
  const states: UsageLiveState[] = [];
  const listener = { onSignal: (signal: UsageLiveSignal) => signals.push(signal), onState: (state: UsageLiveState) => states.push(state) };
  return {
    channel,
    sources,
    timers,
    signals,
    states,
    listener,
    setVisible(next: boolean) {
      isVisible = next;
      visibilityHandler?.();
    },
  };
}

test('every reader of a tab shares one stream, closed when the last one leaves', () => {
  const h = harness();
  const leaveA = h.channel.subscribe(h.listener);
  const leaveB = h.channel.subscribe({ onSignal: () => {} });
  assert.equal(h.sources.length, 1, 'a second reader must not open a second stream');
  leaveA();
  assert.equal(h.sources[0].isClosed, false, 'the stream stays while a reader remains');
  leaveB();
  assert.equal(h.sources[0].isClosed, true);
});

test('ready makes the channel live and is itself a signal, so a reconnect catches up', () => {
  const h = harness();
  h.channel.subscribe(h.listener);
  h.sources[0].readyState = OPEN;
  h.sources[0].emit('ready');
  h.sources[0].emit('usage');
  assert.equal(h.channel.getState(), 'live');
  assert.deepEqual(h.signals, ['ready', 'usage']);
});

test('a dropped stream the browser is retrying reads as connecting, without a second source', () => {
  const h = harness();
  h.channel.subscribe(h.listener);
  h.sources[0].emit('ready');
  h.sources[0].readyState = CONNECTING;
  h.sources[0].emit('error');
  assert.equal(h.channel.getState(), 'connecting', 'readers fall back to polling while it reconnects');
  assert.equal(h.sources.length, 1);
  assert.equal(h.timers.length, 0, 'the browser owns this retry');
});

test('a refused stream is unavailable and is retried by the channel, since EventSource will not', () => {
  const h = harness();
  h.channel.subscribe(h.listener);
  h.sources[0].readyState = CLOSED;
  h.sources[0].emit('error');
  assert.equal(h.channel.getState(), 'unavailable');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, UNAVAILABLE_RETRY_MS);
  h.timers[0].handler();
  assert.equal(h.sources.length, 2, 'the retry opens a fresh stream');
});

test('a hidden tab closes its stream and reopens it when shown', () => {
  const h = harness();
  h.channel.subscribe(h.listener);
  h.sources[0].emit('ready');
  h.setVisible(false);
  assert.equal(h.sources[0].isClosed, true, 'a hidden reader must not hold a server slot');
  assert.equal(h.channel.getState(), 'connecting');
  h.setVisible(true);
  assert.equal(h.sources.length, 2);
  h.sources[1].emit('ready');
  assert.deepEqual(h.signals, ['ready', 'ready'], 'the return is a signal of its own');
});

test('events from a stream that was replaced are ignored', () => {
  const h = harness();
  h.channel.subscribe(h.listener);
  const stale = h.sources[0];
  h.setVisible(false);
  h.setVisible(true);
  stale.emit('usage');
  assert.deepEqual(h.signals, []);
});

test('a signal during a read is held and costs exactly one follow-up read', () => {
  const policy = createLiveReadPolicy();
  assert.equal(policy.onSignal(false), true, 'an idle reader reads at once');
  assert.equal(policy.onSignal(true), false);
  assert.equal(policy.onSignal(true), false);
  assert.equal(policy.onSignal(true), false);
  assert.equal(policy.onSettled(true), false, 'still busy: hold on');
  assert.equal(policy.onSettled(false), true, 'the held signals become one read');
  assert.equal(policy.onSettled(false), false, 'and only one');
});

test('the fallback tick runs only while no stream is open, someone is looking and nothing is reading', () => {
  const policy = createLiveReadPolicy();
  const base = { isLive: false, isVisible: true, isBusy: false };
  assert.equal(policy.onTick(base), true);
  assert.equal(policy.onTick({ ...base, isLive: true }), false, 'a live stream replaces the poll');
  assert.equal(policy.onTick({ ...base, isVisible: false }), false, 'a hidden tab has no reader');
  assert.equal(policy.onTick({ ...base, isBusy: true }), false, 'a busy read skips the tick rather than queueing it');
});
