import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { TFunc } from '../../src/i18n/index.tsx';
import type { QuotaWindowCapacity } from '../../src/types/quota.ts';
import {
  activeSubscriptionPeriodKey,
  compactQuotaCapacity,
  describeCapacityCard,
  formatCycleCardFigures,
  hasActiveSubscriptionPeriod,
  quotaCapacityNote,
  quotaSubscriptionPeriodKey,
  subscriptionProjectionNote,
  supportsSubscriptionCycleTab,
} from '../../src/pages/quota/quotaCapacity.ts';
import {
  formatQuotaMetric,
  isCodexResetCreditEligible,
  nextCodexResetCreditExpiryDelayMS,
  orderCodexResetCredits,
  quotaPayloadSummary,
  resolveSelectedCodexResetCredit,
} from '../../src/pages/quota/quotaFormat.ts';
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

test('orderCodexResetCredits excludes spent credits and orders soonest-expiring first with undated entries last', () => {
  const ordered = orderCodexResetCredits([
    { id: 'c-late', status: 'available', granted_at_ms: 200, expires_at_ms: 3000 },
    { id: 'c-used', status: 'used', granted_at_ms: 50, expires_at_ms: 500 },
    { id: 'c-undated', status: 'available', granted_at_ms: 100 },
    { id: 'c-early', status: 'available', granted_at_ms: 300, expires_at_ms: 1000 },
    { id: 'c-tie-b', status: 'available', granted_at_ms: 400, expires_at_ms: 2000 },
    { id: 'c-tie-a', status: 'available', granted_at_ms: 100, expires_at_ms: 2000 },
  ]);
  assert.deepEqual(
    ordered.map((credit) => credit.id),
    ['c-early', 'c-tie-a', 'c-tie-b', 'c-late', 'c-undated'],
  );
  assert.deepEqual(orderCodexResetCredits(undefined), []);
});

test('resolveSelectedCodexResetCredit defaults to earliest eligible card, preserves valid picks, and falls back when expired or gone', () => {
  const nowMS = 2000;
  const ordered = orderCodexResetCredits([
    { id: 'c-expired', status: 'available', expires_at_ms: 1500 },
    { id: 'c-blank-id', status: 'available', expires_at_ms: 2100 },
    { id: '  ', status: 'available', expires_at_ms: 2050 },
    { id: 'c-later', status: 'available', expires_at_ms: 5000 },
    { id: 'c-soonest', status: ' available ', expires_at_ms: 3000 },
    { id: 'c-undated', status: 'available' },
  ]);

  assert.equal(isCodexResetCreditEligible({ id: 'c-expired', status: 'available', expires_at_ms: 1500 }, nowMS), false);
  assert.equal(isCodexResetCreditEligible({ id: '  ', status: 'available', expires_at_ms: 5000 }, nowMS), false);
  assert.equal(isCodexResetCreditEligible({ id: 'c-soonest', status: ' available ', expires_at_ms: 3000 }, nowMS), true);
  assert.equal(isCodexResetCreditEligible({ id: 'c-undated', status: 'available' }, nowMS), true);

  // Auto-defaults to earliest unexpired credit, skipping expired and blank-ID entries.
  const initial = resolveSelectedCodexResetCredit(ordered, null, nowMS);
  assert.equal(initial.defaultCredit?.id, 'c-blank-id');
  assert.equal(initial.selectedCredit?.id, 'c-blank-id');
  assert.equal(initial.eligibleCount, 4);

  // Keeps explicit pick while still eligible.
  const picked = resolveSelectedCodexResetCredit(ordered, 'c-later', nowMS);
  assert.equal(picked.defaultCredit?.id, 'c-blank-id');
  assert.equal(picked.selectedCredit?.id, 'c-later');

  // Falls back to earliest eligible card if the picked card is expired or removed.
  const expiredPick = resolveSelectedCodexResetCredit(ordered, 'c-expired', nowMS);
  assert.equal(expiredPick.selectedCredit?.id, 'c-blank-id');
  const gonePick = resolveSelectedCodexResetCredit(ordered, 'c-spent', nowMS);
  assert.equal(gonePick.selectedCredit?.id, 'c-blank-id');

  // Returns null when every listed card is expired.
  const noneEligible = resolveSelectedCodexResetCredit(
    [{ id: 'c-old', status: 'available', expires_at_ms: 1000 }],
    'c-old',
    nowMS,
  );
  assert.equal(noneEligible.defaultCredit, null);
  assert.equal(noneEligible.selectedCredit, null);
  assert.equal(noneEligible.eligibleCount, 0);

  // Computes the earliest upcoming eligible expiry delay, ignoring expired/invalid/undated entries and capping long waits.
  assert.equal(nextCodexResetCreditExpiryDelayMS(undefined, nowMS), null);
  assert.equal(
    nextCodexResetCreditExpiryDelayMS(
      [
        { id: 'c-expired', status: 'available', expires_at_ms: nowMS },
        { id: '  ', status: 'available', expires_at_ms: nowMS + 500 },
        { id: 'c-used', status: 'used', expires_at_ms: nowMS + 500 },
        { id: 'c-undated', status: 'available' },
      ],
      nowMS,
    ),
    null,
  );
  assert.equal(
    nextCodexResetCreditExpiryDelayMS(
      [
        { id: 'c-later', status: 'available', expires_at_ms: nowMS + 3_600_000 },
        { id: 'c-soon', status: 'available', expires_at_ms: nowMS + 5_000 },
      ],
      nowMS,
    ),
    5_000,
  );
  assert.equal(
    nextCodexResetCreditExpiryDelayMS(
      [{ id: 'c-month', status: 'available', expires_at_ms: nowMS + 30 * 24 * 3_600_000 }],
      nowMS,
    ),
    60_000,
  );
});

test('subscription cycle helpers require verified active start and expiry boundaries', () => {
  const now = Date.UTC(2026, 10, 15, 12, 0);
  const start = Date.UTC(2026, 10, 1, 12, 0);
  const end = Date.UTC(2026, 11, 1, 12, 0);
  const nextEnd = Date.UTC(2027, 0, 1, 12, 0);

  assert.equal(hasActiveSubscriptionPeriod({ starts_at_ms: start, expires_at_ms: end, expires_source: 'live_subscription' }, now), true);
  assert.equal(hasActiveSubscriptionPeriod({ starts_at_ms: start, expires_at_ms: end }, now), true);
  assert.equal(hasActiveSubscriptionPeriod({ starts_at_ms: start, expires_at_ms: end, expires_source: 'credential_snapshot' }, now), false);
  assert.equal(hasActiveSubscriptionPeriod({ expires_at_ms: end, expires_source: 'live_subscription' }, now), false);
  assert.equal(hasActiveSubscriptionPeriod({ starts_at_ms: start, expires_source: 'live_subscription' }, now), false);
  assert.equal(hasActiveSubscriptionPeriod({ starts_at_ms: start, expires_at_ms: end, expires_source: 'live_subscription' }, end), false);
  assert.equal(hasActiveSubscriptionPeriod({ starts_at_ms: start, expires_at_ms: end, expires_source: 'live_subscription' }, start - 1), false);
  assert.equal(hasActiveSubscriptionPeriod(undefined, now), false);

  const livePlan = { starts_at_ms: start, expires_at_ms: end, expires_source: 'live_subscription' as const };
  const periodKey = activeSubscriptionPeriodKey(livePlan, now);
  assert.ok(periodKey);
  // Advancing the clock within the same verified period keeps the cache key stable.
  assert.equal(activeSubscriptionPeriodKey(livePlan, now + 60_000), periodKey);
  // Rolling expiry forward (Codex renewal), rolling both bounds, or changing cadence produces a new key.
  assert.notEqual(activeSubscriptionPeriodKey({ ...livePlan, expires_at_ms: nextEnd }, end + 1_000), periodKey);
  assert.notEqual(activeSubscriptionPeriodKey({ ...livePlan, starts_at_ms: end, expires_at_ms: nextEnd }, end + 1_000), periodKey);
  assert.notEqual(activeSubscriptionPeriodKey({ ...livePlan, billing_period: 'monthly' }, now), periodKey);
  assert.equal(activeSubscriptionPeriodKey({ ...livePlan, expires_source: 'credential_snapshot' }, now), null);
  assert.equal(activeSubscriptionPeriodKey(livePlan, end), null);
  assert.equal(activeSubscriptionPeriodKey(livePlan, start - 1), null);
  assert.equal(activeSubscriptionPeriodKey(undefined, now), null);

  assert.equal(quotaSubscriptionPeriodKey({ auth_index: 'codex-1', observed_at_ms: now, status: 'healthy', plan: livePlan }, now), periodKey);
  assert.equal(quotaSubscriptionPeriodKey({ auth_index: 'codex-1', observed_at_ms: now, status: 'idle', plan: livePlan }, now), null);
  assert.equal(quotaSubscriptionPeriodKey({ auth_index: 'codex-1', observed_at_ms: now, status: 'error', plan: livePlan }, now), null);
  assert.equal(quotaSubscriptionPeriodKey({ auth_index: 'codex-1', observed_at_ms: 0, status: 'healthy', plan: livePlan }, now), null);
  assert.equal(quotaSubscriptionPeriodKey({ auth_index: '', observed_at_ms: now, status: 'healthy', plan: livePlan }, now), null);
  assert.equal(quotaSubscriptionPeriodKey(undefined, now), null);

  assert.equal(supportsSubscriptionCycleTab(undefined, true), true);
  assert.equal(supportsSubscriptionCycleTab({ scope: 'standard' }, true), true);
  assert.equal(supportsSubscriptionCycleTab({ scope: 'standard' }, false), false);
  assert.equal(supportsSubscriptionCycleTab({ scope: 'model' }, true), false);
  assert.equal(supportsSubscriptionCycleTab({ scope: 'group' }, true), false);
  assert.equal(supportsSubscriptionCycleTab({ scope: 'code_review' }, true), false);

  assert.equal(subscriptionProjectionNote('insufficient_elapsed', t), 'quota.subscription_reason_insufficient_elapsed');
  assert.equal(subscriptionProjectionNote('no_traffic', t), 'quota.capacity_reason_no_traffic');
  assert.equal(subscriptionProjectionNote('usage_unavailable', t), 'quota.capacity_reason_usage_unavailable');
  assert.equal(subscriptionProjectionNote(undefined, t), null);
});
