/** Local feedback: native Vitest dependencies, Go reverse dependencies, and static gates. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChecks } from './affected-checks.mjs';
import { runChecks } from './parallel-checks.mjs';
import { existsSync } from 'node:fs';

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
  frontend: { label: 'frontend tests', command: 'pnpm', args: ['test:frontend'], isExclusive: true },
  i18n: { label: 'frontend translation keys', command: 'pnpm', args: ['check-i18n'] },
  'antd-lint': { label: 'Ant Design lint', command: 'pnpm', args: ['lint:antd'] },
  'css-modules': { label: 'CSS module references', command: 'pnpm', args: ['check-css-modules'] },
  feedback: { label: 'feedback surfaces', command: 'pnpm', args: ['check:feedback'] },
  'openui-prompt': { label: 'generated OpenUI instructions', command: 'pnpm', args: ['check:openui-prompt'] },
  // -short skips the few tests that cost tens of seconds; CI runs them.
  go: { label: 'Go tests', command: 'go', args: ['test', '-short', './...'] },
  docs: { label: 'documentation references', command: 'pnpm', args: ['check-docs'] },
  toolchain: { label: 'pinned toolchain', command: 'pnpm', args: ['verify:toolchain'] },
  'self-tests': { label: 'repository self-tests', command: 'pnpm', args: ['test:self'] },
};

function selectGoPackages(files) {
  // Non-Go inputs selected for this lane cannot be resolved by go list.
  if (files.some(file => !file.endsWith('.go') && planChecks([file]).includes('go'))) return ['./...'];
  const relevant = files.filter(file => /(?:\.go$|^go\.(?:mod|sum)$|^migrations\/|^internal\/web\/)/.test(file));
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
  // Vitest owns source-module resolution. CSS-only changes run the logic suite:
  // its contrast fixtures read CSS, while jsdom cannot prove stylesheet layout.
  const sources = files.filter(file => !file.endsWith('.md'));
  const canSelectRelated = sources.length > 0 && sources.every(file =>
    /^(?:web\/(?:src|tests)\/.*\.tsx?$|scripts\/test-[^/]+\.ts$)/.test(file)
    && existsSync(path.join(root, file))) && !sources.includes('web/tests/setup.ts');
  return ids.flatMap(id => {
    const definition = { ...CHECK_COMMANDS[id] };
    if (id === 'go') { definition.args = ['test', '-short', ...selectGoPackages(files)]; definition.suiteCount = definition.args.includes('./...') ? undefined : definition.args.length - 2; }
    if (id === 'frontend' && canSelectRelated) {
      definition.args = ['exec', 'vitest', 'related', '--run', '--passWithNoTests', '--config', 'web/vitest.config.ts', ...sources];
      definition.label += ' (Vitest related)';
    }
    if (id === 'frontend' && sources.length && sources.every(file => /^web\/src\/.*\.css$/.test(file))) {
      definition.args = ['test:logic'];
      definition.label = 'frontend logic tests (stylesheet fixtures)';
    }
    if (canSelectRelated && id === 'feedback') {
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

  const passed = await runChecks(selected, { quiet: true });
  if (!passed) return false;
  console.log(`\n[fast] ${selected.length} affected check(s) passed`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runFastChecks(process.argv.slice(2))) process.exitCode = 1;
}
