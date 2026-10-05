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

test('the five request-records concerns select only their own scenarios', () => {
  // This is the page whose feedback cost the most in practice, so it is the one where
  // narrowing has to actually pay off.
  assert.deepEqual(
    planFor('web/src/pages/UsageEventsPage.tsx').sort(),
    ['column-alignment', 'refresh-sequencing', 'request-list-interactions', 'request-list-touch', 'search-dev-server', 'mobile-console'].sort(),
  );
});

test('a dashboard change selects every dashboard scenario', () => {
  // Registry order, which is the order the plan preserves and the order `--list` prints.
  const all = [
    'dashboard-charts', 'provider-rate-marks', 'dashboard-chart-motion', 'dashboard-rolling-readouts',
    'dashboard-model-panels', 'dashboard-model-panels-states', 'dashboard-model-panels-failure',
    'dashboard-model-panels-empty', 'dashboard-heatmap', 'dashboard-heatmap-pruned',
    'dashboard-heatmap-mobile', 'dashboard-heatmap-error', 'mobile-console',
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
    ['dashboard-heatmap', 'dashboard-heatmap-pruned', 'dashboard-heatmap-mobile', 'dashboard-heatmap-error', 'mobile-console'],
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

test('the unified OAuth workspace selects its density scenario and overlay history', () => {
  assert.deepEqual(
    planFor('web/src/pages/oauthManagement/OAuthManagementPage.tsx'),
    ['oauth-management', 'overlay-back', 'mobile-console'],
  );
  assert.deepEqual(
    planFor('web/src/components/authFiles/AuthFileDetailDrawer.tsx'),
    ['oauth-management', 'overlay-back', 'mobile-console'],
  );
  assert.deepEqual(
    planFor('web/src/pages/quota/CredentialQuotaBody.tsx'),
    ['oauth-management', 'overlay-back', 'mobile-console'],
  );
  assert.deepEqual(
    planFor('web/src/pages/LegacyOAuthManagementRedirect.tsx'),
    ['oauth-management', 'overlay-back', 'mobile-console'],
  );
});

test('a provider-console change selects only the provider-console scenarios', () => {
  // `phone-lists` is in both: the provider table is one of the surfaces ADR 0012 renders as rows on
  // a phone, so a change to it must run the scenario that reads both of its renderings.
  assert.deepEqual(planFor('web/src/pages/ProvidersPage.tsx'), ['icon-picker-stacking', 'provider-icon-pick', 'custom-icon-library', 'provider-model-picker', 'overlay-back', 'phone-lists', 'mobile-console']);
  assert.deepEqual(planFor('web/src/components/IconPickerModal.tsx'), ['icon-picker-stacking', 'provider-icon-pick', 'custom-icon-library']);
  // The page renders the console's own modules rather than carrying them, so a
  // change to one of those has to select the same scenarios the page does - the
  // drawer is one of the two overlays the stacking claim is about, and an
  // unplaced path here would widen instead of narrowing.
  for (const file of [
    'web/src/components/providers/ProviderEditorDrawer.tsx',
    'web/src/components/providers/ProviderTable.tsx',
    'web/src/components/providers/useProviderManagement.ts',
  ]) {
    assert.deepEqual(planFor(file), ['icon-picker-stacking', 'provider-icon-pick', 'custom-icon-library', 'provider-model-picker', 'overlay-back', 'phone-lists', 'mobile-console'], file);
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

test('the document shell widens the plan to every scenario', () => {
  // The file every route is loaded into: it names the module entry and seeds the runtime
  // configuration the console reads its base path from. It is outside `web/src`, so a planner
  // that only recognised `web/src` would report "no frontend source changed" for an edit that
  // can break every page - the silent narrow plan this file exists to rule out.
  const plan = planScenarios(['web/index.html'], ALL);
  assert.deepEqual(plan.ids, ALL, 'the document shell widens the plan');
  assert.match(plan.reason, /shared layer/);
});

test('a served-by-copy asset under web/public selects nothing', () => {
  // The deliberate other half of the boundary above. `web/public` is copied verbatim, so
  // nothing imports these files and no scenario asserts against them; treating them as
  // frontend source would spend the whole catalog on a favicon.
  assert.deepEqual(planFor('web/public/favicon.svg'), []);
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

test('an empty change selects nothing and says why', () => {
  const plan = planScenarios([], ALL);
  assert.deepEqual(plan.ids, []);
  // Every plan carries a reason: `check:ui` prints it, and an empty tree used to print "undefined".
  assert.equal(plan.reason, 'no changed files');
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
    'custom-icon-library', 'dashboard-chart-motion', 'dashboard-charts', 'dashboard-heatmap', 'dashboard-heatmap-error',
    'dashboard-heatmap-mobile', 'dashboard-heatmap-pruned', 'dashboard-model-panels',
    'dashboard-model-panels-empty', 'dashboard-model-panels-failure', 'dashboard-model-panels-states',
    'dashboard-rolling-readouts', 'icon-picker-stacking', 'mobile-console', 'overlay-back', 'phone-lists',
    'provider-icon-pick', 'provider-model-picker', 'provider-rate-marks',
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

test('playground source selects its desktop and phone acceptance', () => {
  assert.deepEqual(planFor('web/src/pages/playground/PlaygroundPage.tsx'), ['playground', 'playground-narrow', 'mobile-console']);
});

test('the Agent run layer selects every Agent scenario and the Playground that shares it', () => {
  const agentScenarios = ALL.filter((id) => id.startsWith('agent'));
  for (const file of ['web/src/agent/runReducer.ts', 'web/src/agent/sse.ts', 'web/src/pages/agent/runtime.ts']) {
    const ids = new Set(planFor(file));
    for (const id of agentScenarios) assert.equal(ids.has(id), true, `${file} reaches ${id}`);
  }
  // The Playground reads its stream through `agent/sse.ts`, so the run layer reaches it too; the
  // Agent page's own files do not.
  assert.equal(new Set(planFor('web/src/agent/sse.ts')).has('playground'), true);
  assert.equal(new Set(planFor('web/src/pages/agent/AgentPage.tsx')).has('playground'), false);
  // Negative control: the run layer loads no chart catalog or request list.
  const runLayer = new Set(planFor('web/src/agent/transport.ts'));
  assert.equal(runLayer.has('dashboard-charts'), false);
  assert.equal(runLayer.has('column-alignment'), false);
});


test('the config page and its editor select the source-editor scenario only', () => {
  // The page used to be named with no scenario at all, since nothing probed it. The source
  // editor's icon font is now a measured claim, so the page and the modules it is built from
  // select the scenario that makes it - and not the chart and request-list catalogs, which is
  // what keeps a settings-page edit from running them.
  for (const file of [
    'web/src/pages/ConfigPage.tsx',
    'web/src/components/config/YamlSourceEditor.tsx',
    'web/src/types/configSchema.ts',
  ]) {
    const ids = new Set(planFor(file));
    assert.equal(ids.has('config-source-editor'), true, `${file} reaches the source editor's scenario`);
    assert.equal(ids.has('dashboard-charts'), false, `${file} loads no chart`);
    assert.equal(ids.has('column-alignment'), false, `${file} renders no request row`);
  }
});
test('the backup dialog and the page that raises it select the backup scenario', () => {
  for (const file of ['web/src/components/config/ConfigBackupsButton.tsx', 'web/src/pages/ConfigPage.tsx']) {
    assert.equal(new Set(planFor(file)).has('config-backups'), true, `${file} reaches the backup scenario`);
  }
  // The schema describes the editor's fields; the dialog reads none of them.
  assert.equal(new Set(planFor('web/src/types/configSchema.ts')).has('config-backups'), false, 'the schema does not reach the backup scenario');
});


// The key page derives its list by resolving `ALL_CONFIG_FIELDS`'s `apiKeys` field against the
// document through `getFieldSemanticValue`, and neither lives under that page's own directory - so
// a break in the shared draft layer has to reach the scenario that reads that table, which is what
// this pins. It is the reason those rules name more than the source-editor scenario.
test('the config draft layer reaches the key page that shares it', () => {
  for (const file of ['web/src/components/config/configDirty.ts', 'web/src/types/configSchema.ts']) {
    const ids = new Set(planFor(file));
    assert.equal(ids.has('phone-lists'), true, `${file} reaches the key list's rows`);
    // Not a blanket widening: nothing in this directory owns an overlay or a hit target, so those
    // scenarios must stay out of the plan - a rule that named them would pay for them on every
    // settings edit.
    assert.equal(ids.has('overlay-back'), false, `${file} owns no overlay`);
    assert.equal(ids.has('touch-ergonomics'), false, `${file} draws no hit target`);
  }
});

test('dependency and build inputs widen the UI plan even with unrelated documentation', () => {
  for (const file of ['package.json', 'web/package.json', 'pnpm-lock.yaml', 'web/vite.config.ts', 'web/tsconfig.json']) {
    const expected = ['fixture-scenario'];
    assert.deepEqual(planScenarios([file, 'README.md'], expected).ids, expected);
  }
});

 test('custom icon editor and picker changes retain custom library coverage', () => {
  assert.deepEqual(planFor('web/src/components/CustomIconLibrary.tsx'), ['custom-icon-library']);
  assert.deepEqual(planFor('web/src/components/CustomIconLibrary.module.css'), ['custom-icon-library']);
  assert.equal(planFor('web/src/components/IconPickerModal.tsx').includes('custom-icon-library'), true);
  for (const file of ['web/src/hooks/useCustomIcons.ts', 'web/src/types/customIcons.ts']) {
    assert.deepEqual(planFor(file), ALL, `${file} reaches shared provider renderers`);
  }
  assert.equal(planFor('web/src/pages/SystemPage.tsx').includes('custom-icon-library'), false);
});

// The route sweep must follow every page it actually loads, independently of shell changes.
test('the mobile sweep follows console routes and excludes unrelated backend changes', () => {
  for (const file of ['web/src/pages/ModelSquarePage.tsx', 'web/src/pages/ConfigPage.tsx',
    'web/src/pages/DashboardPage.tsx', 'web/src/pages/ProvidersPage.tsx',
    'web/src/pages/pricing/PricingPage.tsx', 'web/src/pages/PluginsPage.tsx',
    'web/src/pages/oauthManagement/OAuthManagementPage.tsx', 'web/src/pages/ApiKeysPage.tsx',
    'web/src/pages/agent/AgentPage.tsx', 'web/src/pages/playground/PlaygroundPage.tsx',
    'web/src/pages/LogsPage.tsx', 'web/src/pages/UsageEventsPage.tsx']) {
    assert.ok(planFor(file).includes('mobile-console'), file);
  }
  assert.ok(!planFor('internal/api/handler.go').includes('mobile-console'));
});

test('phone source editing and backup dialogs are selected by shared overlay and viewport hooks', () => {
  for (const file of ['web/src/hooks/useOverlayHistory.ts', 'web/src/hooks/overlayHistory.ts']) {
    assert.deepEqual(planFor(file), ['overlay-back', 'config-source-editor', 'config-backups', 'model-square', 'mobile-console']);
  }
  assert.deepEqual(planFor('web/src/hooks/useIsPhoneViewport.ts'), [
    'agent-narrow', 'playground-narrow', 'touch-ergonomics', 'phone-lists',
    'config-source-editor', 'config-backups', 'model-square', 'mobile-console',
  ]);
  // A source-only decision must not schedule unrelated conversation checks.
  assert.deepEqual(planFor('web/src/components/config/sourceWrap.ts'), ['phone-lists', 'config-source-editor', 'config-backups', 'mobile-console']);
});


test('the model directory selects its vertical-list and mobile scenarios without unrelated pages', () => {
  for (const file of ['web/src/pages/ModelSquarePage.tsx', 'web/src/pages/ModelSquarePage.module.css', 'web/src/types/modelSquare.ts']) {
    assert.deepEqual(planFor(file), ['model-square', 'mobile-console']);
  }
  assert.equal(planFor('web/src/pages/SystemPage.tsx').includes('model-square'), false);
  assert.equal(planFor('internal/operations/model_square.go').includes('model-square'), false);
});
