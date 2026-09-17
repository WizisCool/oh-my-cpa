/**
 * Tests for the affected-check planner behind `pnpm test:fast`.
 *
 * Two things are asserted here, and the second is the one that keeps the gate
 * cheap:
 *
 * 1. **Coverage.** Editing a test suite, the test harness, or the planner itself
 *    selects a check. All three previously selected nothing, so a change made to
 *    turn a test green was verified by no gate at all.
 * 2. **No browser, ever.** For every path in the representative corpus below, the
 *    plan must contain no check that builds the SPA, builds a Go binary, starts
 *    Vite, starts Chromium or starts the fake CPA. That is a property of the plan
 *    rather than of a command list, so it is asserted against the plan directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECK_IDS, planChecks } from './affected-checks.mjs';

/** Checks that would pay for a build, a dev server, a browser or the fixture. */
const BROWSER_OR_BUILD_CHECKS = ['browser', 'browser-smoke', 'build', 'e2e', 'fake-cpa', 'chromium'];

test('every selected id is a check the runner knows how to execute', () => {
  // A plan that names an id with no command would fail as a crash rather than as a
  // missing check, which is a worse failure mode than an over-broad plan. The
  // runner's command table is the authority, so the plan is checked against it for
  // every rule rather than for one example.
  const corpus = [
    'web/src/App.tsx',
    'web/src/App.css',
    'internal/api/handler.go',
    'README.md',
    '.github/workflows/ci.yml',
    'package.json',
    'scripts/sync-web-dist.mjs',
    'scripts/test-usage-event-view.ts',
    'newmod/src/thing.rs',
  ];
  for (const file of corpus) {
    for (const id of planChecks([file])) {
      assert.ok(CHECK_IDS.includes(id), `${file} selected unknown check ${id}`);
    }
  }
});

test('an ordinary component change selects the frontend gates and nothing else', () => {
  assert.deepEqual(planChecks(['web/src/pages/DashboardPage.tsx']), [
    'type-check',
    'logic',
    'i18n',
    'antd-lint',
    // A component's inline style is a motion declaration too: `transition: 'all 0.15s'` inside a
    // `style` object is a duration the budget owns, and the checker reads both extensions.
    'motion',
  ]);
});

test('a frontend change never selects a check that starts a browser or a build', () => {
  // The property the whole fast path exists for. Any check id outside the cheap set
  // would mean an ordinary edit now pays for Chromium.
  for (const id of planChecks([
    'web/src/pages/ProvidersPage.tsx',
    'web/src/components/usage/RequestRow.tsx',
  ])) {
    assert.equal(BROWSER_OR_BUILD_CHECKS.includes(id), false, `${id} must not be selected`);
  }
});

test('a Go change selects the Go tests and not the frontend type check', () => {
  assert.deepEqual(planChecks(['internal/api/management_providers.go']), ['go']);
});

test('a Go module change selects the Go tests', () => {
  assert.deepEqual(planChecks(['go.sum']), ['go']);
});

test('a CSS change selects the CSS module check without the TypeScript gates', () => {
  // A stylesheet can break a class reference and the motion budget, and those are the two gates that
  // catch exactly that; neither needs the type checker.
  assert.deepEqual(planChecks(['web/src/pages/UsageEventsPage.css']), ['css-modules', 'motion']);
});

test('the regenerated embedded bundle is a Go-relevant change', () => {
  // `internal/web/dist` is embedded into the Go binary, so a rebuild of the stub
  // changes what the Go tests and the browser suite serve even though the diff is
  // one HTML file.
  assert.ok(planChecks(['internal/web/dist/index.html']).includes('go'));
});

test('editing a logic test suite runs the logic suites', () => {
  // Previously: a `scripts/test-*.ts` change matched no rule, so a change made to
  // make a suite pass ran nothing. Scripts are executed with types stripped rather
  // than checked, so the run itself is the only gate they have.
  const plan = planChecks(['scripts/test-usage-event-view.ts']);
  assert.ok(plan.includes('logic'), `logic must be selected, got ${plan.join(',')}`);
});

test('editing the test harness runs the logic suites', () => {
  for (const file of ['scripts/ts-resolve.mjs', 'scripts/test-logic.mjs']) {
    const plan = planChecks([file]);
    assert.ok(plan.includes('logic'), `${file} must select the logic suites, got ${plan.join(',')}`);
  }
});

test('editing the planner itself runs the logic suites that assert its behaviour', () => {
  // Self-selecting on purpose: if the planner is changed so that it selects
  // nothing, the change that broke it is still verified by the suites that test it.
  assert.ok(planChecks(['scripts/verify-fast.mjs']).includes('logic'));
});

test('any other tooling change runs the repository self-tests', () => {
  // The hole this closes: a `scripts/` change that was not a `.ts` suite and not one
  // of the named harness files counted as "placed", so the broad fallback did not
  // fire while no rule selected anything. The family of change that can silently
  // break every gate was the one family nothing checked.
  for (const file of ['scripts/sync-web-dist.mjs', 'scripts/check-docs.mjs', 'scripts/secret-scan.mjs']) {
    assert.deepEqual(planChecks([file]), ['self-tests'], `${file} selects the self-tests`);
  }
});

test('a tooling change still never reaches the browser', () => {
  // The self-test selection is deliberately cheap. A change that cannot be run
  // cheaply is a reason to run the cheap gates that cover the tooling, not a reason
  // for the fast path to start paying for Chromium.
  const plan = planChecks(['scripts/sync-web-dist.mjs']);
  assert.equal(plan.includes('browser'), false);
  for (const id of plan) {
    assert.equal(BROWSER_OR_BUILD_CHECKS.includes(id), false, `${id} must not be selected`);
  }
});

test('changing the dependency manifest selects the pinned toolchain check', () => {
  assert.ok(planChecks(['package.json']).includes('toolchain'));
  assert.ok(planChecks(['pnpm-lock.yaml']).includes('toolchain'));
  assert.ok(planChecks(['scripts/tools-versions.json']).includes('toolchain'));
});

test('a documentation change selects the documentation check', () => {
  assert.deepEqual(planChecks(['docs/architecture.md']), ['docs']);
});

test('a workflow change selects the workflow validator', () => {
  assert.deepEqual(planChecks(['.github/workflows/ci.yml']), ['workflow']);
});

test('an unplaceable file runs the broad gates rather than nothing', () => {
  // A new top-level directory must not be silently unverified. Falling through to
  // an empty plan is the failure mode this rule exists to prevent.
  const plan = planChecks(['newmod/src/thing.rs']);
  assert.ok(plan.includes('type-check'), `type-check must be selected, got ${plan.join(',')}`);
  assert.ok(plan.includes('logic'), `logic must be selected, got ${plan.join(',')}`);
  assert.ok(plan.includes('go'), `go must be selected, got ${plan.join(',')}`);
});

test('no planned check for any representative path reaches the browser or a build', () => {
  const corpus = [
    'web/src/App.tsx',
    'web/src/pages/UsageEventsPage.tsx',
    'web/src/pages/UsageEventsPage.css',
    'web/src/types/usageEventView.ts',
    'web/src/i18n/index.tsx',
    'internal/api/handler.go',
    'internal/api/management_provider_writes.go',
    'internal/web/dist/index.html',
    'cmd/oh-my-cpa/main.go',
    'migrations/004_something.sql',
    'scripts/test-usage-event-view.ts',
    'scripts/ts-resolve.mjs',
    'scripts/verify-fast.mjs',
    'scripts/sync-web-dist.mjs',
    'scripts/check-docs.mjs',
    'scripts/browser-acceptance.mjs',
    'scripts/browser-probes.mjs',
    'docs/architecture.md',
    'README.md',
    '.github/workflows/ci.yml',
    'package.json',
    'pnpm-lock.yaml',
    'web/package.json',
    'go.mod',
    'newmod/src/thing.rs',
  ];
  for (const file of corpus) {
    for (const id of planChecks([file])) {
      assert.equal(BROWSER_OR_BUILD_CHECKS.includes(id), false, `${file} selected ${id}`);
    }
  }
});

test('the plan is ordered deterministically and contains no duplicates', () => {
  const plan = planChecks([
    'web/src/App.tsx',
    'web/src/App.css',
    'internal/api/handler.go',
    'package.json',
  ]);
  assert.deepEqual(plan, [...new Set(plan)], 'no duplicates');
  // Stable order means two runs on the same change produce identical output, which
  // is what makes a local run comparable to a repeated one.
  assert.deepEqual(
    plan,
    planChecks(['internal/api/handler.go', 'package.json', 'web/src/App.css', 'web/src/App.tsx']),
  );
  assert.deepEqual(plan, CHECK_IDS.filter((id) => plan.includes(id)));
});

test('an empty change selects nothing', () => {
  assert.deepEqual(planChecks([]), []);
});
