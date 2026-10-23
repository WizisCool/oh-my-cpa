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
// Issue #295: rounded total durations and reported residual windows from buffered tool calls.
// These records have no reasoning tokens, and every tail exceeds the 50 ms timing floor.
for (const [request, latency_ms, tailMs, output, formatted] of [
  ['d55a0924', 26_200, 410, 1020, '38.93 t/s'],
  ['6d3db92b', 25_800, 320, 735, '28.49 t/s'],
  ['b4bf1b9d', 31_500, 520, 1125, '35.71 t/s'],
  ['82a89fa5', 26_600, 240, 1580, '59.40 t/s'],
] as const) {
  for (const stream of [true, false, null, undefined]) {
    const record = { ...event, stream, latency_ms, ttft_ms: latency_ms - tailMs, tokens: { ...event.tokens, output } };
    const snapshot = structuredClone(record);
    assert.deepEqual(eventTokensPerSecond(record), {
      tps: output * 1000 / latency_ms, formatted, basis: 'fallback_buffered',
    }, `${request}: a buffered tail must not become the generation denominator (stream=${stream})`);
    assert.deepEqual(eventTokensPerSecond(record, 'include_ttft'), {
      tps: output * 1000 / latency_ms, formatted, basis: 'include_ttft',
    });
    assert.equal(hasMeasurableTTFT(record), true);
    assert.equal(isNonStreamingEvent(record), false);
    assert.deepEqual(record, snapshot);
  }
}
for (const [output, expected] of [
  [499, { tps: 499, formatted: '499.00 t/s', basis: 'exclude_ttft' }],
  [500, { tps: 500, formatted: '500.00 t/s', basis: 'exclude_ttft' }],
  [501, { tps: 250.5, formatted: '250.50 t/s', basis: 'fallback_buffered' }],
] as const) {
  assert.deepEqual(eventTokensPerSecond({ ...event, tokens: { ...event.tokens, output } }), expected);
}
// This is a subtraction guard, not a speed cap: the end-to-end rate remains untouched.
assert.deepEqual(eventTokensPerSecond({ ...event, tokens: { ...event.tokens, output: 2000 } }), {
  tps: 1000, formatted: '1000.00 t/s', basis: 'fallback_buffered',
});
assert.deepEqual(eventTokensPerSecond({ ...event, tokens: { ...event.tokens, output: 2000 } }, 'include_ttft'), {
  tps: 1000, formatted: '1000.00 t/s', basis: 'include_ttft',
});
assert.equal(tpsCalculationHintKey('exclude_ttft'), 'events.tps_hint_ttft');
assert.equal(tpsCalculationHintKey('include_ttft'), 'events.tps_hint_total');
assert.equal(tpsCalculationHintKey('fallback_total'), 'events.tps_hint_fallback');
assert.equal(tpsCalculationHintKey('fallback_buffered'), 'events.tps_hint_buffered');
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
assert.deepEqual(eventTokensPerSecond({ ...event, ttft_ms: 1950, tokens: { ...event.tokens, output: 25 } }), {
  tps: 500, formatted: '500.00 t/s', basis: 'exclude_ttft',
});
for (const mode of ['exclude_ttft', 'include_ttft'] as const) {
  for (const record of [undefined, { ...event, generate: false }, ...[0, -1, NaN, Infinity].map(latency_ms => ({ ...event, latency_ms })), ...[0, -1, NaN, Infinity].map(output => ({ ...event, tokens: { ...event.tokens, output } }))]) {
    assert.deepEqual(eventTokensPerSecond(record, mode), { tps: null, formatted: '—', basis: null });
  }
}
// Codex request 01a148ff: hidden reasoning ran before the first visible token, so dividing
// all 814 output tokens by the 430 ms tail read ~1900 t/s. Reasoning rules the subtraction out
// in either output convention; the TTFT readout itself stays measurable.
const hiddenReasoning = {
  generate: true, stream: true, latency_ms: 20_550, ttft_ms: 20_120,
  tokens: { total: 152_714, input: 151_900, output: 814, reasoning: 767, cached: 0, cache_read: 0, cache_creation: 0 },
};
assert.equal(hasMeasurableTTFT(hiddenReasoning), true);
assert.deepEqual(eventTokensPerSecond(hiddenReasoning), { tps: 814_000 / 20_550, formatted: '39.61 t/s', basis: 'fallback_total' });
assert.equal(eventTokensPerSecond(hiddenReasoning, 'include_ttft').basis, 'include_ttft');
const snapshot = structuredClone(event);
eventTokensPerSecond(event, 'include_ttft');
assert.deepEqual(event, snapshot);
assert.equal(hasMeasurableTTFT(event), true);
assert.equal(isNonStreamingEvent({ ...event, stream: false }), false);
console.log('PASS TPS calculation: global modes, fallback, reasoning, boundaries, timing metadata and hint basis');
