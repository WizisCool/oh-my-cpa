import assert from 'node:assert/strict';
import test from 'node:test';
import { compactCooldownDiagnostic, isKnownQuotaCooldownReason } from '../web/src/pages/quota/quotaCooldown.ts';
import type { QuotaItem } from '../web/src/types/quota.ts';

const quota: QuotaItem = {
  auth_index: 'fixture-auth', name: 'fixture.json', type: 'codex', provider: 'codex',
  disabled: false, status: 'cooldown', observed_at_ms: 1, windows: [], quota_exceeded: true,
};

const knownReason = JSON.stringify({ error: { code: 'credential_quota', message: 'Quota exhausted' } });

test('only the exact known credential quota code identifies a redundant cooldown diagnostic', () => {
  for (const reason of [knownReason, JSON.stringify({ code: 'credential_quota' }), ' credential_quota ']) {
    assert.equal(isKnownQuotaCooldownReason(reason), true, reason);
  }
  for (const reason of [undefined, '', 'null', '[]', '42', 'true', '{broken',
    'Refresh failed: credential_quota', JSON.stringify({ error: { code: 'invalid_token', message: 'credential_quota' } }),
    JSON.stringify({ error: 'credential_quota' }), JSON.stringify({ message: 'credential_quota' })]) {
    assert.equal(isKnownQuotaCooldownReason(reason), false, reason);
  }
});

test('an active known cooldown is consolidated without removing its full diagnostic', () => {
  const item = { ...quota, active_cooldown: { is_active: true, reason: knownReason }, error: 'Refresh failed' };
  assert.equal(compactCooldownDiagnostic(item), null);
  assert.equal(item.active_cooldown.reason, knownReason);
  assert.equal(item.error, 'Refresh failed');
});

test('unexpected cooldown and action failure reasons remain readable verbatim', () => {
  for (const reason of ['Upstream unavailable', 'Refresh failed: credential_quota', '{broken',
    JSON.stringify({ error: { code: 'invalid_token', message: 'Reauthorize' } })]) {
    assert.equal(compactCooldownDiagnostic({ ...quota, active_cooldown: { is_active: true, reason } }), reason);
  }
});

test('inactive or reasonless cooldowns do not create a duplicate banner', () => {
  assert.equal(compactCooldownDiagnostic(quota), null);
  assert.equal(compactCooldownDiagnostic({ ...quota, active_cooldown: { is_active: true } }), null);
  assert.equal(compactCooldownDiagnostic({ ...quota, active_cooldown: { is_active: true, reason: '  ' } }), null);
  assert.equal(compactCooldownDiagnostic({ ...quota, active_cooldown: { is_active: false, reason: 'Previous failure' } }), null);
});
