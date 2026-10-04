/**
 * Locks how a quota window's recorded usage and estimated capacity are read out.
 *
 * The estimate is a division by a share upstream rounds to whole points, so the display has
 * two ways to mislead: printing more digits than the reading supports, and showing a figure
 * for a window the server withheld one from. Both are decisions of these pure functions.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TFunc } from '../web/src/i18n/index.tsx';
import {
  compactQuotaCapacity,
  describeQuotaCapacity,
  formatCapacityError,
  formatEstimatedUsd,
} from '../web/src/pages/quota/quotaCapacity.ts';

// Keys render as themselves with their parameters, keeping the suite independent of the
// dictionary's wording.
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}(${Object.values(params).join(',')})` : key) as TFunc;

const usage = { from_ms: 0, to_ms: 1, requests: 40, priced_requests: 40, tokens: 480_000, cost_nanos: 1_200_000_000 };

test('an estimate prints only the digits its uncertainty supports', () => {
  assert.equal(formatEstimatedUsd(123.456, 10), '$120');
  assert.equal(formatEstimatedUsd(123.456, 2), '$123');
  assert.equal(formatEstimatedUsd(1234.5, 2), '$1,230');
  assert.equal(formatEstimatedUsd(19.086, 0.9), '$19.10');
  assert.equal(formatEstimatedUsd(1.6987, 1.4), '$1.70');
  assert.equal(formatEstimatedUsd(0.08349, 5), '$0.083');
  assert.equal(formatEstimatedUsd(Number.NaN, 5), '—');
});

test('the uncertainty drops a trailing zero', () => {
  assert.equal(formatCapacityError(10), '±10%');
  assert.equal(formatCapacityError(2.5), '±2.5%');
});

test('an estimated window reads recorded usage and the estimate with its uncertainty', () => {
  const reading = describeQuotaCapacity(
    { usage, capacity: { tokens: 9_600_000, cost_nanos: 24_000_000_000, error_percent: 10 } },
    'en-compact',
    t,
  );
  assert.deepEqual(reading, {
    recorded: '$1.20 · quota.capacity_tokens(480K)',
    estimate: '≈ $24.00 · quota.capacity_tokens(9.6M)',
    error: '±10%',
    note: null,
  });
});

test('a partly priced cycle states its priced share and estimates tokens only', () => {
  const reading = describeQuotaCapacity(
    { usage: { ...usage, priced_requests: 30 }, capacity: { tokens: 9_600_000, error_percent: 10 } },
    'en-compact',
    t,
  );
  assert.equal(reading?.recorded, '$1.20 · quota.capacity_tokens(480K) · quota.capacity_priced_share(75)');
  assert.equal(reading?.estimate, '≈ quota.capacity_tokens(9.6M)');
});

test('a cycle with no priced request shows no dollar figure at all', () => {
  const reading = describeQuotaCapacity({ usage: { ...usage, priced_requests: 0, cost_nanos: 0 } }, 'en-compact', t);
  assert.equal(reading?.recorded, 'quota.capacity_tokens(480K)');
});

test('a withheld estimate keeps the recorded usage and says why', () => {
  const reading = describeQuotaCapacity({ usage, capacity_unavailable: 'low_usage' }, 'en-compact', t);
  assert.deepEqual(reading, {
    recorded: '$1.20 · quota.capacity_tokens(480K)',
    estimate: null,
    error: null,
    note: 'quota.capacity_reason_low_usage',
  });
});

test('a window the estimate does not apply to renders no line', () => {
  assert.equal(describeQuotaCapacity({}, 'en-compact', t), null);
  // An empty bar already says there is no reading.
  assert.equal(describeQuotaCapacity({ capacity_unavailable: 'no_reading' }, 'en-compact', t), null);
});

test('the list row carries the estimate alone, and nothing when it is withheld', () => {
  assert.equal(
    compactQuotaCapacity({ capacity: { tokens: 9_600_000, cost_nanos: 24_000_000_000, error_percent: 10 } }, 'en-compact', t),
    '≈$24.00',
  );
  assert.equal(
    compactQuotaCapacity({ capacity: { tokens: 9_600_000, error_percent: 10 } }, 'en-compact', t),
    '≈quota.capacity_tokens(9.6M)',
  );
  assert.equal(compactQuotaCapacity({ usage, capacity_unavailable: 'low_usage' }, 'en-compact', t), null);
});
