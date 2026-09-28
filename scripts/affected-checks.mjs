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
  'motion',
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

const DEPENDENCY_INPUTS = new Set([
  'package.json', 'web/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc',
]);
const FRONTEND_CHECKS = ['type-check', 'logic', 'i18n', 'antd-lint', 'css-modules', 'motion'];

function planFileChecks(file) {
  const checks = new Set();
  const add = (...ids) => ids.forEach((id) => checks.add(id));
  const isWebCode = file.startsWith('web/src/') && /\.(?:ts|tsx)$/.test(file);

  if (DEPENDENCY_INPUTS.has(file)) return CHECK_IDS;
  if (isWebCode) add('type-check', 'logic', 'i18n', 'css-modules');
  if (file.endsWith('.tsx')) add('antd-lint', 'motion', 'css-modules');
  if (file.endsWith('.css')) add('css-modules', 'motion');
  if (/^(?:.*\.go|go\.mod|go\.sum)$/.test(file)
      || file.startsWith('migrations/') || file.startsWith('internal/web/')) add('go');
  // Go tests are also counted by the fixed-wait ratchet, which is a repository self-test.
  if (file.endsWith('_test.go')) add('self-tests');
  if (file.endsWith('.md')) add('docs');
  if (file.startsWith('.github/workflows/') || file === 'scripts/validate-workflow.mjs') add('workflow');
  if (file.startsWith('scripts/') || file.startsWith('deploy/cloudflare/')) add('self-tests');
  if ((file.startsWith('scripts/') && file.endsWith('.ts'))
      || WEB_TEST_INFRASTRUCTURE.includes(file)
      || file === 'internal/cpa/configyaml/layout_rules.go') add('logic');
  if (/^web\/(?:vite\.config\.|tsconfig)/.test(file)) add(...FRONTEND_CHECKS, 'self-tests');
  if (file === 'scripts/tools-versions.json') add('toolchain');

  // Fallback is per file: a documentation edit must never hide an unclassified
  // migration, configuration or source file by making the overall plan non-empty.
  return checks.size > 0 ? [...checks] : CHECK_IDS;
}

export function planChecks(files) {
  const selected = new Set(files.flatMap(planFileChecks));
  return CHECK_IDS.filter((id) => selected.has(id));
}
