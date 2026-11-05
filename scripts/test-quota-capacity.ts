import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { TFunc } from '../web/src/i18n/index.tsx';
import type { QuotaWindowCapacity } from '../web/src/types/quota.ts';
import {
  compactQuotaCapacity,
  describeCompactQuotaCapacity,
  describeQuotaCapacity,
  formatEstimatedUsd,
} from '../web/src/pages/quota/quotaCapacity.ts';

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}(${Object.values(params).join(',')})` : key) as TFunc;

const usage = { from_ms: 0, to_ms: 1, requests: 40, priced_requests: 40, tokens: 480_000, cost_nanos: 1_200_000_000 };
const capacity: QuotaWindowCapacity = {
  tokens: 9_600_000, cost_nanos: 24_000_000_000, error_percent: 10, basis: 'observed_delta',
  remaining_tokens: 7_200_000, remaining_cost_nanos: 18_000_000_000,
};
const dated = { ...capacity, remaining_tokens: undefined, remaining_cost_nanos: undefined };

test('estimate precision follows the sensitivity of the percentage reading', () => {
  assert.equal(formatEstimatedUsd(123.456, 10), '$120');
  assert.equal(formatEstimatedUsd(123.456, 2), '$123');
  assert.equal(formatEstimatedUsd(1234.5, 2), '$1,230');
  assert.equal(formatEstimatedUsd(19.086, 0.9), '$19.10');
  assert.equal(formatEstimatedUsd(1.6987, 1.4), '$1.70');
  assert.equal(formatEstimatedUsd(0.08349, 5), '$0.083');
  assert.equal(formatEstimatedUsd(Number.NaN, 5), '—');
});

test('an estimate states only the size of the window, live or dated', () => {
  // The server's remaining figure is not repeated: the bar already shows the remaining share.
  for (const window of [capacity, dated]) {
    assert.deepEqual(describeQuotaCapacity({ usage, capacity: window }, 'en-compact', t), {
      capacity: { value: '≈ $24.00', tokens: 'quota.capacity_tokens(9.6M)' },
      recorded: null,
      note: null,
    });
    assert.equal(compactQuotaCapacity({ capacity: window }, 'en-compact', t), '≈$24.00');
    assert.equal(describeCompactQuotaCapacity({ capacity: window }, 'en-compact', t), 'quota.capacity_estimate quota.capacity_figure(≈ $24.00,quota.capacity_tokens(9.6M))');
  }
});

test('without a stated cost the figures are tokens, and a mostly unpriced cycle states none', () => {
  const unpriced = { ...dated, cost_nanos: undefined };
  const reading = describeQuotaCapacity({ usage: { ...usage, priced_requests: 30 }, capacity: unpriced }, 'en-compact', t);
  assert.deepEqual(reading?.capacity, { value: '≈ quota.capacity_tokens(9.6M)', tokens: null });
  assert.equal(compactQuotaCapacity({ capacity: unpriced }, 'en-compact', t), '≈quota.capacity_tokens(9.6M)');
  const pending = describeQuotaCapacity({ usage: { ...usage, priced_requests: 30 }, capacity_unavailable: 'low_usage' }, 'en-compact', t);
  assert.deepEqual(pending?.recorded, { value: 'quota.capacity_tokens(480K)', tokens: null });
});

test('before an estimate the recorded usage stays beside the step that starts one', () => {
  for (const reason of ['scope_unknown', 'history_unavailable', 'usage_unavailable', 'low_usage', 'no_traffic'] as const) {
    const reading = describeQuotaCapacity({ usage, capacity_unavailable: reason }, 'en-compact', t);
    assert.equal(reading?.note, `quota.capacity_reason_${reason}`);
    assert.deepEqual(reading?.recorded, { value: '$1.20', tokens: 'quota.capacity_tokens(480K)' });
    assert.equal(reading?.capacity, null);
  }
  // An empty bar already says there is no reading; the row says nothing more.
  assert.equal(describeQuotaCapacity({ capacity_unavailable: 'no_reading' }, 'en-compact', t), null);
  assert.equal(describeQuotaCapacity({}, 'en-compact', t), null);
  assert.equal(compactQuotaCapacity({ usage, capacity_unavailable: 'low_usage' }, 'en-compact', t), null);
});
