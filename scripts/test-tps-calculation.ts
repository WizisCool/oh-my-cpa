import assert from 'node:assert/strict';
import { DEFAULT_TPS_CALCULATION_MODE, parseTpsCalculationMode } from '../web/src/types/tpsCalculation';
import { eventTokensPerSecond, hasMeasurableTTFT, isNonStreamingEvent, tpsCalculationHintKey } from '../web/src/types/usageEventMetrics';

assert.equal(DEFAULT_TPS_CALCULATION_MODE, 'exclude_ttft');
for (const mode of ['exclude_ttft', 'include_ttft']) assert.equal(parseTpsCalculationMode(mode), mode);
for (const value of [undefined, null, '', 'unknown', true, 0, {}, ['include_ttft']]) {
  assert.equal(parseTpsCalculationMode(value) ?? DEFAULT_TPS_CALCULATION_MODE, 'exclude_ttft');
}
const event = {
  generate: true, stream: true, latency_ms: 2000, ttft_ms: 1000,
  tokens: { total: 120, input: 20, output: 100, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
};
assert.deepEqual(eventTokensPerSecond(event), { tps: 100, formatted: '100.00 t/s', basis: 'exclude_ttft' });
assert.deepEqual(eventTokensPerSecond(event, 'include_ttft'), { tps: 50, formatted: '50.00 t/s', basis: 'include_ttft' });
assert.equal(tpsCalculationHintKey('exclude_ttft'), 'events.tps_hint_ttft');
assert.equal(tpsCalculationHintKey('include_ttft'), 'events.tps_hint_total');
assert.equal(tpsCalculationHintKey('fallback_total'), 'events.tps_hint_fallback');
for (const stream of [true, false, undefined]) {
  assert.equal(eventTokensPerSecond({ ...event, stream }).tps, 100);
  assert.equal(eventTokensPerSecond({ ...event, stream }, 'include_ttft').tps, 50);
}
for (const ttft_ms of [undefined, null, 0, -1, 1951, 2000, 2100, NaN, Infinity]) {
  const record = { ...event, ttft_ms };
  assert.equal(eventTokensPerSecond(record).basis, 'fallback_total');
  assert.equal(eventTokensPerSecond(record).tps, 50);
  assert.equal(eventTokensPerSecond(record, 'include_ttft').basis, 'include_ttft');
  assert.equal(eventTokensPerSecond(record, 'include_ttft').tps, 50);
}
assert.equal(eventTokensPerSecond({ ...event, ttft_ms: 1950 }).tps, 2000);
for (const mode of ['exclude_ttft', 'include_ttft'] as const) {
  for (const record of [undefined, { ...event, generate: false }, ...[0, -1, NaN, Infinity].map(latency_ms => ({ ...event, latency_ms })), ...[0, -1, NaN, Infinity].map(output => ({ ...event, tokens: { ...event.tokens, output } }))]) {
    assert.deepEqual(eventTokensPerSecond(record, mode), { tps: null, formatted: '—', basis: null });
  }
}
const snapshot = structuredClone(event);
eventTokensPerSecond(event, 'include_ttft');
assert.deepEqual(event, snapshot);
assert.equal(hasMeasurableTTFT(event), true);
assert.equal(isNonStreamingEvent({ ...event, stream: false }), false);
console.log('PASS TPS calculation: global modes, fallback, boundaries, timing metadata and hint basis');
