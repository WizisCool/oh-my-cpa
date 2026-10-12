import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveVersionPresentation, summarizeUpdateCheck } from '../web/src/pages/SystemPage/versionPresentation.ts';
import { isUpdateDismissed, listPendingUpdates, parseUpdateDismissals, withDismissal } from '../web/src/utils/updateDismissals.ts';
import type { SystemProductVersion } from '../web/src/types/system.ts';

function createVersion(overrides: Partial<SystemProductVersion> = {}): SystemProductVersion {
  return {
    product: 'omc', running_version: 'v1.0.0', latest_version: 'v1.1.0',
    state: 'update_available', reason: '', repository: 'owner/product', repository_url: 'https://github.com/owner/product',
    checked_at_ms: 1000, attempted_at_ms: 1000, check_error: '', checking: false,
    merge_count: 2, range_complete: true, notes_available: true, ...overrides,
  };
}

test('version states keep their verdict and do not repeat the release tag in the badge', () => {
  for (const [state, key, tone] of [
    ['update_available', 'sys.update_ready', 'accent'],
    ['up_to_date', 'sys.is_latest', 'success'],
    ['update_ahead', 'sys.update_ahead', 'neutral'],
  ] as const) {
    const presentation = deriveVersionPresentation(createVersion({ state }));
    assert.equal(presentation.statusKey, key);
    assert.equal(presentation.tone, tone);
  }
});

test('checking and failed checks take precedence over a cached comparison', () => {
  const version = createVersion({ check_error: 'feed unavailable' });
  assert.equal(deriveVersionPresentation(version).statusKey, 'sys.check_failed');
  assert.equal(deriveVersionPresentation(version).tone, 'warn');
  assert.equal(deriveVersionPresentation(version, true).statusKey, 'sys.checking_updates');
  assert.equal(deriveVersionPresentation({ ...version, checking: true }).statusKey, 'sys.checking_updates');
});

test('development-build explanation is separated from the concise status', () => {
  const presentation = deriveVersionPresentation(createVersion({ state: 'indeterminate', reason: 'running_version_not_comparable' }));
  assert.equal(presentation.statusKey, 'sys.indeterminate');
  assert.equal(presentation.detailKey, 'sys.reason_running_not_comparable');
  assert.equal(presentation.hasChangelog, true);
});

test('empty or unchecked feeds show their reason without a redundant notes notice or phantom log count', () => {
  for (const reason of ['no_releases_published', 'not_checked_yet'] as const) {
    const presentation = deriveVersionPresentation(createVersion({ state: 'indeterminate', reason, latest_version: '', merge_count: 0, notes_available: false }));
    assert.equal(presentation.hasChangelog, false);
    assert.equal(presentation.shouldShowNotesNotice, false);
    assert.equal(presentation.detailKey, '');
  }
});

test('known release range remains accessible after restart or a failed check', () => {
  const version = createVersion({ notes_available: false });
  assert.equal(deriveVersionPresentation(version).hasChangelog, true);
  assert.equal(deriveVersionPresentation(version).shouldShowNotesNotice, true);
  assert.equal(deriveVersionPresentation({ ...version, check_error: 'network' }).hasChangelog, true);
  assert.equal(deriveVersionPresentation({ ...version, check_error: 'network' }).shouldShowNotesNotice, false);
  assert.equal(deriveVersionPresentation(version, true).shouldShowNotesNotice, false);
  assert.equal(deriveVersionPresentation(createVersion({ merge_count: 0 })).hasChangelog, false);
});

test('HTTP success with per-product errors reports partial or complete failure, even when cached', () => {
  const healthy = createVersion();
  const failed = createVersion({ product: 'cpa', check_error: 'rate limited' });
  for (const isCached of [true, false]) {
    assert.deepEqual(summarizeUpdateCheck([healthy, failed], isCached), { kind: 'partial', failedProducts: ['cpa'] });
    assert.deepEqual(summarizeUpdateCheck([{ ...healthy, check_error: 'offline' }, failed], isCached), { kind: 'failed', failedProducts: ['omc', 'cpa'] });
  }
  assert.equal(summarizeUpdateCheck([healthy, { ...failed, check_error: '' }], true).kind, 'cached');
  assert.equal(summarizeUpdateCheck([healthy], false).kind, 'success');
  assert.equal(summarizeUpdateCheck([{ ...healthy, checking: true }], true).kind, 'checking');
});

test('a dismissal silences only the release it names', () => {
  const available = createVersion();
  assert.deepEqual(listPendingUpdates([available], {}), ['omc']);
  assert.equal(isUpdateDismissed(available, { omc: 'v1.1.0' }), true);
  assert.deepEqual(listPendingUpdates([available], { omc: 'v1.1.0' }), []);
  // A newer release than the dismissed one is announced again.
  assert.deepEqual(listPendingUpdates([createVersion({ latest_version: 'v1.2.0' })], { omc: 'v1.1.0' }), ['omc']);
  // Dismissals are per product.
  assert.deepEqual(listPendingUpdates([available, createVersion({ product: 'cpa' })], { omc: 'v1.1.0' }), ['cpa']);
});

test('only a known newer release is pending', () => {
  for (const state of ['up_to_date', 'update_ahead', 'indeterminate'] as const) {
    assert.deepEqual(listPendingUpdates([createVersion({ state })], {}), []);
    // A stored tag that happens to match must not read as a dismissed update.
    assert.equal(isUpdateDismissed(createVersion({ state }), { omc: 'v1.1.0' }), false);
  }
});

test('stored dismissals are read defensively and edited per product', () => {
  assert.equal(parseUpdateDismissals(undefined), undefined);
  assert.equal(parseUpdateDismissals(['v1.1.0']), undefined);
  assert.deepEqual(parseUpdateDismissals({ omc: 'v1.1.0', cpa: 7, other: 'v2' }), { omc: 'v1.1.0' });
  assert.deepEqual(withDismissal({ omc: 'v1.1.0' }, 'cpa', 'v6.0.0'), { omc: 'v1.1.0', cpa: 'v6.0.0' });
  assert.deepEqual(withDismissal({ omc: 'v1.1.0', cpa: 'v6.0.0' }, 'omc', null), { cpa: 'v6.0.0' });
});
