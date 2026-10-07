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
 *    independent processes, so they run concurrently. Report elapsed time per
 *    check instead of assuming a fixed cost as the repository grows.
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

export function changedFiles(base = 'HEAD', directory = root) {
  const tracked = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, '--'], {
    cwd: directory,
    encoding: 'utf8',
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: directory,
    encoding: 'utf8',
  });
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))]
    .map((file) => file.split(path.sep).join('/'));
}

/** The command each selected check runs. Kept beside the plan so a new check id
 *  cannot be selected without a way to run it. */
export const CHECK_COMMANDS = {
  // Incremental only here: the iteration loop re-checks what changed against a build
  // info file under `tmp/`, while `verify` and CI keep the fresh `type-check`.
  'type-check': { label: 'frontend type check (incremental)', command: 'pnpm', args: ['type-check:incremental'] },
  logic: { label: 'frontend logic tests', command: 'pnpm', args: ['test:logic'] },
  i18n: { label: 'frontend translation keys', command: 'pnpm', args: ['check-i18n'] },
  'antd-lint': { label: 'Ant Design lint', command: 'pnpm', args: ['lint:antd'] },
  'css-modules': { label: 'CSS module references', command: 'pnpm', args: ['check-css-modules'] },
  motion: { label: 'motion budget', command: 'pnpm', args: ['check:motion'] },
  feedback: { label: 'feedback surfaces', command: 'pnpm', args: ['check:feedback'] },
  go: { label: 'Go tests', command: 'go', args: ['test', './...'] },
  docs: { label: 'documentation references', command: 'pnpm', args: ['check-docs'] },
  workflow: { label: 'GitHub workflow syntax', command: 'pnpm', args: ['verify:workflow'] },
  toolchain: { label: 'pinned toolchain', command: 'pnpm', args: ['verify:toolchain'] },
  'self-tests': { label: 'repository self-tests', command: 'pnpm', args: ['test:self'] },
};

export function parseFastOptions(argv) {
  const options = { base: 'HEAD', plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') options.plan = true;
    else if (argument === '--base' && argv[index + 1] && !argv[index + 1].startsWith('-')) {
      options.base = argv[++index];
    } else throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return options;
}

export async function runFastChecks(argv) {
  const options = parseFastOptions(argv);
  const files = changedFiles(options.base);
  if (files.length === 0) {
    console.log('[fast] no changed files');
    return true;
  }

  const selected = planChecks(files);
  if (selected.length === 0) {
    console.error('[fast] no checks selected for changed files:');
    for (const file of files) console.error(`  ${file}`);
    return false;
  }

  if (options.plan) {
    console.log(`[fast] changes relative to ${options.base}:`);
    for (const file of files) console.log(`  ${file}`);
    for (const id of selected) console.log(`  [${id}] ${CHECK_COMMANDS[id].label}`);
    if (selected.includes('logic')) execFileSync(process.execPath, ['scripts/test-logic.mjs', '--files', JSON.stringify(files), '--plan'], {cwd:root, stdio:'inherit'});
    return true;
  }

  // Concurrent, because the checks are independent processes and the budget is what
  // decides whether a development loop can afford to run this at all. Quiet, because
  // the answer to "is it broken" is one line per check: a few thousand lines of passing
  // tool output buries it, and a check that fails still prints everything it captured.
  const passed = await runChecks(
    selected.map((id) => ({
      label: CHECK_COMMANDS[id].label,
      command: CHECK_COMMANDS[id].command,
      args: id === 'logic' ? [...CHECK_COMMANDS[id].args, '--files', JSON.stringify(files)] : CHECK_COMMANDS[id].args,
    })),
    { quiet: true },
  );
  if (!passed) return false;
  console.log(`\n[fast] ${selected.length} affected check(s) passed`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runFastChecks(process.argv.slice(2))) process.exitCode = 1;
}
