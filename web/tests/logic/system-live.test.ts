// @vitest-environment node
/**
 * The update channel's wiring: the address the shell opens, the event that means "re-read", and
 * the catch-up signal on reconnect. The reconnect and visibility mechanics are shared with the
 * usage channel and covered by `usage-live.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createUpdateLiveChannel, systemLiveURL } from '../../src/api/systemLive.ts';

const CONNECTING = 0;

class FakeSource {
  readyState = CONNECTING;
  private handlers = new Map<string, Array<() => void>>();
  addEventListener(name: string, handler: () => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }
  emit(name: string) {
    for (const handler of this.handlers.get(name) ?? []) handler();
  }
  close() {}
}

test('the update stream is the console API address for the system live route', () => {
  // The production address, not an injected one: a missing prefix or a typo would otherwise pass
  // every test in this suite.
  assert.equal(systemLiveURL(), '/api/v1/management/system/live');
});

test('ready and updates are both signals, so a reconnect catches up', () => {
  const sources: FakeSource[] = [];
  const channel = createUpdateLiveChannel({
    createSource: (url) => {
      assert.equal(url, '/omc/api/v1/management/system/live');
      const source = new FakeSource();
      sources.push(source);
      return source as unknown as EventSource;
    },
    url: () => '/omc/api/v1/management/system/live',
    isVisible: () => true,
    onVisibilityChange: () => () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const signals: string[] = [];
  channel.subscribe({ onSignal: (signal) => signals.push(signal) });
  sources[0].emit('ready');
  sources[0].emit('updates');
  assert.deepEqual(signals, ['ready', 'updates']);
});
