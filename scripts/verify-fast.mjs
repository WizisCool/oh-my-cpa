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
 * The selection lives in `affected-checks.mjs`.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChecks } from './affected-checks.mjs';
import { runChecks, measureVerification } from './parallel-checks.mjs';
import { createImpactGraph } from './affected-files.mjs';
import { readdirSync } from 'node:fs';
import { componentTestFiles } from './test-components.mjs';

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

export const CHECK_COMMANDS = {
  // Incremental only here: the iteration loop re-checks what changed against a build
  // info file under `tmp/`, while `verify` and CI keep the fresh `type-check`.
  'type-check': { label: 'frontend type check (incremental)', command: 'pnpm', args: ['type-check:incremental'] },
  logic: { label: 'frontend logic tests', command: 'pnpm', args: ['test:logic'] },
  // Keep jsdom renders off the other checks' CPU budget.
  components: { label: 'frontend component and API integration tests', command: 'pnpm', args: ['test:components'], isExclusive: true },
  i18n: { label: 'frontend translation keys', command: 'pnpm', args: ['check-i18n'] },
  'antd-lint': { label: 'Ant Design lint', command: 'pnpm', args: ['lint:antd'] },
  'css-modules': { label: 'CSS module references', command: 'pnpm', args: ['check-css-modules'] },
  motion: { label: 'motion budget', command: 'pnpm', args: ['check:motion'] },
  'style-tokens': { label: 'style tokens', command: 'pnpm', args: ['check:style-tokens'] },
  feedback: { label: 'feedback surfaces', command: 'pnpm', args: ['check:feedback'] },
  'openui-prompt': { label: 'generated OpenUI instructions', command: 'pnpm', args: ['check:openui-prompt'] },
  // -short skips the few tests that cost tens of seconds; CI runs them.
  go: { label: 'Go tests', command: 'go', args: ['test', '-short', './...'] },
  docs: { label: 'documentation references', command: 'pnpm', args: ['check-docs'] },
  toolchain: { label: 'pinned toolchain', command: 'pnpm', args: ['verify:toolchain'] },
  'self-tests': { label: 'repository self-tests', command: 'pnpm', args: ['test:self'] },
};

function selectGoPackages(files) {
  const relevant = files.filter(file => !file.endsWith('.md'));
  if (!relevant.length || relevant.some(file => !file.endsWith('.go'))) return ['./...'];
  try {
    const module = execFileSync('go', ['list', '-m'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const owners = new Set(relevant.map(file => path.posix.dirname(file) === '.' ? module : `${module}/${path.posix.dirname(file)}`));
    if (relevant.every(file => file.endsWith('_test.go'))) return [...owners];
    const listed = execFileSync('go', ['list', '-f', '{{.ImportPath}} {{join .Deps " "}} {{join .TestImports " "}} {{join .XTestImports " "}}', './...'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const packages = new Map(listed.trim().split('\n').map(line => { const [name, ...imports] = line.split(/\s+/); return [name, imports]; }));
    const reachesOwner = (name, visited = new Set()) => {
      if (owners.has(name)) return true;
      if (visited.has(name)) return false;
      visited.add(name);
      return (packages.get(name) ?? []).some(dependency => reachesOwner(dependency, visited));
    };
    const selected = [...packages.keys()].filter(name => reachesOwner(name));
    if (selected.length) return selected;
  } catch { /* A broken package graph still reaches the full Go verdict. */ }
  console.warn('[fast] Go impact could not be resolved; running every Go package');
  return ['./...'];
}

export function planFastChecks(files) {
  const ids = planChecks(files);
  const graph = createImpactGraph(files.filter(file => !/^web\/src\/i18n\/locales\//.test(file)));
  const isLocal = files.filter(file => !file.endsWith('.md')).every(file => /^(?:web\/(?:src|tests)\/|scripts\/test-[^/]+\.ts$)/.test(file));
  const suites = isLocal ? {
    logic: graph.affected(readdirSync(path.join(root, 'scripts')).filter(name => /^test-.+\.ts$/.test(name) && !name.endsWith('.test.ts')).map(name => `scripts/${name}`)),
    components: files.includes('web/tests/setup.ts') ? componentTestFiles() : graph.affected(componentTestFiles()),
  } : undefined;
  if (suites?.logic.length && !ids.includes('logic')) ids.push('logic');
  return ids.flatMap(id => {
    const definition = { ...CHECK_COMMANDS[id] };
    if (id === 'go') { definition.args = ['test', '-short', ...selectGoPackages(files)]; definition.suiteCount = definition.args.includes('./...') ? undefined : definition.args.length - 2; }
    if (suites && id in suites) {
      const selected = suites[id];
      if (!selected.length) return [];
      definition.args = id === 'logic'
        ? ['--import', 'tsx', '--test', '--test-concurrency=2', ...selected]
        : ['scripts/test-components.mjs', ...selected];
      definition.command = 'node';
      definition.suiteCount = selected.length;
      definition.label += ` (${selected.length} affected suites)`;
    }
    if (isLocal && id === 'feedback') {
      const sources = files.filter(file => /^web\/src\/.*\.tsx?$/.test(file));
      if (!sources.length) return [];
      definition.command = 'node';
      definition.args = ['scripts/check-feedback.mjs', '--files', ...sources];
    }
    return [{ id, ...definition }];
  });
}

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

  const selected = planFastChecks(files);
  if (selected.length === 0) {
    console.error('[fast] no checks selected for changed files:');
    for (const file of files) console.error(`  ${file}`);
    return false;
  }

  if (options.plan) {
    console.log(`[fast] changes relative to ${options.base}:`);
    for (const file of files) console.log(`  ${file}`);
    for (const check of selected) console.log(`  [${check.id}] ${check.label}: ${check.command} ${check.args.join(' ')}`);
    return true;
  }

  // Concurrent, because the checks are independent processes and the budget is what
  // decides whether a development loop can afford to run this at all. Quiet, because
  // the answer to "is it broken" is one line per check: a few thousand lines of passing
  // tool output buries it, and a check that fails still prints everything it captured.
  const passed = await measureVerification(files.every(file => /^web\/(?:src|tests)\//.test(file)) ? 'fast-affected' : 'fast-wide', () => runChecks(selected, { quiet: true }), selected.map(check => [check.id, check.suiteCount === undefined ? 'full' : check.suiteCount <= 2 ? 'small' : check.suiteCount <= 8 ? 'medium' : 'large']));
  if (!passed) return false;
  console.log(`\n[fast] ${selected.length} affected check(s) passed`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runFastChecks(process.argv.slice(2))) process.exitCode = 1;
}
