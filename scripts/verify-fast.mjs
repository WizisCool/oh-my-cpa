/**
 * Fast, affected-only local verification.
 *
 * Two properties this gate has to keep, both of which it has lost before:
 *
 * 1. **It never pays for the browser.** No ordinary change may build the
 *    production SPA, build the Go binary, start Vite, start Chromium or start the
 *    fake CPA. Those belong to `pnpm verify:browser` and `pnpm verify:full`, which
 *    exist to be run deliberately.
 * 2. **It never selects nothing for a change that matters.** A test suite, the
 *    test harness, or this planner itself all previously fell outside every rule,
 *    so editing a test to make it pass was verified by nothing at all.
 *
 * The selection itself lives in `affected-checks.mjs` so it can be asserted
 * directly, including the negative property above.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChecks } from './affected-checks.mjs';

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
  go: { label: 'Go tests', command: 'go', args: ['test', './...'] },
  docs: { label: 'documentation references', command: 'pnpm', args: ['check-docs'] },
  workflow: { label: 'GitHub workflow syntax', command: 'pnpm', args: ['verify:workflow'] },
  toolchain: { label: 'pinned toolchain', command: 'pnpm', args: ['verify:toolchain'] },
};

function run(command, args, label) {
  console.log(`\n[fast] ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const files = changedFiles();
if (files.length === 0) {
  console.log('[fast] no changed files');
  process.exit(0);
}

const selected = planChecks(files);
for (const id of selected) {
  const { label, command, args } = COMMANDS[id];
  run(command, args, label);
}
console.log(`\n[fast] ${selected.length} affected check(s) passed`);
