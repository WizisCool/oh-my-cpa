import assert from 'node:assert/strict';
import { calculateTokensPerSecond, DEFAULT_TPS_CALCULATION_MODE, outputTotalWithReasoning, parseTpsCalculationMode } from '../web/src/types/tpsCalculation';
import { eventTokensPerSecond } from '../web/src/types/usageEventMetrics';
import type { TokenAccounting } from '../web/src/types/tokenAccounting';

assert.equal(DEFAULT_TPS_CALCULATION_MODE, 'include_ttft');
for (const mode of ['exclude_ttft', 'include_ttft']) assert.equal(parseTpsCalculationMode(mode), mode);
for (const value of [undefined, null, '', 'unknown', true, 0, {}, ['include_ttft']]) {
  assert.equal(parseTpsCalculationMode(value) ?? DEFAULT_TPS_CALCULATION_MODE, 'include_ttft');
}
const event = {
  generate: true, stream: true, latency_ms: 2000, ttft_ms: 1000,
  tokens: { total: 120, input: 20, output: 100, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
};
const absent = (basis: string | null) => ({ tps: null, formatted: '—', basis });
// A reported high rate is not evidence of buffering and cannot change the selected formula.
for (const [latency_ms, ttft_ms, output] of [[2000, 1000, 501], [1049, 1000, 25], [1001, 1000, 10], [26200, 25790, 1020]]) {
  for (const stream of [true, false, null, undefined]) {
    const record = { ...event, stream, latency_ms, ttft_ms, tokens: { ...event.tokens, output, total: event.tokens.input + output } };
    const snapshot = structuredClone(record);
    for (const mode of ['exclude_ttft', 'include_ttft'] as const) {
      const tps = output * 1000 / (mode === 'exclude_ttft' ? latency_ms - ttft_ms : latency_ms);
      assert.deepEqual(eventTokensPerSecond(record, mode), { tps, formatted: `${tps.toFixed(2)} t/s`, basis: mode });
    }
    assert.deepEqual(record, snapshot);
  }
}
for (const ttft_ms of [undefined, null, 0, -1, 2000, 2100, NaN, Infinity]) {
  assert.deepEqual(eventTokensPerSecond({ ...event, ttft_ms }, 'exclude_ttft'), absent('unavailable_timing'));
  assert.deepEqual(eventTokensPerSecond({ ...event, ttft_ms }, 'include_ttft'), { tps: 50, formatted: '50.00 t/s', basis: 'include_ttft' });
}
for (const mode of ['exclude_ttft', 'include_ttft'] as const) {
  for (const record of [undefined, { ...event, generate: false }, ...[0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1].map(output => ({ ...event, tokens: { ...event.tokens, output } }))]) {
    assert.deepEqual(eventTokensPerSecond(record, mode), absent(null));
  }
  for (const latency_ms of [0, -1, NaN, Infinity]) assert.deepEqual(eventTokensPerSecond({ ...event, latency_ms }, mode), absent('unavailable_timing'));
}
const accounting: TokenAccounting = {
  version: 1, status: 'complete',
  raw_tokens: { input_tokens: 20, output_tokens: 47, reasoning_tokens: 767, cached_tokens: 0, cache_read_tokens: 0, cache_read_tokens_present: true, cache_creation_tokens: 0, total_tokens: 834 },
  token_breakdown: {
    schema_version: 1, quality: 'complete', total_tokens: 834,
    input: { total_tokens: 20, uncached_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0 },
    output: { total_tokens: 814, non_reasoning_tokens: 47, reasoning_tokens: 767 }, unclassified_tokens: 0,
  },
};
const hidden = { ...event, latency_ms: 20550, ttft_ms: 20120, token_accounting: accounting };
assert.deepEqual(eventTokensPerSecond(hidden, 'exclude_ttft'), absent('unavailable_reasoning'));
assert.deepEqual(eventTokensPerSecond(hidden, 'include_ttft'), { tps: 814000 / 20550, formatted: '39.61 t/s', basis: 'include_ttft' });
for (const status of ['invalid', 'inconsistent', 'unsupported', 'unclassified'] as const) {
  for (const mode of ['exclude_ttft', 'include_ttft'] as const) {
    assert.deepEqual(eventTokensPerSecond({ ...event, token_accounting: { ...accounting, status } }, mode), absent('unavailable_accounting'));
  }
}
// Legacy counts still support the end-to-end average. They cannot support subtraction when
// reasoning is reported because the record does not locate the hidden-reasoning boundary.
const inclusiveLegacy = { ...event, tokens: { ...event.tokens, reasoning: 20 } };
assert.deepEqual(eventTokensPerSecond(inclusiveLegacy, 'exclude_ttft'), absent('unavailable_reasoning'));
assert.deepEqual(eventTokensPerSecond(inclusiveLegacy, 'include_ttft'), { tps: 50, formatted: '50.00 t/s', basis: 'include_ttft' });
// A flat reasoning count can be independent of output. The grand total proves which convention
// produced the record, so inclusion must not drop those tokens or count an inclusive one twice.
const separateLegacy = { ...event, tokens: { ...inclusiveLegacy.tokens, input: 20, output: 100, reasoning: 20, total: 140 } };
assert.deepEqual(outputTotalWithReasoning({ inputTokens: 20, outputTokens: 100, reasoningTokens: 20, totalTokens: 140 }), { outputTokens: 120, isAccountingValid: true });
assert.deepEqual(eventTokensPerSecond(separateLegacy, 'exclude_ttft'), absent('unavailable_reasoning'));
assert.deepEqual(eventTokensPerSecond(separateLegacy, 'include_ttft'), { tps: 60, formatted: '60.00 t/s', basis: 'include_ttft' });
assert.deepEqual(eventTokensPerSecond({ ...event, tokens: { ...separateLegacy.tokens, total: 130 } }, 'include_ttft'), absent('unavailable_accounting'));
// The Playground observes first non-reasoning content, so only non-reasoning output belongs in its tail.
const contentObservation = { outputTokens: 814, reasoningTokens: 767, durationMS: 20550, firstTokenMS: 20120, firstTokenKind: 'non_reasoning' as const };
assert.deepEqual(calculateTokensPerSecond(contentObservation, 'exclude_ttft'), { tps: 47000 / 430, formatted: '109.30 t/s', basis: 'exclude_ttft_visible' });
assert.deepEqual(calculateTokensPerSecond(contentObservation, 'include_ttft'), { tps: 814000 / 20550, formatted: '39.61 t/s', basis: 'include_ttft' });
assert.deepEqual(calculateTokensPerSecond({ ...contentObservation, reasoningTokens: undefined }, 'exclude_ttft'), absent('unavailable_accounting'));
assert.deepEqual(calculateTokensPerSecond({ ...contentObservation, reasoningTokens: 815 }, 'exclude_ttft'), absent('unavailable_accounting'));
assert.deepEqual(calculateTokensPerSecond({ ...contentObservation, reasoningTokens: 814 }, 'exclude_ttft'), absent(null));
assert.deepEqual(calculateTokensPerSecond({ ...contentObservation, firstTokenMS: 20550 }, 'exclude_ttft'), absent('unavailable_timing'));
assert.deepEqual(calculateTokensPerSecond({ outputTokens: 10, reasoningTokens: 0, durationMS: 20, firstTokenMS: 0, firstTokenKind: 'non_reasoning' }, 'exclude_ttft'), { tps: 500, formatted: '500.00 t/s', basis: 'exclude_ttft_visible' });
console.log('PASS TPS: total-duration default, token-scope evidence, canonical reasoning, explicit missing evidence and independent modes');
