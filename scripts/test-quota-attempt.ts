import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuotaItem } from '../web/src/types/quota.ts';
import { outlivedResetLine, refreshFailureLine } from '../web/src/pages/quota/quotaAttempt.ts';

const t = ((key: string, values?: Record<string, string | number>) => (
  values ? `${key}(${Object.values(values).join('|')})` : key
)) as unknown as Parameters<typeof refreshFailureLine>[2];

const NOW = 1_800_000_000_000;

function item(overrides: Partial<QuotaItem> = {}): QuotaItem {
  return {
    auth_index: 'idx',
    name: 'cred.json',
    type: 'codex',
    provider: 'codex',
    disabled: false,
    status: 'healthy',
    observed_at_ms: NOW - 3 * 24 * 60 * 60 * 1000,
    windows: [],
    recommendation: { status: 'healthy', priority: 'none', action: 'none', reason: '' },
    capabilities: { refresh_supported: true, clear_cooldown_supported: false, reset_credit_supported: false },
    quota_exceeded: false,
    ...overrides,
  } as QuotaItem;
}

test('a failed refresh is stated beside the reading it left in place', () => {
  const line = refreshFailureLine(item({
    status: 'error',
    error: 'HTTP 401: unauthorized',
    last_refresh: { attempted_at_ms: NOW - 60_000, outcome: 'failed', error: 'HTTP 401: unauthorized' },
  }), NOW, t);
  assert.ok(line, 'a failed attempt must produce a line');
  assert.match(line, /^quota\.last_refresh_failed\(/);
  assert.match(line, /HTTP 401/);
});

test('a row with no failed attempt says nothing about refreshing', () => {
  assert.equal(refreshFailureLine(item(), NOW, t), null);
  assert.equal(refreshFailureLine(item({
    last_refresh: { attempted_at_ms: NOW - 60_000, outcome: 'succeeded' },
  }), NOW, t), null);
});

test('a failed attempt with no reason still names the failure', () => {
  const line = refreshFailureLine(item({
    status: 'stale',
    last_refresh: { attempted_at_ms: NOW - 60_000, outcome: 'failed' },
  }), NOW, t);
  assert.ok(line && line.includes('quota.status_error'), 'the line falls back to the status copy');
});

test('a stale reading nobody failed to refresh is explained by its reset boundary', () => {
  const stale = item({ status: 'stale' });
  assert.equal(outlivedResetLine(stale, t), 'quota.reading_outlived_reset');
  // The failure explanation wins: it names a reason and a time, and the boundary one does not.
  assert.equal(outlivedResetLine(item({
    status: 'stale',
    last_refresh: { attempted_at_ms: NOW - 60_000, outcome: 'failed', error: 'HTTP 500: upstream' },
  }), t), null);
  assert.equal(outlivedResetLine(item(), t), null);
});
