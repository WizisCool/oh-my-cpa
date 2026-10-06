import assert from 'node:assert/strict';
import {
  DASHBOARD_PRESETS,
  REQUEST_LIST_LONGEST_PRESET,
  dashboardRangeParams,
  isSlidingRange,
  parseDashboardRange,
  requestListPreset,
} from '../web/src/types/dashboard.ts';
import { EVENT_PRESETS, readEventQuery } from '../web/src/types/usageEventQuery.ts';

/**
 * The dashboard's all-time window against the request list's bounded one.
 *
 * The two surfaces share a picker but not a data source: the dashboard reads
 * permanent usage facts, the list reads request records that roll out of
 * retention. The all-time preset therefore exists on one side only, and the seam
 * between them - a stored preference, and the drill-down link - is where a preset
 * the other side does not know would turn into a silently different window.
 */
assert.deepEqual(parseDashboardRange({ preset: 'all' }), { preset: 'all' }, 'a stored all-time range survives a reload');
assert.equal(parseDashboardRange({ preset: 'forever' }), undefined, 'an unknown preset falls back to the default');
assert.equal(dashboardRangeParams({ preset: 'all' }), 'preset=all', 'the server resolves the all-time window, so no bounds are sent');
assert.equal(isSlidingRange({ preset: 'all' }), true, 'the all-time window ends at now and keeps polling');

assert.ok(REQUEST_LIST_LONGEST_PRESET in EVENT_PRESETS, 'the drill-down target is a preset the request list offers');
assert.equal(
  EVENT_PRESETS[REQUEST_LIST_LONGEST_PRESET],
  Math.max(...Object.values(EVENT_PRESETS)),
  'the drill-down target is the longest one',
);
for (const preset of DASHBOARD_PRESETS) {
  const target = requestListPreset(preset);
  const query = readEventQuery(new URLSearchParams({ preset: target }));
  // readEventQuery replaces a preset it does not know with its default, which
  // is how a drill-down would open on one hour without saying so.
  assert.equal(query.preset, target, `the ${preset} drill-down opens the window it names`);
  if (preset !== 'all') assert.equal(target, preset, `${preset} drills down to the same window`);
}

console.log(`dashboard range: ${6 + DASHBOARD_PRESETS.length} cases passed`);
