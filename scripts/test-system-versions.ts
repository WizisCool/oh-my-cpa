import assert from 'node:assert/strict';
import test from 'node:test';
import { UPDATE_STAGE_ORDER, deriveUpdateOffer, deriveVersionPresentation, summarizeUpdateCheck } from '../web/src/pages/SystemPage/versionPresentation.ts';
import { isUpdateDismissed, listPendingUpdates, parseUpdateDismissals, withDismissal } from '../web/src/utils/updateDismissals.ts';
import type { SystemProductVersion, SystemUpdateJob, SystemUpdaterResponse } from '../web/src/types/system.ts';

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

function createUpdater(overrides: Partial<SystemUpdaterResponse> = {}): SystemUpdaterResponse {
  return {
    state: 'ready',
    products: [
      { product: 'omc', action: 'available', reason: '', image: 'wiziscool/oh-my-cpa:latest' },
      { product: 'cpa', action: 'unavailable', reason: 'pinned', image: 'eceasy/cli-proxy-api:v8.0.1' },
    ],
    job: null,
    ...overrides,
  };
}

function createJob(overrides: Partial<SystemUpdateJob> = {}): SystemUpdateJob {
  return {
    id: 'job-1', product: 'omc', stage: 'starting', finished: false, error: '',
    from_version: 'v1.0.0', to_version: '', started_at_ms: 1000, finished_at_ms: 0, ...overrides,
  };
}

test('an update is offered only for a newer release on a deployment with a working updater', () => {
  const version = createVersion();
  assert.deepEqual(deriveUpdateOffer(version, createUpdater(), 'omc'), { kind: 'available', isBusy: false });
  assert.deepEqual(deriveUpdateOffer(createVersion({ state: 'up_to_date' }), createUpdater(), 'omc'), { kind: 'none' });
  assert.deepEqual(deriveUpdateOffer(version, undefined, 'omc'), { kind: 'none' });
  for (const state of ['not_installed', 'not_containerised', 'disabled', 'rejected'] as const) {
    assert.deepEqual(deriveUpdateOffer(version, createUpdater({ state }), 'omc'), { kind: 'none' }, state);
  }
  assert.deepEqual(deriveUpdateOffer(version, createUpdater({ products: [] }), 'omc'), { kind: 'none' });
});

test('a blocked product names its reason and image, and only when there is something to install', () => {
  const version = createVersion({ product: 'cpa' });
  assert.deepEqual(deriveUpdateOffer(version, createUpdater(), 'cpa'), {
    kind: 'blocked', reasonKey: 'sys.update_blocked.pinned', image: 'eceasy/cli-proxy-api:v8.0.1',
  });
  assert.deepEqual(deriveUpdateOffer(createVersion({ product: 'cpa', state: 'up_to_date' }), createUpdater(), 'cpa'), { kind: 'none' });
  const unidentified = createUpdater({ products: [{ product: 'cpa', action: 'unavailable', reason: 'ambiguous_container', image: '' }] });
  assert.equal((deriveUpdateOffer(version, unidentified, 'cpa') as { reasonKey: string }).reasonKey, 'sys.update_blocked.unidentified');
});

test('a running update shows its stage on its own product and holds the other one back', () => {
  const updater = createUpdater({
    products: [
      { product: 'omc', action: 'available', reason: '', image: 'wiziscool/oh-my-cpa:latest' },
      { product: 'cpa', action: 'available', reason: '', image: 'eceasy/cli-proxy-api:latest' },
    ],
    job: createJob({ product: 'cpa', stage: 'verifying' }),
  });
  // The comparison is stale while the container is being replaced, so it is not consulted.
  assert.deepEqual(deriveUpdateOffer(createVersion({ product: 'cpa', state: 'up_to_date' }), updater, 'cpa'), {
    kind: 'running', stage: 'verifying', stageKey: 'sys.update_stage.verifying',
  });
  assert.deepEqual(deriveUpdateOffer(createVersion(), updater, 'omc'), { kind: 'available', isBusy: true });
  const finished = { ...updater, job: createJob({ product: 'cpa', stage: 'rolled_back', finished: true }) };
  assert.deepEqual(deriveUpdateOffer(createVersion({ product: 'cpa' }), finished, 'cpa'), { kind: 'available', isBusy: false });
});

test('a running update reports the step it has reached, in the order the updater reports', () => {
  const updater = createUpdater({ job: createJob({ product: 'omc', stage: 'stopping' }) });
  assert.deepEqual(deriveUpdateOffer(createVersion(), updater, 'omc'), {
    kind: 'running', stage: 'stopping', stageKey: 'sys.update_stage.stopping',
  });
  // A stage this build does not know is drawn as the first step rather than as no progress: the
  // job is running, and the bar and the sentence beside it both fall back to the opening stage.
  const unknown = createUpdater({ job: createJob({ product: 'omc', stage: 'draining' as unknown as SystemUpdateJob['stage'] }) });
  assert.deepEqual(deriveUpdateOffer(createVersion(), unknown, 'omc'), {
    kind: 'running', stage: 'pulling', stageKey: 'sys.update_stage.pulling',
  });
  assert.deepEqual([...UPDATE_STAGE_ORDER], ['pulling', 'stopping', 'starting', 'verifying']);
});
