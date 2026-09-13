/**
 * Chooses the checks a working-tree change actually needs.
 *
 * The selection is deliberately a small, readable rule set rather than a build
 * graph: a planner that is wrong in subtle ways is worse than a slightly
 * over-broad one, because its failure mode is a green run that verified nothing.
 * Two rules keep it honest:
 *
 * 1. **Anything the planner cannot place runs the frontend and Go gates.** A new
 *    top-level directory, a shared config, or an unfamiliar extension is not
 *    evidence that nothing was affected.
 * 2. **The planner's own inputs select themselves.** A change to a test suite, to
 *    the test harness, or to this file must run the checks that exercise them -
 *    otherwise editing a test to make it pass would be verified by nothing.
 *
 * `planChecks` is exported so its selection can be asserted directly, including
 * the negative property that matters most: ordinary frontend work must never
 * select a build, Vite, Chromium or the fake CPA.
 */

/** Every check the planner can select, as a stable identifier. */
export const CHECK_IDS = [
  'type-check',
  'logic',
  'i18n',
  'antd-lint',
  'css-modules',
  'go',
  'docs',
  'workflow',
  'toolchain',
  'self-tests',
];

const WEB_TEST_INFRASTRUCTURE = [
  'scripts/ts-resolve.mjs',
  'scripts/verify-fast.mjs',
  'scripts/test-logic.mjs',
];

export function planChecks(files) {
  const has = (predicate) => files.some(predicate);
  const checks = new Set();

  const hasWebSource = has((file) => file.startsWith('web/src/'));
  const hasWebCode = hasWebSource && has((file) => /\.(?:ts|tsx)$/.test(file));
  const hasGo = has((file) => /^(?:.*\.go|go\.mod|go\.sum)$/.test(file));
  const hasScript = has((file) => file.startsWith('scripts/'));
  const hasTestSuite = has((file) => file.startsWith('scripts/') && file.endsWith('.ts'));
  const hasTestInfrastructure = has((file) => WEB_TEST_INFRASTRUCTURE.includes(file));

  // A dependency or TypeScript-configuration change can invalidate any frontend
  // result, so it selects the type check whatever else changed.
  if (
    hasWebCode ||
    has((file) => ['web/package.json', 'web/tsconfig.json', 'package.json', 'pnpm-lock.yaml'].includes(file))
  ) {
    checks.add('type-check');
  }

  if (hasWebCode || hasTestSuite || hasTestInfrastructure) checks.add('logic');
  if (hasWebCode) checks.add('i18n');
  if (has((file) => file.endsWith('.tsx'))) checks.add('antd-lint');
  if (has((file) => file.endsWith('.css'))) checks.add('css-modules');
  if (hasGo) checks.add('go');
  if (has((file) => file.endsWith('.md'))) checks.add('docs');
  if (has((file) => file.startsWith('.github/workflows/') || file === 'scripts/validate-workflow.mjs')) {
    checks.add('workflow');
  }

  // Any other tooling change runs the mechanical self-tests, which is where the
  // scripts that build, sync, scan and validate are themselves covered. Without
  // this a change to `scripts/` matched no rule at all: it was "placed" (so the
  // fallback below did not fire) while selecting nothing, and the one family of
  // change that can silently break every gate was the one family nothing checked.
  //
  // It deliberately does not select the browser gates. A test that cannot be run
  // cheaply is still a reason to run the cheap gates that cover the tooling, not a
  // reason for the fast path to start paying for Chromium.
  if (hasScript) checks.add('self-tests');

  // The Go gates read the embedded SPA from `internal/web/dist`, so a regenerated
  // bundle is a Go-relevant change even though the diff is one HTML file.
  if (has((file) => file.startsWith('internal/web/'))) checks.add('go');

  // Anything the rules above did not place runs the broad gates instead of
  // nothing. This is what keeps a new top-level directory from being silently
  // unverified; it is intentionally the last word, so a file that matches no rule
  // cannot fall through to an empty plan.
  const isPlaced = (file) =>
    file.startsWith('web/src/') ||
    file.startsWith('internal/') ||
    file.startsWith('scripts/') ||
    file.startsWith('.github/') ||
    file.startsWith('docs/') ||
    file.startsWith('migrations/') ||
    file.startsWith('cmd/') ||
    file.endsWith('.md') ||
    file.endsWith('.go') ||
    file.endsWith('.ts') ||
    file.endsWith('.tsx') ||
    file.endsWith('.css') ||
    /^(?:.*\.go|go\.mod|go\.sum)$/.test(file) ||
    ['web/package.json', 'web/tsconfig.json', 'package.json', 'pnpm-lock.yaml'].includes(file);
  if (has((file) => !isPlaced(file))) {
    checks.add('type-check');
    checks.add('logic');
    checks.add('go');
  }

  // A toolchain or dependency change can invalidate every result above, so it takes
  // the pinned-version check as well.
  if (has((file) => ['package.json', 'pnpm-lock.yaml', 'scripts/tools-versions.json'].includes(file))) {
    checks.add('toolchain');
  }
  return CHECK_IDS.filter((id) => checks.has(id));
}
