/**
 * The development fast path for browser checks.
 *
 * Progress reports from development converged on one complaint: the feedback loop
 * cost minutes, not seconds, because every browser assertion went through a released
 * artefact - `pnpm build` (26s) into a Go binary into the fake CPA - and the full
 * suite was the only way to run them. The gate was doing its job; it was simply the
 * wrong tool for asking "did I just break the row layout".
 *
 * `check:ui` answers that question in seconds:
 *
 *   - No `pnpm build`, no Go binary, no fake CPA. It serves the SPA from the Vite
 *     dev server and fulfils every API request from a deterministic mock, so it needs
 *     nothing but Node and a browser.
 *   - Only the scenarios the change can affect. `check-ui-plan.mjs` owns that
 *     mapping and widens the plan rather than guessing when it does not recognise a
 *     path.
 *   - The dev server is where `React.StrictMode` actually double-invokes, so this is
 *     the only place a binding bug like a controller disposed by the first cleanup
 *     can be observed at all. Running against the built SPA cannot see it, which is
 *     why `search-dev-server` exists and why this path is not merely a cheaper copy
 *     of `verify:probes`.
 *
 * The release gate still runs the real artefact: `pnpm verify:full`. This command
 * deliberately does not, and `AGENTS.md` states when each is expected.
 *
 * Usage:
 *   pnpm check:ui                       scenarios the working tree affects
 *   pnpm check:ui --all                 every scenario
 *   pnpm check:ui --scenario charts     one scenario by id (see --list)
 *   pnpm check:ui --list                ids and names, starts nothing
 *   pnpm check:ui --plan                what would run and why, starts nothing
 *   pnpm check:ui --base <ref>          plan against <ref>..worktree instead of HEAD
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProbeChecker, runProbes } from './acceptance/probe.mjs';
import { SCENARIOS } from './acceptance/scenarios.mjs';
import { planScenarios } from './acceptance/check-ui-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Distinct from `verify:probes` (5180) on purpose: running a focused check while the
// release gate is also running must not collide, and `strictPort` turns a collision
// into a loud failure rather than a silent rebind.
const PORT = 5181;

function parseArgs(argv) {
  const options = { all: false, list: false, plan: false, scenario: undefined, base: 'HEAD' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') options.all = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--plan') options.plan = true;
    else if (arg === '--scenario') options.scenario = argv[++index];
    else if (arg === '--base') options.base = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * The changed files, as repo-relative POSIX paths.
 *
 * `--base` exists because a clean tree is not the same as "nothing to check": after a
 * commit the working tree is empty while the change is still unverified. Comparing
 * against a ref keeps the fast path usable between commits, which is where it is
 * most useful.
 */
function changedFiles(base) {
  const tracked = execFileSync('git', ['diff', '--name-only', '-z', base], {
    cwd: root,
    encoding: 'utf8',
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))]
    .map((file) => file.split(path.sep).join('/'));
}

const ids = SCENARIOS.map((scenario) => scenario.id);

function printList() {
  console.log('Scenarios (pass an id to --scenario):\n');
  for (const scenario of SCENARIOS) {
    console.log(`  ${scenario.id.padEnd(28)} ${scenario.name}`);
  }
  console.log(`\n${SCENARIOS.length} scenarios.`);
}

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  printList();
  process.exit(0);
}

if (options.scenario !== undefined && !ids.includes(options.scenario)) {
  console.error(`unknown scenario: ${options.scenario}\n`);
  printList();
  process.exit(2);
}

const files = changedFiles(options.base);
const plan = planScenarios(files, ids);

const selectedIds = options.all
  ? ids
  : options.scenario !== undefined
    ? [options.scenario]
    : plan.ids;

if (options.plan) {
  console.log(`Changed files: ${files.length === 0 ? '(none)' : files.join(', ')}`);
  for (const file of files) console.log(`  - ${file}`);
  console.log(`\nPlan: ${plan.reason}`);
  for (const entry of plan.reasons) {
    if (entry.kind === 'map') console.log(`  ${entry.detail}`);
  }
  console.log(
    selectedIds.length === 0
      ? '\nNo scenario would run.'
      : `\nWould run ${selectedIds.length} scenario(s): ${selectedIds.join(', ')}`,
  );
  process.exit(0);
}

if (selectedIds.length === 0) {
  console.log(`No browser scenario is affected (${plan.reason}). Nothing to check.`);
  process.exit(0);
}

const selected = SCENARIOS.filter((scenario) => selectedIds.includes(scenario.id));
// The checker is quiet here: a focused run prints only failures, because the fast
// path exists to answer "is it broken" and a screenful of PASS lines buries the answer.
// The release gate creates a verbose checker, where the list of what ran is the evidence.
const { check, failures } = createProbeChecker({ quiet: true });

console.log(`Running ${selected.length} of ${SCENARIOS.length} scenarios: ${selectedIds.join(', ')}`);
console.log(`Reason: ${plan.reason}\n`);

// The runner reports one line per failure with the scenario's own name alongside it,
// so a focused run is as diagnostic as a full one without printing every pass.
const startedAt = Date.now();
const { passed, failures: runFailures } = await runProbes({
  port: PORT,
  scenarios: selected.map((scenario) => ({ ...scenario, check })),
});
for (const failure of runFailures) check(`scenario ${failure} completed`, false);
for (const failure of runFailures) console.error(`  ${failure} needed attention`);

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed across ${passed}/${selected.length} scenario(s) in ${seconds}s.`);
  console.error('Diagnostics are in tmp/probe-failure/.');
  process.exit(1);
}
console.log(`\n${selected.length} scenario(s) passed in ${seconds}s.`);
