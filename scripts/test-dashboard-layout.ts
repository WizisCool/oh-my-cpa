/**
 * Logic-level tests for the dashboard's widget arrangement.
 *
 * What is decided without a DOM is asserted here: which stored values count as an arrangement, how a
 * widget a later release adds finds its place in an older one, and what moving, stepping, resizing
 * and hiding do to it. That the board actually draws the arrangement, that the editor writes it and
 * that a reload keeps it is the `dashboard-layout` browser probe's claim.
 */
import assert from 'node:assert/strict';
import {
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_LAYOUT,
  moveDashboardWidget,
  parseDashboardLayout,
  resizeDashboardWidget,
  sameDashboardLayout,
  setDashboardWidgetHidden,
  stepDashboardWidget,
  type DashboardLayout,
} from '../web/src/types/dashboardLayout.ts';

const ids = (layout: DashboardLayout) => layout.map((item) => item.id);
const defaultIds = DASHBOARD_WIDGETS.map((spec) => spec.id);
const item = (layout: DashboardLayout, id: string) => layout.find((entry) => entry.id === id)!;

// ── the default is the catalog ──────────────────────────────────────────────

assert.deepEqual(ids(DEFAULT_DASHBOARD_LAYOUT), defaultIds);
assert.ok(DEFAULT_DASHBOARD_LAYOUT.every((entry) => !entry.hidden), 'nothing is hidden by default');
for (const spec of DASHBOARD_WIDGETS) {
  assert.ok(spec.spans.includes(spec.defaultSpan), `${spec.id} offers its own default width`);
}

// ── the stored value is input, not state ────────────────────────────────────

assert.equal(parseDashboardLayout(null), undefined);
assert.equal(parseDashboardLayout(undefined), undefined);
assert.equal(parseDashboardLayout({ items: [] }), undefined, 'an object is not an arrangement');
assert.equal(parseDashboardLayout('requests'), undefined);
assert.ok(sameDashboardLayout(parseDashboardLayout([])!, DEFAULT_DASHBOARD_LAYOUT), 'an empty document reads as the default');

const stored = parseDashboardLayout([
  { id: 'providers', span: 4, hidden: false },
  { id: 'requests', span: 1, hidden: true },
  { id: 'requests', span: 4 },
  { id: 'gone_widget', span: 2 },
  'rpm',
  null,
  { id: 'routing', span: 1 },
  { id: 'cost', span: 2.5 },
  { id: 'tokens', span: 3, hidden: 'yes' },
])!;
assert.equal(ids(stored)[0], 'providers', 'a stored order is kept');
assert.equal(ids(stored)[1], 'requests');
assert.equal(item(stored, 'requests').span, 1);
assert.equal(item(stored, 'requests').hidden, true, 'a repeated entry keeps its first reading');
assert.equal(item(stored, 'routing').span, 3, 'a width the widget does not offer lands on the nearest one it does');
assert.equal(item(stored, 'cost').span, 1, 'a fractional width falls back to the default');
assert.equal(item(stored, 'tokens').hidden, false, 'only `true` hides a widget');
assert.equal(new Set(ids(stored)).size, defaultIds.length, 'every catalog widget appears exactly once');
assert.deepEqual([...ids(stored)].sort(), [...defaultIds].sort());

// A widget missing from an older document is placed after the widget that precedes it by default,
// and shown.
const older = parseDashboardLayout(
  DEFAULT_DASHBOARD_LAYOUT.filter((entry) => entry.id !== 'model_usage').map((entry) => ({ ...entry })).reverse(),
)!;
const trendIndex = ids(older).indexOf('model_trend');
assert.equal(ids(older)[trendIndex + 1], 'model_usage', 'a new widget follows its default predecessor');
assert.equal(item(older, 'model_usage').hidden, false, 'a new widget arrives visible');
const withoutFirst = parseDashboardLayout([{ id: 'providers', span: 4 }])!;
assert.equal(ids(withoutFirst)[0], 'requests', 'a missing widget with no predecessor present goes first');
assert.equal(ids(withoutFirst).at(-1), 'providers');

// ── moving ──────────────────────────────────────────────────────────────────

const moved = moveDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, 'providers', 'requests', 'before');
assert.deepEqual(ids(moved).slice(0, 2), ['providers', 'requests']);
assert.equal(moved.length, DEFAULT_DASHBOARD_LAYOUT.length);
assert.deepEqual(ids(moveDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, 'requests', 'tokens', 'after')).slice(0, 2), ['tokens', 'requests']);
assert.equal(moveDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, 'requests', 'requests', 'after'), DEFAULT_DASHBOARD_LAYOUT, 'a drop onto itself changes nothing');
assert.equal(moveDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, 'requests', 'tokens', 'before'), DEFAULT_DASHBOARD_LAYOUT, 'a drop that lands in place returns the same arrangement');

// Stepping skips what is not on screen.
const hiddenTokens = setDashboardWidgetHidden(DEFAULT_DASHBOARD_LAYOUT, 'tokens', true);
const stepped = stepDashboardWidget(hiddenTokens, 'requests', 1, (entry) => !entry.hidden);
assert.deepEqual(ids(stepped).slice(0, 3), ['tokens', 'rpm', 'requests'], 'a step passes over a hidden widget to the next shown one');
assert.equal(stepDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, 'requests', -1, () => true), DEFAULT_DASHBOARD_LAYOUT, 'the first widget cannot step earlier');
assert.equal(stepDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, 'providers', 1, () => true), DEFAULT_DASHBOARD_LAYOUT, 'the last widget cannot step later');
const phoneShown = (entry: { id: string }) => entry.id !== 'routing';
const aroundRouting = stepDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, 'token_activity', -1, phoneShown);
assert.deepEqual(ids(aroundRouting).slice(7, 10), ['token_activity', 'model_usage', 'routing'], 'a widget the viewport omits keeps its place relative to its neighbours');

// The live routing map sits under the row the two model panels share by default.
assert.deepEqual(defaultIds.slice(6, 9), ['model_trend', 'model_usage', 'routing']);

// ── resizing and hiding ─────────────────────────────────────────────────────

assert.equal(item(resizeDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, 'rpm', 3), 'rpm').span, 3);
assert.equal(resizeDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, 'routing', 1), DEFAULT_DASHBOARD_LAYOUT, 'a width the widget does not offer is refused');
assert.equal(item(hiddenTokens, 'tokens').hidden, true);
assert.equal(item(setDashboardWidgetHidden(hiddenTokens, 'tokens', false), 'tokens').hidden, false);
assert.ok(sameDashboardLayout(setDashboardWidgetHidden(hiddenTokens, 'tokens', false), DEFAULT_DASHBOARD_LAYOUT));
assert.ok(!sameDashboardLayout(hiddenTokens, DEFAULT_DASHBOARD_LAYOUT));

// The arrangement round-trips through its stored form.
const roundTrip = parseDashboardLayout(JSON.parse(JSON.stringify(moved)))!;
assert.ok(sameDashboardLayout(roundTrip, moved), 'a written arrangement reads back unchanged');

console.log('dashboard layout logic: ok');
