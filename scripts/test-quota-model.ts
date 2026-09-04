import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuotaItem } from '../web/src/types/quota.ts';
import {
  computeTimelinePercent,
  filterQuotaItems,
  sortQuotaItems,
  computeFleetSummary,
} from '../web/src/pages/quota/quotaModel.ts';

// 1. Test Piecewise Timeline Scale
test('computeTimelinePercent aligns with piecewise intervals', () => {
  const ONE_HOUR = 3600 * 1000;
  const FIVE_HOURS = 5 * 3600 * 1000;
  const TWENTY_FOUR_HOURS = 24 * 3600 * 1000;
  const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

  assert.equal(computeTimelinePercent(0), 0);
  assert.equal(computeTimelinePercent(ONE_HOUR), 25);
  assert.equal(computeTimelinePercent(FIVE_HOURS), 50);
  assert.equal(computeTimelinePercent(TWENTY_FOUR_HOURS), 75);
  assert.equal(computeTimelinePercent(SEVEN_DAYS), 100);
  assert.equal(computeTimelinePercent(SEVEN_DAYS + 10000), 100);

  // Intermediate values
  const halfHour = computeTimelinePercent(1800 * 1000);
  assert.ok(halfHour > 0 && halfHour < 25);

  const threeHours = computeTimelinePercent(3 * 3600 * 1000);
  assert.ok(threeHours > 25 && threeHours < 50);
});

// 2. Test Filtering Logic
test('quota item filtering by provider, status, and search query', () => {
  const items: QuotaItem[] = [
    {
      auth_index: 'cx-1',
      name: 'Codex Pro Account',
      type: 'codex',
      provider: 'codex',
      disabled: false,
      status: 'healthy',
      observed_at_ms: Date.now(),
      windows: [{ id: 'five_hour', label: '5h', scope: 'standard', remaining_percent: 85 }],
      recommendation: { status: 'healthy', priority: 'none', action: 'none', reason: 'ok' },
      capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
      quota_exceeded: false,
    },
    {
      auth_index: 'cl-2',
      name: 'Claude Max Account',
      type: 'claude',
      provider: 'claude',
      disabled: false,
      status: 'warning',
      observed_at_ms: Date.now(),
      windows: [{ id: 'five_hour', label: '5h', scope: 'standard', remaining_percent: 12 }],
      recommendation: { status: 'warning', priority: 'low', action: 'none', reason: 'low' },
      capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: false },
      quota_exceeded: false,
    },
    {
      auth_index: 'cx-3',
      name: 'Codex Cooldown Account',
      type: 'codex',
      provider: 'codex',
      disabled: false,
      status: 'cooldown',
      observed_at_ms: Date.now(),
      active_cooldown: { is_active: true, reason: '429 too many requests' },
      windows: [{ id: 'five_hour', label: '5h', scope: 'standard', remaining_percent: 0 }],
      recommendation: { status: 'cooldown', priority: 'high', action: 'clear_cooldown', reason: 'cd' },
      capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
      quota_exceeded: true,
    },
  ];

  // Provider filter: 'claude'
  const claudeOnly = filterQuotaItems(items, 'claude', 'all', '');
  assert.equal(claudeOnly.length, 1);
  assert.equal(claudeOnly[0].auth_index, 'cl-2');

  // Status filter: 'cooldown'
  const cooldownOnly = filterQuotaItems(items, 'all', 'cooldown', '');
  assert.equal(cooldownOnly.length, 1);
  assert.equal(cooldownOnly[0].auth_index, 'cx-3');

  // Search filter: 'max'
  const searchMax = filterQuotaItems(items, 'all', 'all', 'max');
  assert.equal(searchMax.length, 1);
  assert.equal(searchMax[0].auth_index, 'cl-2');
});

// 3. Test Sorting Logic
test('quota item sorting by priority and remaining capacity', () => {
  const items: QuotaItem[] = [
    {
      auth_index: 'item-healthy',
      name: 'Alpha Healthy',
      type: 'codex',
      provider: 'codex',
      disabled: false,
      status: 'healthy',
      observed_at_ms: 100,
      windows: [{ id: 'w1', label: '5h', scope: 'standard', remaining_percent: 90 }],
      recommendation: { status: 'healthy', priority: 'none', action: 'none', reason: 'ok' },
      capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
      quota_exceeded: false,
    },
    {
      auth_index: 'item-warning',
      name: 'Beta Warning',
      type: 'claude',
      provider: 'claude',
      disabled: false,
      status: 'warning',
      observed_at_ms: 100,
      windows: [{ id: 'w1', label: '5h', scope: 'standard', remaining_percent: 15 }],
      recommendation: { status: 'warning', priority: 'low', action: 'none', reason: 'warn' },
      capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: false },
      quota_exceeded: false,
    },
    {
      auth_index: 'item-exhausted',
      name: 'Gamma Exhausted',
      type: 'codex',
      provider: 'codex',
      disabled: false,
      status: 'exhausted',
      observed_at_ms: 100,
      windows: [{ id: 'w1', label: '5h', scope: 'standard', remaining_percent: 0 }],
      recommendation: { status: 'exhausted', priority: 'medium', action: 'none', reason: 'out' },
      capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
      quota_exceeded: true,
    },
  ];

  // Least remaining first
  const leastRemaining = sortQuotaItems(items, 'least_remaining');
  assert.equal(leastRemaining[0].auth_index, 'item-exhausted');
  assert.equal(leastRemaining[1].auth_index, 'item-warning');
  assert.equal(leastRemaining[2].auth_index, 'item-healthy');

  // Most remaining first
  const mostRemaining = sortQuotaItems(items, 'most_remaining');
  assert.equal(mostRemaining[0].auth_index, 'item-healthy');
  assert.equal(mostRemaining[1].auth_index, 'item-warning');
  assert.equal(mostRemaining[2].auth_index, 'item-exhausted');

  // Fleet summary calculation
  const summary = computeFleetSummary(items);
  assert.equal(summary.total_credentials, 3);
  assert.equal(summary.healthy_count, 1);
  assert.equal(summary.warning_count, 1);
  assert.equal(summary.exhausted_count, 1);
});
