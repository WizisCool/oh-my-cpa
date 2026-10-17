import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { WINDOW_MS, attemptsBetween, routingAt, signalInstantsBetween } from './liveRouting.mjs';
import { DATASET } from './routes.mjs';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const finished = (record) => record.timestamp_ms + record.latency_ms;

describe('the simulated live traffic', () => {
  it('is the same traffic for every reader of the same instant', () => {
    assert.deepEqual(routingAt(NOW, undefined, DATASET), routingAt(NOW, undefined, DATASET));
  });

  it('answers a minute that ends now and holds nothing still in flight', () => {
    const read = routingAt(NOW, undefined, DATASET);
    assert.equal(read.as_of_ms, NOW);
    assert.equal(read.window_ms, WINDOW_MS);
    assert.ok(read.records.length > 20, `a quiet minute: ${read.records.length} attempts`);
    for (const record of read.records) {
      assert.ok(finished(record) <= NOW && finished(record) >= NOW - WINDOW_MS, `${record.id} is outside the minute`);
    }
  });

  it('numbers attempts in the order they finish, so the console\'s cursor sees each once', () => {
    const records = attemptsBetween(NOW - 10 * WINDOW_MS, NOW, DATASET);
    const ids = records.map((record) => record.id);
    assert.equal(new Set(ids).size, ids.length, 'two attempts share an id');
    const byFinish = [...records].sort((left, right) => finished(left) - finished(right) || left.id - right.id);
    for (let index = 1; index < byFinish.length; index++) {
      assert.ok(byFinish[index].id > byFinish[index - 1].id, `${byFinish[index].id} finished later but sorts earlier`);
    }
  });

  it('returns after a cursor exactly what landed since the read that set it', () => {
    const first = routingAt(NOW, undefined, DATASET);
    const later = routingAt(NOW + 5_000, first.records[0].id, DATASET);
    const whole = routingAt(NOW + 5_000, undefined, DATASET);
    const expected = whole.records.filter((record) => finished(record) > NOW).map((record) => record.id);
    assert.deepEqual(later.records.map((record) => record.id), expected);
    assert.ok(expected.length > 0, 'five seconds passed without a request');
  });

  it('calls three models through five credentials, with a reroute and a rest within the hour', () => {
    const hour = attemptsBetween(NOW - 3_600_000, NOW, DATASET);
    assert.deepEqual(
      [...new Set(hour.map((record) => record.model))].sort(),
      ['claude-opus-5.5', 'deepseek-v4.1-flash', 'gpt-6-astra'],
    );
    assert.deepEqual(
      [...new Set(hour.map((record) => record.auth_index))].sort(),
      ['auth-claude-01', 'auth-codex-01', 'auth-codex-02', 'auth-ds-01', 'auth-ds-02'],
    );
    const attemptsPerRequest = new Map();
    for (const record of hour) attemptsPerRequest.set(record.request_id, (attemptsPerRequest.get(record.request_id) ?? 0) + 1);
    assert.ok([...attemptsPerRequest.values()].some((count) => count > 1), 'no request was moved to another credential');
    const rests = [];
    for (let at = NOW - 3_600_000; at <= NOW; at += 10_000) rests.push(...routingAt(at, undefined, DATASET).cooldowns);
    assert.ok(rests.length > 0, 'no credential rested');
  });

  it('never starts a request on a credential while it rests', () => {
    for (let at = NOW; at < NOW + 1_800_000; at += 15_000) {
      const { cooldowns, records } = routingAt(at, undefined, DATASET);
      for (const rest of cooldowns) {
        const sent = records.filter((record) => record.auth_index === rest.auth_index
          && record.timestamp_ms >= rest.until_at_ms - 28_000 && record.timestamp_ms < rest.until_at_ms
          && !(record.failed && record.fail_status_code === 429));
        assert.deepEqual(sent.map((record) => record.request_id), [], `${rest.auth_index} served while resting`);
      }
    }
  });

  it('keeps concurrency small', () => {
    const records = attemptsBetween(NOW - 600_000, NOW, DATASET);
    let peak = 0;
    for (let at = NOW - 590_000; at < NOW; at += 100) {
      peak = Math.max(peak, records.filter((record) => record.timestamp_ms <= at && finished(record) > at).length);
    }
    assert.ok(peak >= 2 && peak <= 10, `peak concurrency ${peak}`);
  });

  it('signals every recorded attempt, merging a burst into one read', () => {
    const gapMs = 250;
    const signals = signalInstantsBetween(NOW, NOW + 600_000, DATASET, gapMs);
    const recorded = attemptsBetween(NOW, NOW + 600_000, DATASET).map(finished).filter((at) => at > NOW);
    for (let index = 1; index < signals.length; index++) {
      assert.ok(signals[index] - signals[index - 1] >= gapMs, `signals ${index - 1} and ${index} are closer than the gap`);
    }
    for (const at of recorded) {
      // The first signal at or after an attempt is the read that finds it, and it never
      // waits past the gap for one.
      const covering = signals.find((signal) => signal >= at);
      assert.ok(covering !== undefined && covering - at <= gapMs, `the attempt at ${at} is never read`);
    }
    assert.ok(signals.length < new Set(recorded).size, 'no burst was merged');
  });
});
