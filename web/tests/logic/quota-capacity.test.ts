import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { TFunc } from '../../src/i18n/index.tsx';
import type { QuotaWindowCapacity } from '../../src/types/quota.ts';
import { compactQuotaCapacity, describeCapacityCard, formatCycleCardFigures, quotaCapacityNote } from '../../src/pages/quota/quotaCapacity.ts';
import { formatQuotaMetric, quotaPayloadSummary } from '../../src/pages/quota/quotaFormat.ts';
import { siblingCapacityWindows } from '../../src/pages/quota/quotaWindowSelection.ts';

const t = ((key: string, params?: Record<string, unknown>) => params ? `${key}(${Object.values(params).join(',')})` : key) as TFunc;
const usage = { from_ms: 0, to_ms: 1, requests: 40, priced_requests: 40, tokens: 480_000, cost_nanos: 1_200_000_000 };
const capacity: QuotaWindowCapacity = {
  basis: 'current_window',
  sample_requests: 10,
  sample_priced_requests: 10,
  requests: 100,
  tokens: 1_000_000,
  cost_nanos: 20_000_000_000,
  cache_rate: 80,
};

test('capacity readings show estimated full-window cost, requests, tokens, and compact list value', () => {
  const reading = describeCapacityCard(capacity, 'en-compact', t);
  assert.equal(reading.cost, '≈ $20.00');
  assert.equal(reading.requests, '≈ 100');
  assert.equal(reading.tokens, '≈ 1M');
  assert.equal(reading.cacheRate, 80);
  assert.equal(compactQuotaCapacity({ capacity }, 'en-compact', t), '≈ $20.00');
  assert.equal(compactQuotaCapacity({ capacity: { ...capacity, sample_priced_requests: 5 } }, 'en-compact', t), '≥ $20.00');
  assert.equal(compactQuotaCapacity({ capacity: { ...capacity, sample_priced_requests: 0, cost_nanos: undefined } }, 'en-compact', t), '≈ 1M');
  assert.equal(compactQuotaCapacity({ capacity: undefined }, 'en-compact', t), null);

  const partial = describeCapacityCard({ ...capacity, sample_priced_requests: 5 }, 'en-compact', t);
  assert.equal(partial.cost, '≥ $20.00');
  assert.equal(partial.costHint, 'quota.capacity_partial_priced_hint(5,10)');

  const unpriced = describeCapacityCard({ ...capacity, sample_priced_requests: 0, cost_nanos: undefined }, 'en-compact', t);
  assert.equal(unpriced.cost, null);
  assert.equal(unpriced.costReadout, undefined);
  assert.equal(unpriced.tokens, '≈ 1M');

  const zeroCost = describeCapacityCard({ ...capacity, requests: 0, tokens: 0, cost_nanos: 0 }, 'en-compact', t);
  assert.equal(zeroCost.cost, '$0.00');
  assert.equal(zeroCost.requests, '0');
  assert.equal(zeroCost.tokens, '0');
  assert.equal(describeCapacityCard(null, 'en-compact', t).cost, null);
});

test('missing observations carry an unavailability note', () => {
  for (const reason of ['scope_unknown', 'history_unavailable', 'usage_unavailable', 'low_usage', 'no_traffic'] as const) {
    assert.equal(quotaCapacityNote(reason, t), `quota.capacity_reason_${reason}`);
  }
  assert.equal(quotaCapacityNote(undefined, t), null);
});

test('a plugin summary figure reads as its plugin means it', () => {
  assert.equal(formatQuotaMetric({ key: 'credits', label: 'Credits', value: 1250000, unit: 'credits', format: 'number' }), '1,250,000 credits');
  assert.equal(formatQuotaMetric({ key: 'spend', label: 'Spend', value: 12.5, format: 'currency', currency: 'EUR' }), '€12.50');
  // Without a named currency a currency figure stays a number: a guessed one would be wrong money.
  assert.equal(formatQuotaMetric({ key: 'odd', label: 'Odd', value: 3, format: 'currency' }), '3');
  assert.equal(formatQuotaMetric({ key: 'left', label: 'Left', value: 42.25, format: 'percent' }), '42.3%');
});

test('a plugin reading lists what it was built from; a built-in reading lists nothing', () => {
  const windows = [
    { id: 'a', label: 'Harbor · Credits', scope: 'group' as const, remaining_percent: 100, description: '100 / 100 credits left' },
    { id: 'b', label: 'Harbor · 5h', scope: 'group' as const, remaining_percent: 40, reset_at_ms: Date.UTC(2026, 10, 7, 12) },
  ];
  assert.deepEqual(quotaPayloadSummary({ windows, plan: { plan_type: 'unknown', plan_label: '', tier: 'unknown', metrics: [{ key: 'credits', label: 'Credits', value: 100, unit: 'credits' }] } }), [
    ['Harbor Credits', '100%\n100 / 100 credits left'],
    ['Harbor 5h', '40%\n2026-11-07T12:00:00.000Z'],
    ['summary.credits', '100 credits'],
  ]);
  assert.deepEqual(quotaPayloadSummary({ windows: [{ id: 'c', label: '5h', scope: 'standard', remaining_percent: 70 }] }), []);
});

test('cycle card figures distinguish fully priced, partially priced, and unpriced usage', () => {
  const full = formatCycleCardFigures(
    { from_ms: 0, reset_at_ms: 1, usage: { ...usage, cache_rate: 75 } },
    'en-compact',
    t,
  );
  assert.equal(full.cost, '$1.20');
  assert.equal(full.costHint, null);
  assert.equal(full.cacheRate, 75);

  const partial = formatCycleCardFigures(
    { from_ms: 0, reset_at_ms: 1, usage: { ...usage, priced_requests: 20 } },
    'en-compact',
    t,
  );
  assert.equal(partial.cost, '≥ $1.20');
  assert.equal(partial.costHint, 'quota.capacity_partial_priced_hint(20,40)');
});

test('sibling capacity windows group by quota family and sort shortest period first', () => {
  const fiveHour = { id: 'five_hour', label: '5h', kind: 'five_hour' as const, scope: 'standard' as const, capacity };
  const weekly = { id: 'seven_day', label: '7d', kind: 'weekly' as const, scope: 'standard' as const, capacity_unavailable: 'low_usage' as const };
  const codeReview = { id: 'review', label: 'Review', scope: 'code_review' as const, remaining_percent: 100 };
  const sonnetModel = { id: 'sonnet', label: 'Sonnet', scope: 'model' as const, model: 'claude-sonnet-4-6', capacity };
  assert.deepEqual(
    siblingCapacityWindows(weekly, [weekly, codeReview, sonnetModel, fiveHour]).map((w) => w.id),
    ['five_hour', 'seven_day'],
  );
});
