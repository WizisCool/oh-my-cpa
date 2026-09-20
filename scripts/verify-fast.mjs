/**
 * Fast, affected-only local verification.
 *
 * Three properties this gate has to keep, each of which it has lost before:
 *
 * 1. **It never pays for the browser.** No ordinary change may build the production
 *    SPA, build the Go binary, or start Chromium. Interface checks during development
 *    go through `pnpm check:ui`, which serves the dev server with mocked routes and
 *    needs no artefact at all.
 * 2. **It never selects nothing for a change that matters.** A test suite, the test
 *    harness, or this planner itself all previously fell outside every rule, so
 *    editing a test to make it pass was verified by nothing at all.
 * 3. **It stays inside the development feedback budget.** The selected checks are
 *    independent processes, so they run concurrently: serially a `.tsx` edit costs
 *    about 17s - most of it `tsc` - and concurrently about 11s. That difference is
 *    what decides whether a development loop can afford this check or routes around
 *    it, and a gate that gets routed around protects nothing.
 *
 * The selection lives in `affected-checks.mjs` so it can be asserted directly,
 * including the negative property above.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChecks } from './affected-checks.mjs';
import { runChecks } from './parallel-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function changedFiles() {
  const tracked = execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], {
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

/** The command each selected check runs. Kept beside the plan so a new check id
 *  cannot be selected without a way to run it. */
const COMMANDS = {
  'type-check': { label: 'frontend type check', command: 'pnpm', args: ['type-check'] },
  logic: { label: 'frontend logic tests', command: 'pnpm', args: ['test:logic'] },
  i18n: { label: 'frontend translation keys', command: 'pnpm', args: ['check-i18n'] },
  'antd-lint': { label: 'Ant Design lint', command: 'pnpm', args: ['lint:antd'] },
  'css-modules': { label: 'CSS module references', command: 'pnpm', args: ['check-css-modules'] },
  motion: { label: 'motion budget', command: 'pnpm', args: ['check:motion'] },
  go: { label: 'Go tests', command: 'go', args: ['test', './...'] },
  docs: { label: 'documentation references', command: 'pnpm', args: ['check-docs'] },
  workflow: { label: 'GitHub workflow syntax', command: 'pnpm', args: ['verify:workflow'] },
  toolchain: { label: 'pinned toolchain', command: 'pnpm', args: ['verify:toolchain'] },
  'self-tests': { label: 'repository self-tests', command: 'pnpm', args: ['test:self'] },
};

const files = changedFiles();
if (files.length === 0) {
  console.log('[fast] no changed files');
  process.exit(0);
}

const selected = planChecks(files);
if (selected.length === 0) {
  console.error('[fast] no checks selected for changed files:');
  for (const file of files) console.error(`  ${file}`);
  process.exit(1);
}

// Concurrent, because the checks are independent processes and the budget is what
// decides whether a development loop can afford to run this at all. Quiet, because
// the answer to "is it broken" is one line per check: a few thousand lines of passing
// tool output buries it, and a check that fails still prints everything it captured.
const passed = await runChecks(
  selected.map((id) => ({
    label: COMMANDS[id].label,
    command: COMMANDS[id].command,
    args: COMMANDS[id].args,
  })),
  { quiet: true },
);
if (!passed) process.exit(1);
console.log(`\n[fast] ${selected.length} affected check(s) passed`);
