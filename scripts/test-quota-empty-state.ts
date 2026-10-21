import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaEmptyStateKey } from '../web/src/pages/quota/quotaFormat.ts';

/** The message a credential with no window carries, from the fields the card actually reads. */
function credential(overrides: {
  disabled?: boolean;
  refreshSupported?: boolean;
  status?: string;
  lastRefresh?: { attempted_at_ms: number; outcome: 'succeeded' | 'failed'; error?: string };
} = {}) {
  return {
    disabled: overrides.disabled ?? false,
    capabilities: { refresh_supported: overrides.refreshSupported ?? true },
    status: overrides.status ?? 'idle',
    ...(overrides.lastRefresh ? { last_refresh: overrides.lastRefresh } : {}),
  } as Parameters<typeof quotaEmptyStateKey>[0];
}

test('an empty reading and an unread credential do not share copy', () => {
  // The whole point of recording the empty reading: a credential whose provider answered without
  // publishing a window must not be told to repeat the read that just came back empty.
  const published = quotaEmptyStateKey(credential({ status: 'unpublished' }));
  const unread = quotaEmptyStateKey(credential({ status: 'idle' }));
  assert.equal(published, 'quota.usage_not_published');
  assert.equal(unread, 'quota.not_observed_yet');
  assert.notEqual(published, unread);
});

test('the reason a credential has no window decides the message', () => {
  // A disabled credential is not read at all, and a provider without a live probe has nothing to
  // read: neither may be described as an empty reading, whichever status it also carries.
  assert.equal(quotaEmptyStateKey(credential({ disabled: true, status: 'unpublished' })), 'quota.credential_disabled');
  assert.equal(
    quotaEmptyStateKey(credential({ refreshSupported: false, status: 'unpublished' })),
    'quota.no_live_probe',
  );
  // A credential that has a reading never reaches this decision, but a status it does not know still
  // resolves to the message that asks for one rather than to an empty claim.
  assert.equal(quotaEmptyStateKey(credential({ status: 'healthy' })), 'quota.not_observed_yet');
});

test('a failed read is not described as one nobody has asked for', () => {
  // The credential has no window because the read failed, not because nobody tried: telling the
  // reader to fetch it for the first time would hide the failure the row is reporting.
  const failed = quotaEmptyStateKey(credential({
    status: 'error',
    lastRefresh: { attempted_at_ms: 1_800_000_000_000, outcome: 'failed', error: 'HTTP 401: token expired' },
  }));
  assert.equal(failed, 'quota.reading_failed');
  assert.equal(quotaEmptyStateKey(credential({ status: 'idle' })), 'quota.not_observed_yet');
  assert.equal(
    quotaEmptyStateKey(credential({ status: 'error', lastRefresh: { attempted_at_ms: 1_800_000_000_000, outcome: 'succeeded' } })),
    'quota.not_observed_yet',
  );
});
