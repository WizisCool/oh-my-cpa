/**
 * Pure-logic tests for the request-record view's URL, debounce, polling, mapping
 * and refresh-presentation policies.
 *
 * These rules used to be reachable only by driving Chromium through a running Go
 * binary, a fake CPA and a built SPA. Each one is a decision the page makes about
 * the operator's own input, so it can be pinned directly against the module the
 * page calls.
 *
 * The negative cases matter as much as the positive ones. Two of these functions
 * exist solely to prevent a specific regression (a cleared filter resurrected from
 * the previous query, and a queued keystroke outliving the view it was typed
 * against), so both are asserted from the failing side as well: the test kills the
 * behaviour that used to be wrong, not merely the behaviour that is now right.
 */
import assert from 'node:assert/strict';
import {
  applyTimeWindow,
  clearAllFilters,
  mergeFilters,
  replaceFilters,
  viewPreferenceFromUrl,
} from '../web/src/types/usageEventViewActions.ts';
import {
  createSearchDebounce,
  type SearchDebounceController,
} from '../web/src/components/usage/searchDebounce.ts';
import {
  isListStale,
  isViewChange,
  pendingArrivalCount,
  shouldPoll,
} from '../web/src/components/usage/pollingPolicy.ts';
import {
  presetMenuKeys,
  QUICK_PRESETS,
  rangeErrorKey,
  selectedPresetKeys,
  splitPresets,
  validateAbsoluteRange,
} from '../web/src/components/usage/timeRangePolicy.ts';
import {
  REFRESH_READS,
  shouldAnnounceStuckSync,
  syncOutcomeMessage,
  syncShortfallReason,
} from '../web/src/components/usage/syncPresentation.ts';
import { chipDisplayValue } from '../web/src/components/usage/chipDisplay.ts';
import { EVENT_PRESETS } from '../web/src/types/usageEventView.ts';

let checks = 0;
function test(name: string, run: () => void) {
  run();
  checks += 1;
  console.log(`PASS ${name}`);
}

// ---------------------------------------------------------------------------
// replaceFilters: a filter edit rewrites only the filter dimensions
// ---------------------------------------------------------------------------

test('a filter edit replaces the dimension it names and leaves the window alone', () => {
  const before = new URLSearchParams('preset=24h&limit=250&model=o3&provider=openai');
  const after = replaceFilters(before, { provider: ['openai'], model: ['gpt-5'] });
  assert.deepEqual(after.getAll('model'), ['gpt-5']);
  assert.deepEqual(after.getAll('provider'), ['openai']);
  assert.equal(after.get('preset'), '24h');
  assert.equal(after.get('limit'), '250');
});

test('a filter edit can remove a dimension, which a merge could not express', () => {
  const before = new URLSearchParams('preset=24h&model=o3&provider=openai');
  // Absence, not an empty value, is how "this dimension is not filtering" is
  // expressed. A key-by-key merge would have left `model=o3` in place.
  const after = replaceFilters(before, { provider: ['openai'] });
  assert.equal(after.get('model'), null);
  assert.deepEqual(after.getAll('provider'), ['openai']);
});

test('multiple values inside one dimension survive as repeated parameters', () => {
  const after = replaceFilters(new URLSearchParams('preset=1h'), {
    model: ['vendor,inc/gpt-5', 'o3'],
  });
  assert.deepEqual(after.getAll('model'), ['vendor,inc/gpt-5', 'o3']);
});

test('a result verdict is committed, and "all" removes it rather than storing it', () => {
  const failed = replaceFilters(new URLSearchParams('preset=1h'), {}, { result: 'failed' });
  assert.equal(failed.get('result'), 'failed');
  // The default verdict is spelled by the parameter's absence, so a URL that
  // returns to it is identical to one that never carried it.
  const restored = replaceFilters(failed, {}, { result: 'all' });
  assert.equal(restored.get('result'), null);
  // Omitting the option leaves the verdict untouched.
  assert.equal(replaceFilters(failed, {}, {}).get('result'), 'failed');
});

test('a filter edit never touches the pagination cursor it is about to invalidate', () => {
  // Dropping the cursor is the page's decision (a cursor minted against another
  // result set cannot be reused), not something a filter rewrite does silently.
  const before = new URLSearchParams('preset=1h&cursor=abc&model=o3');
  assert.equal(replaceFilters(before, { provider: ['openai'] }).get('cursor'), 'abc');
});

// ---------------------------------------------------------------------------
// clearAllFilters: filters go, the window and layout stay
// ---------------------------------------------------------------------------

test('clear-all removes every filter and the verdict but keeps window and page size', () => {
  const before = new URLSearchParams(
    'preset=24h&limit=250&cost=unpriced&model=gpt-5-codex&result=failed&q=needle',
  );
  const after = clearAllFilters(before);
  assert.equal(after.get('model'), null);
  assert.equal(after.get('cost'), null);
  assert.equal(after.get('q'), null);
  assert.equal(after.get('result'), null);
  // The window and page size are the reader's position, not a filter: resetting
  // them would move the reader to a different hour without saying so.
  assert.equal(after.get('preset'), '24h');
  assert.equal(after.get('limit'), '250');
});

test('clear-all leaves an explicitly chosen absolute window in place', () => {
  const after = clearAllFilters(new URLSearchParams('from=100&to=200&model=o3'));
  assert.equal(after.get('from'), '100');
  assert.equal(after.get('to'), '200');
  assert.equal(after.get('model'), null);
});

// ---------------------------------------------------------------------------
// applyTimeWindow
// ---------------------------------------------------------------------------

test('a preset replaces an absolute range instead of stacking beside it', () => {
  const after = applyTimeWindow(new URLSearchParams('from=100&to=200&model=o3'), { preset: '1h' });
  assert.equal(after.get('preset'), '1h');
  assert.equal(after.get('from'), null);
  assert.equal(after.get('to'), null);
  assert.equal(after.get('model'), 'o3');
});

test('an absolute range replaces a preset, and an open end is expressible', () => {
  const closed = applyTimeWindow(new URLSearchParams('preset=1h'), { from: 100, to: 200 });
  assert.equal(closed.get('preset'), null);
  assert.equal(closed.get('from'), '100');
  assert.equal(closed.get('to'), '200');
  const openEnded = applyTimeWindow(new URLSearchParams('preset=1h&to=50'), { from: 100 });
  assert.equal(openEnded.get('from'), '100');
  assert.equal(openEnded.get('to'), null);
});

// ---------------------------------------------------------------------------
// mergeFilters
// ---------------------------------------------------------------------------

test('setting, widening and clearing one dimension all express themselves as absence or values', () => {
  const committed = { model: ['o3'], provider: ['openai'] };
  assert.deepEqual(mergeFilters(committed, 'q', ['needle']), {
    model: ['o3'],
    provider: ['openai'],
    q: ['needle'],
  });
  assert.deepEqual(mergeFilters(committed, 'model', ['o3', 'gpt-5']).model, ['o3', 'gpt-5']);
  assert.deepEqual(mergeFilters(committed, 'model', []), { provider: ['openai'] });
  // The committed map is the caller's; a spread that mutated it would make the
  // next read disagree with the URL.
  assert.deepEqual(committed, { model: ['o3'], provider: ['openai'] });
});

// ---------------------------------------------------------------------------
// viewPreferenceFromUrl: the saved view follows the URL actually navigated to
// ---------------------------------------------------------------------------

test('the saved view is derived from the navigated URL, not merged from the previous query', () => {
  const current = { grouping: 'time' as const, autoRefresh: false };
  // `model` is absent from the URL because the operator just cleared it. Deriving
  // every field from this state is what stops the cleared value being read back
  // out of the previous query and resurrected on the next visit.
  const pref = viewPreferenceFromUrl(
    new URLSearchParams('preset=24h&limit=250&provider=openai&result=failed&cost=unpriced'),
    current,
  );
  assert.equal(pref.preset, '24h');
  assert.equal(pref.limit, 250);
  assert.equal(pref.result, 'failed');
  assert.equal(pref.cost, 'unpriced');
  assert.equal(pref.filterValues?.model, undefined);
  assert.deepEqual(pref.filterValues?.provider, ['openai']);
});

test('a cleared filter is absent from the saved view rather than stored empty', () => {
  const pref = viewPreferenceFromUrl(new URLSearchParams('preset=1h'), {
    grouping: 'time',
    autoRefresh: false,
  });
  // No `filterValues` key at all: an empty map and an absent one would both be
  // read back as "not filtering", but only absence keeps the stored document
  // from growing a key per dimension the operator ever touched.
  assert.equal(pref.filterValues, undefined);
});

test('cost is stored once, as its own field, and never inside the filter map', () => {
  const pref = viewPreferenceFromUrl(new URLSearchParams('preset=1h&cost=unpriced'), {
    grouping: 'time',
    autoRefresh: false,
  });
  assert.equal(pref.cost, 'unpriced');
  // Keeping it in both was a second source of truth that hydration wrote back
  // into the URL a second time.
  assert.equal(pref.filterValues?.cost, undefined);
});

test('the saved view carries the layout choices it was given, not the URL defaults', () => {
  const pref = viewPreferenceFromUrl(new URLSearchParams('preset=1h'), {
    grouping: 'source',
    autoRefresh: true,
  });
  assert.equal(pref.grouping, 'source');
  assert.equal(pref.autoRefresh, true);
});

test('an absolute window is saved as bounds, and an open-ended one keeps only its start', () => {
  const closed = viewPreferenceFromUrl(new URLSearchParams('from=100&to=200'), {
    grouping: 'time',
    autoRefresh: false,
  });
  assert.equal(closed.from, 100);
  assert.equal(closed.to, 200);
  assert.equal(closed.preset, undefined);

  const openEnded = viewPreferenceFromUrl(new URLSearchParams('from=100'), {
    grouping: 'time',
    autoRefresh: false,
  });
  assert.equal(openEnded.from, 100);
  assert.equal(openEnded.to, undefined);
  // A preset is not written alongside a range: the two are mutually exclusive.
  assert.equal(openEnded.preset, undefined);
});

test('an absent window falls back to the default preset rather than to bounds', () => {
  const pref = viewPreferenceFromUrl(new URLSearchParams('model=o3'), {
    grouping: 'time',
    autoRefresh: false,
  });
  assert.equal(pref.preset, '1h');
  assert.equal(pref.from, undefined);
});

// ---------------------------------------------------------------------------
// The debounced search box
// ---------------------------------------------------------------------------

/** A scheduler that runs nothing until the test says so, and counts cancellations. */
function manualClock() {
  const queue: Array<{ handle: number; callback: () => void }> = [];
  const cancelled: number[] = [];
  let nextHandle = 1;
  return {
    schedule: (callback: () => void) => {
      const handle = nextHandle++;
      queue.push({ handle, callback });
      return handle;
    },
    cancelScheduled: (handle: unknown) => {
      cancelled.push(handle as number);
      const index = queue.findIndex((entry) => entry.handle === handle);
      if (index >= 0) queue.splice(index, 1);
    },
    /** Runs every timer that is still armed. */
    fire: () => {
      const pending = [...queue];
      queue.length = 0;
      for (const entry of pending) entry.callback();
    },
    pendingCount: () => queue.length,
    cancelled,
  };
}

function makeDebounce(clock: ReturnType<typeof manualClock>): SearchDebounceController {
  return createSearchDebounce({
    delayMs: 350,
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  });
}

test('a keystroke is committed once the window elapses', () => {
  const clock = manualClock();
  const search = makeDebounce(clock);
  const commits: string[] = [];
  search.change('gpt', (value) => commits.push(value));
  assert.equal(clock.pendingCount(), 1);
  clock.fire();
  assert.deepEqual(commits, ['gpt']);
});

test('typing back to the committed value schedules nothing', () => {
  const clock = manualClock();
  const search = makeDebounce(clock);
  search.sync('gpt');
  const commits: string[] = [];
  search.change('gpt', (value) => commits.push(value));
  assert.equal(clock.pendingCount(), 0);
  clock.fire();
  assert.deepEqual(commits, []);
});

test('the commit reads the latest callback, not the one captured when it was scheduled', () => {
  // This is the regression: a commit builds its URL from the render it was created
  // in, so firing the timer against an older closure erased a filter that had been
  // changed during the debounce window.
  const clock = manualClock();
  const search = makeDebounce(clock);
  const seen: string[] = [];
  search.change('gpt', () => seen.push('stale-render'));
  clock.fire();
  assert.deepEqual(seen, ['stale-render']);

  // The same timer, scheduled under a later render, must call the later callback.
  const seen2: string[] = [];
  search.change('o3', () => seen2.push('old-render'));
  search.change('o3', () => seen2.push('new-render'));
  clock.fire();
  assert.deepEqual(seen2, ['new-render']);
});

test('an invalidation suppresses a callback that already fired but has not run', () => {
  // The window this covers: the timer fires, and a clear-all lands before the
  // callback body runs. Cancelling the timer alone could not reach it, which is
  // why the controller compares a generation instead of only clearing a handle.
  //
  // The interleaving is produced by running the timer's callback from inside the
  // invalidation, so the generation has already advanced by the time it executes.
  const queue: Array<() => void> = [];
  const search = createSearchDebounce({
    delayMs: 350,
    schedule: (callback) => {
      queue.push(callback);
      return queue.length - 1;
    },
    cancelScheduled: () => {
      // Deliberately a no-op: this test is about a callback that is already past
      // cancellation, so the handle-based path must not be what saves it.
    },
  });
  const commits: string[] = [];
  search.change('gpt', (value) => commits.push(value));
  assert.equal(queue.length, 1);
  search.invalidate();
  for (const callback of queue) callback();
  assert.deepEqual(commits, [], 'an invalidated keystroke must not reach the URL');
});

test('an invalidation reached through the controller suppresses a queued commit', () => {
  const clock = manualClock();
  const search = makeDebounce(clock);
  const commits: string[] = [];
  search.change('needle', (value) => commits.push(value));
  search.invalidate();
  assert.equal(clock.pendingCount(), 0, 'the timer is cancelled outright');
  clock.fire();
  assert.deepEqual(commits, []);
});

test('adopting an external committed value cancels the queued keystroke', () => {
  // Hydration from the saved view, Back/Forward or a drill-down: the queued text
  // belongs to the view that was just left.
  const clock = manualClock();
  const search = makeDebounce(clock);
  const commits: string[] = [];
  search.change('stale-typing', (value) => commits.push(value));
  search.sync('navigated');
  assert.equal(search.committed(), 'navigated');
  clock.fire();
  assert.deepEqual(commits, []);
});

test('a keystroke after an external navigation commits against the new view', () => {
  const clock = manualClock();
  const search = makeDebounce(clock);
  const commits: string[] = [];
  search.sync('alpha');
  search.change('beta', (value) => commits.push(value));
  clock.fire();
  assert.deepEqual(commits, ['beta']);
});

test('a disposed controller commits nothing', () => {
  const clock = manualClock();
  const search = makeDebounce(clock);
  const commits: string[] = [];
  search.change('gpt', (value) => commits.push(value));
  search.dispose();
  clock.fire();
  assert.deepEqual(commits, []);
  // A keystroke on a disposed controller is dropped rather than arming a timer
  // nothing will cancel.
  search.change('after-dispose', (value) => commits.push(value));
  assert.equal(clock.pendingCount(), 0);
});

// ---------------------------------------------------------------------------
// The polling decision
// ---------------------------------------------------------------------------

test('a tick runs only when the switch is on, the tab is visible and nothing else is reading', () => {
  assert.equal(
    shouldPoll({ isAutoRefresh: true, isVisible: true, isFetching: false, isSyncing: false }),
    true,
  );
});

test('every reason to skip a tick is honoured', () => {
  const base = { isAutoRefresh: true, isVisible: true, isFetching: false, isSyncing: false };
  assert.equal(shouldPoll({ ...base, isAutoRefresh: false }), false, 'off means no ticks');
  assert.equal(shouldPoll({ ...base, isVisible: false }), false, 'a hidden tab has no reader');
  assert.equal(shouldPoll({ ...base, isFetching: true }), false, 'a slow query cannot stack reads');
  assert.equal(shouldPoll({ ...base, isSyncing: true }), false, 'a sync owns the next refresh');
});

test('the cadence is not a round-trip afterthought', () => {
  // The tick fires on the interval regardless of how long the previous read took;
  // the in-flight guard skips a tick rather than delaying the schedule. That is
  // the difference between a 10s cadence and "10s after the last response".
  const base = { isAutoRefresh: true, isVisible: true, isSyncing: false };
  assert.equal(shouldPoll({ ...base, isFetching: true }), false, 'a busy read skips this tick');
  assert.equal(shouldPoll({ ...base, isFetching: false }), true, 'the next tick still runs on schedule');
});

test('a poll is not a view change, but moving to another page or filter set is', () => {
  const identity = 'preset=1h&model=o3:cursor-a';
  assert.equal(isViewChange(identity, identity), false);
  assert.equal(isViewChange('preset=1h&model=o3:', 'preset=1h&model=o3:cursor-a'), true);
});

test('rows are marked stale for a view change or for a failed query over a retained page', () => {
  assert.equal(isListStale({ isViewChange: false, isError: false, hasLastPage: false }), false);
  assert.equal(isListStale({ isViewChange: true, isError: false, hasLastPage: false }), true);
  // A failed query with nothing retained has no stale rows to warn about; the
  // error surface owns that case.
  assert.equal(isListStale({ isViewChange: false, isError: true, hasLastPage: false }), false);
  assert.equal(isListStale({ isViewChange: false, isError: true, hasLastPage: true }), true);
});

test('the arrival count is reported only while the reader is holding rows', () => {
  // At the live edge the arriving records are simply part of the list.
  assert.equal(pendingArrivalCount(0, 7), 0);
  assert.equal(pendingArrivalCount(50, 7), 7);
  // No server count is zero, not "unknown": the pill must not promise records it
  // cannot name.
  assert.equal(pendingArrivalCount(50, undefined), 0);
});

// ---------------------------------------------------------------------------
// The time-window picker
// ---------------------------------------------------------------------------

test('every configured preset appears exactly once, whichever one is selected', () => {
  // The regression: filtering the selected value out of its own group removed the
  // current choice from the menu, so the operator could not see or return to it.
  const keys = presetMenuKeys();
  assert.equal(new Set(keys).size, keys.length, 'no preset is offered twice');
  assert.equal(keys.length, Object.keys(EVENT_PRESETS).length, 'no preset is missing');
  for (const preset of Object.keys(EVENT_PRESETS)) {
    assert.ok(keys.includes(`preset:${preset}`), `${preset} is offered`);
  }
});

test('the quick group and the rest partition the presets without overlap', () => {
  const { quick, slow } = splitPresets();
  assert.deepEqual(quick, QUICK_PRESETS.filter((value) => value in EVENT_PRESETS));
  assert.equal(quick.some((value) => slow.includes(value)), false);
  assert.equal(quick.length + slow.length, Object.keys(EVENT_PRESETS).length);
});

test('the menu marks the committed window, absolute or preset', () => {
  assert.deepEqual(selectedPresetKeys(false, '1h'), ['preset:1h']);
  assert.deepEqual(selectedPresetKeys(true, '1h'), ['absolute']);
});

test('a complete past range can be applied', () => {
  const now = 1_000_000;
  assert.deepEqual(validateAbsoluteRange([now - 60_000, now - 1_000], now), {
    isValid: true,
    errorKey: undefined,
  });
});

test('an unfinished range blocks Apply without being reported as an error', () => {
  const now = 1_000_000;
  assert.equal(validateAbsoluteRange([null, now], now).errorKey, 'incomplete');
  assert.equal(validateAbsoluteRange([now - 1, null], now).isValid, false);
});

test('a reversed or equal range is refused', () => {
  const now = 1_000_000;
  assert.equal(validateAbsoluteRange([now - 1_000, now - 60_000], now).errorKey, 'reversed');
  // Equal ends would be rejected by the server as a malformed window, so they are
  // refused here rather than sent as a request that cannot succeed.
  assert.equal(validateAbsoluteRange([now - 1_000, now - 1_000], now).errorKey, 'reversed');
});

test('a range reaching past now is refused', () => {
  const now = 1_000_000;
  assert.equal(validateAbsoluteRange([now - 1_000, now + 1], now).errorKey, 'future');
  assert.equal(validateAbsoluteRange([now + 1, now + 1_000], now).errorKey, 'future');
});

test('the validation outcome maps to the message key the picker renders', () => {
  assert.equal(rangeErrorKey('reversed'), 'events.range_reversed');
  assert.equal(rangeErrorKey('future'), 'events.range_in_future');
  // Incomplete is not an error message: the operator has not finished choosing.
  assert.equal(rangeErrorKey('incomplete'), undefined);
});

// ---------------------------------------------------------------------------
// Refresh presentation
// ---------------------------------------------------------------------------

test('a disabled collector is information, not a failure', () => {
  assert.deepEqual(syncOutcomeMessage({ enabled: false, synced: false }), {
    tone: 'info',
    key: 'events.sync_disabled',
  });
});

test('a drained pull reports how much it stored, and a zero is still a success', () => {
  assert.deepEqual(syncOutcomeMessage({ enabled: true, synced: true, captured: 2 }), {
    tone: 'success',
    key: 'events.sync_success',
    vars: { n: 2 },
  });
  assert.deepEqual(syncOutcomeMessage({ enabled: true, synced: true, captured: 0 }), {
    tone: 'success',
    key: 'events.sync_confirmed',
  });
});

test('a pull that could not drain CPA is reported as incomplete rather than successful', () => {
  // The reported bug: "the request completed" was treated as "the records were
  // fetched", so a shortfall was shown as a success.
  const message = syncOutcomeMessage({ enabled: true, synced: false, error: 'connection refused' });
  assert.equal(message.tone, 'warning');
  assert.equal(message.key, 'events.sync_incomplete');
});

test('a rejected management key is named separately from a transient shortfall', () => {
  // The operator's remedy is different: the key is wrong, not the gateway busy.
  assert.deepEqual(syncOutcomeMessage({ enabled: true, synced: false, auth_rejected: true }), {
    tone: 'warning',
    key: 'events.sync_auth_rejected',
  });
});

test('a shortfall with no reported reason falls back to the dictionary string', () => {
  assert.equal(syncShortfallReason({ enabled: true, synced: false }, 'unknown'), 'unknown');
  assert.equal(
    syncShortfallReason({ enabled: true, synced: false, error: 'refused' }, 'unknown'),
    'refused',
  );
});

test('a sync is only announced as stuck while it is both running and overdue', () => {
  assert.equal(shouldAnnounceStuckSync(true, true), true);
  assert.equal(shouldAnnounceStuckSync(true, false), false);
  assert.equal(shouldAnnounceStuckSync(false, true), false);
});

test('a completed refresh re-reads every surface the pull could have changed', () => {
  // Pre- and post-sync data must never be mixed on screen, and the list is first
  // because it is the surface the operator was looking at.
  assert.deepEqual(REFRESH_READS, ['list', 'facets', 'ingest-status']);
});

// ---------------------------------------------------------------------------
// Chip display mapping
// ---------------------------------------------------------------------------

const chipBase = {
  credentialNames: new Map<string, string | undefined>([['auth-a', 'team.json']]),
  callerFacets: [
    { value: 'fp-1', requests: 3, alias: '验收专用密钥', mask: 'sk-1234••••7890' },
    { value: 'fp-2', requests: 1, mask: 'sk-abcd••••wxyz' },
    { value: 'fp-3', requests: 1 },
  ],
  resolveProviderName: (value: string) => (value === 'codex-0' ? 'My Codex Line' : value),
  costLabels: { priced: 'Priced', unpriced: 'Unpriced' },
};

test('a credential chip shows the file name rather than the stored fingerprint', () => {
  assert.equal(chipDisplayValue({ ...chipBase, key: 'auth_index', value: 'auth-a' }), 'team.json');
  // An unresolvable fingerprint still shows something rather than a blank chip.
  assert.equal(chipDisplayValue({ ...chipBase, key: 'auth_index', value: 'auth-z' }), 'auth-z');
});

test('a caller chip prefers the alias, then the mask, then the raw fingerprint', () => {
  assert.equal(chipDisplayValue({ ...chipBase, key: 'api_key', value: 'fp-1' }), '验收专用密钥');
  assert.equal(chipDisplayValue({ ...chipBase, key: 'api_key', value: 'fp-2' }), 'sk-abcd••••wxyz');
  // A key with neither falls back to the value it filters on, so the chip can
  // still be removed.
  assert.equal(chipDisplayValue({ ...chipBase, key: 'api_key', value: 'fp-3' }), 'fp-3');
});

test('a provider chip is labelled with the operator name while filtering on the stored key', () => {
  assert.equal(chipDisplayValue({ ...chipBase, key: 'provider', value: 'codex-0' }), 'My Codex Line');
  assert.equal(chipDisplayValue({ ...chipBase, key: 'provider', value: 'claude' }), 'claude');
});

test('the cost state is named in the reader language, and cost bounds carry their sign', () => {
  assert.equal(chipDisplayValue({ ...chipBase, key: 'cost', value: 'unpriced' }), 'Unpriced');
  assert.equal(chipDisplayValue({ ...chipBase, key: 'cost', value: 'priced' }), 'Priced');
  assert.equal(chipDisplayValue({ ...chipBase, key: 'cost_min', value: '12.5' }), '$12.5');
  // A latency bound is already milliseconds; only the label carries the unit.
  assert.equal(chipDisplayValue({ ...chipBase, key: 'latency_min', value: '30000' }), '30000');
});

test('a plain text dimension is shown exactly as it was committed', () => {
  assert.equal(chipDisplayValue({ ...chipBase, key: 'q', value: 'retired-alias' }), 'retired-alias');
  assert.equal(chipDisplayValue({ ...chipBase, key: 'model', value: 'gpt-5-codex' }), 'gpt-5-codex');
});

console.log(`\n${checks} view-policy suites passed.`);
