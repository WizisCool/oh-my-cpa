/**
 * Tests for the `check:ui` scenario planner.
 *
 * Two families of property matter here, and they pull in opposite directions.
 *
 * **Narrowing must be real.** If every change ran every scenario the fast path would
 * cost the same as the release gate and there would be no point to it. So the common
 * cases are asserted to select a specific, small set.
 *
 * **Narrowing must never be silent.** The dangerous failure is not a slow plan, it is
 * a fast one that skipped the scenario which would have caught the bug. Every rule
 * that widens - the shared layer, an unrecognised frontend path, the probe framework
 * itself - is therefore asserted from the failing side: a plan that omitted those
 * would be a green run that verified nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planScenarios } from './acceptance/check-ui-plan.mjs';
import { SCENARIOS } from './acceptance/scenarios.mjs';

const ALL = SCENARIOS.map((scenario) => scenario.id);

/** The selected scenario ids for one changed file. */
const planFor = (file) => planScenarios([file], ALL).ids;

test('every scenario has a stable id and a run function', () => {
  // The ids are addressed by `--scenario` and by this planner, so a duplicate or an
  // absent id would make a scenario unreachable rather than merely misnamed.
  assert.equal(new Set(ALL).size, ALL.length, 'ids are unique');
  for (const scenario of SCENARIOS) {
    assert.ok(scenario.id, `${scenario.name} has an id`);
    assert.ok(scenario.name, `${scenario.id} has a name`);
    assert.equal(typeof scenario.run, 'function', `${scenario.id} is runnable`);
  }
});

test('the four request-records concerns select only their own scenarios', () => {
  // This is the page whose feedback cost the most in practice, so it is the one where
  // narrowing has to actually pay off.
  assert.deepEqual(
    planFor('web/src/pages/UsageEventsPage.tsx').sort(),
    ['column-alignment', 'refresh-sequencing', 'request-list-interactions', 'search-dev-server'],
  );
});

test('a dashboard change selects every dashboard scenario', () => {
  // Registry order, which is the order the plan preserves and the order `--list` prints.
  const all = [
    'dashboard-charts', 'dashboard-chart-motion', 'dashboard-rolling-readouts', 'dashboard-model-panels',
    'dashboard-model-panels-states', 'dashboard-model-panels-failure', 'dashboard-model-panels-empty',
    'dashboard-heatmap', 'dashboard-heatmap-pruned', 'dashboard-heatmap-mobile', 'dashboard-heatmap-error',
  ];
  assert.deepEqual(planFor('web/src/pages/DashboardPage.tsx'), all);
  assert.deepEqual(planFor('web/src/components/dashboard/TokenHeatmap.tsx'), all);
  // The readout contract is a panel of the same page, and the OMC settings scenario reads the same
  // tiles back when it asserts the unit style they print in - so this path reaches one scenario more
  // than the page's own rule does.
  assert.deepEqual(planFor('web/src/types/rollingNumber.ts'), ['omc-settings', ...all]);
  // The strip's own layout and ramp logic is only read by the heatmap scenarios, and
  // the phone layout is one of them: a change to the cell geometry is exactly what
  // breaks the narrow viewport.
  assert.deepEqual(
    planFor('web/src/types/tokenHeatmap.ts'),
    ['dashboard-heatmap', 'dashboard-heatmap-pruned', 'dashboard-heatmap-mobile', 'dashboard-heatmap-error'],
  );
});

test('the shared token layer selects every surface that renders it', () => {
  // The token unit style is rendered by more surfaces than any other shared layer: the OMC page that
  // owns the setting, the dashboard's KPI charts, both model panels, the token activity grid, and the
  // request list with its detail drawer. A rule that listed only some of them would be the silent
  // omission this planner exists to prevent - a change to the number format would land with the
  // surface it broke left unverified - so the set is pinned rather than left to a comment.
  const selected = new Set(planFor('web/src/types/tokenDisplay.ts'));
  for (const id of [
    'omc-settings',
    'dashboard-charts',
    'dashboard-rolling-readouts',
    'dashboard-model-panels',
    'dashboard-heatmap',
    'dashboard-heatmap-mobile',
    'dashboard-heatmap-pruned',
    'dashboard-heatmap-error',
    'column-alignment',
    'request-list-interactions',
  ]) {
    assert.equal(selected.has(id), true, `the token layer selects ${id}`);
  }
  // The provider that resolves the stored style is a sibling of the layer, not a separate concern:
  // both are matched by the same prefix, so a value written there reaches the same scenarios.
  assert.deepEqual(
    planFor('web/src/types/tokenDisplayContext.tsx'),
    planFor('web/src/types/tokenDisplay.ts'),
  );
});

test('a provider-console change selects only the provider-console scenarios', () => {
  // `phone-lists` is in both: the provider table is one of the surfaces ADR 0012 renders as rows on
  // a phone, so a change to it must run the scenario that reads both of its renderings.
  assert.deepEqual(planFor('web/src/pages/ProvidersPage.tsx'), ['icon-picker-stacking', 'provider-icon-pick', 'overlay-back', 'phone-lists']);
  assert.deepEqual(planFor('web/src/components/IconPickerModal.tsx'), ['icon-picker-stacking', 'provider-icon-pick']);
  // The page renders the console's own modules rather than carrying them, so a
  // change to one of those has to select the same scenarios the page does - the
  // drawer is one of the two overlays the stacking claim is about, and an
  // unplaced path here would widen instead of narrowing.
  for (const file of [
    'web/src/components/providers/ProviderEditorDrawer.tsx',
    'web/src/components/providers/ProviderTable.tsx',
    'web/src/components/providers/useProviderManagement.ts',
  ]) {
    assert.deepEqual(planFor(file), ['icon-picker-stacking', 'provider-icon-pick', 'overlay-back', 'phone-lists'], file);
  }
});

test('the shared layer widens the plan to every scenario', () => {
  // `App.tsx`, the layout, the theme and the API client are imported everywhere, so
  // narrowing their blast radius would be a guess rather than a decision.
  for (const file of [
    'web/src/App.tsx',
    'web/src/main.tsx',
    'web/src/index.css',
    'web/src/api/client.ts',
    'web/src/i18n/index.tsx',
    'web/src/components/common/AppLayout.tsx',
    'web/src/theme/themeConfig.ts',
  ]) {
    assert.deepEqual(planFor(file), ALL, `${file} widens the plan`);
  }
});

test('an unrecognised frontend path widens rather than selecting nothing', () => {
  // The critical negative case. An unclassified file is not evidence of no impact,
  // and reporting "nothing to check" here is how a fast path becomes a blind one.
  const plan = planScenarios(['web/src/pages/SomeNewPage.tsx'], ALL);
  assert.deepEqual(plan.ids, ALL, 'an unplaced frontend file widens the plan');
  assert.match(plan.reason, /unrecognised frontend source/);
});

test('a change to the probe framework itself widens the plan', () => {
  // These files decide whether the scenarios run, are listed, or are selected. If one
  // of them is edited so that nothing is selected, the change that broke it must
  // still be verified - the same self-selecting rule `verify:fast` needs.
  for (const file of [
    'scripts/acceptance/probe.mjs',
    'scripts/acceptance/scenarios.mjs',
    'scripts/acceptance/probes/dashboardCharts.mjs',
    'scripts/acceptance/probes/usageRecords.mjs',
    'scripts/acceptance/check-ui-plan.mjs',
    'scripts/browser-probes.mjs',
    'scripts/check-ui.mjs',
  ]) {
    const plan = planScenarios([file], ALL);
    assert.deepEqual(plan.ids, ALL, `${file} widens the plan`);
    assert.match(plan.reason, /probe framework/);
  }
});

test('backend and documentation changes select nothing', () => {
  // The one case where the empty plan is correct: the dev server serves the SPA
  // against mocked routes, so a Go change cannot alter what the probes observe.
  for (const file of [
    'internal/api/handler.go',
    'internal/repository/usage_events.go',
    'go.mod',
    'docs/architecture.md',
    'README.md',
    'migrations/004_x.sql',
  ]) {
    const plan = planScenarios([file], ALL);
    assert.deepEqual(plan.ids, [], `${file} selects nothing`);
    assert.match(plan.reason, /no frontend source changed/);
  }
});

test('an empty change selects nothing', () => {
  assert.deepEqual(planScenarios([], ALL).ids, []);
});

test('the plan preserves registry order and contains no duplicates', () => {
  // A stable order keeps two runs on the same change comparable, and makes a focused
  // run's scenario list readable against `--list`.
  const plan = planScenarios(
    ['web/src/pages/DashboardPage.tsx', 'web/src/pages/UsageEventsPage.tsx'],
    ALL,
  );
  assert.deepEqual(plan.ids, [...new Set(plan.ids)], 'no duplicates');
  assert.deepEqual(plan.ids, ALL.filter((id) => plan.ids.includes(id)), 'registry order');
});

test('a mixed change unions the narrow plans without widening', () => {
  const plan = planScenarios(
    ['web/src/pages/DashboardPage.tsx', 'web/src/pages/ProvidersPage.tsx'],
    ALL,
  );
  // Two placed paths union; only an *unplaced* one widens. This is the distinction
  // that keeps a two-page change from running everything.
  assert.deepEqual(plan.ids.sort(), [
    'dashboard-chart-motion', 'dashboard-charts', 'dashboard-heatmap', 'dashboard-heatmap-error',
    'dashboard-heatmap-mobile', 'dashboard-heatmap-pruned', 'dashboard-model-panels',
    'dashboard-model-panels-empty', 'dashboard-model-panels-failure', 'dashboard-model-panels-states',
    'dashboard-rolling-readouts', 'icon-picker-stacking', 'overlay-back', 'phone-lists',
    'provider-icon-pick',
  ]);
});

test('the reason names the file that caused a widening', () => {
  // `check:ui --plan` prints this, and "the plan is wide" without "because of this
  // file" leaves the reader unable to act on it.
  const plan = planScenarios(['web/src/pages/Unclassified.tsx'], ALL);
  assert.match(plan.reason, /Unclassified\.tsx/);
});

test('no scenario id is selected by a path that cannot affect it', () => {
  // A cheap structural guard: the dashboards rule must not drag in the request list,
  // and vice versa. If a rule is ever widened by accident, this notices.
  const charts = new Set(planFor('web/src/charts/chartTheme.ts'));
  assert.equal(charts.has('request-list-interactions'), false);
  // Positive control for the same rule: the model panels' trend and ring are chart files too, so a
  // change under `charts/` has to reach the scenario that reads their paint. A rule that mapped the
  // directory to the KPI tile scenario alone would leave the panel mark unverified.
  assert.equal(charts.has('dashboard-model-panels'), true);
  const rows = new Set(planFor('web/src/components/usage/RequestRow.tsx'));
  assert.equal(rows.has('dashboard-charts'), false);
  assert.equal(rows.has('icon-picker-stacking'), false);
});
