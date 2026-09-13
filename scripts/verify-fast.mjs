import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const has = (predicate) => files.some(predicate);
const hasWebSource = has((file) => file.startsWith('web/src/'));
const hasWebCode = hasWebSource && has((file) => /\.(?:ts|tsx)$/.test(file));

const commands = [];
if (hasWebCode || files.some((file) => [
  'web/package.json',
  'web/tsconfig.json',
  'package.json',
  'pnpm-lock.yaml',
].includes(file))) {
  commands.push(['pnpm', ['type-check'], 'frontend type check']);
}
if (hasWebCode) {
  commands.push(['pnpm', ['test:logic'], 'frontend logic tests']);
  commands.push(['pnpm', ['check-i18n'], 'frontend translation keys']);
}
if (has((file) => file.endsWith('.tsx'))) {
  commands.push(['pnpm', ['lint:antd'], 'Ant Design lint']);
}
if (has((file) => file.endsWith('.css'))) {
  commands.push(['pnpm', ['check-css-modules'], 'CSS module references']);
}
if (has((file) => /^(?:.*\.go|go\.mod|go\.sum)$/.test(file))) {
  commands.push(['go', ['test', './...'], 'Go tests']);
}
if (has((file) => file.endsWith('.md'))) {
  commands.push(['pnpm', ['check-docs'], 'documentation references']);
}
if (has((file) => file.startsWith('.github/workflows/') || file === 'scripts/validate-workflow.mjs')) {
  commands.push(['pnpm', ['verify:workflow'], 'GitHub workflow syntax']);
}

for (const [command, args, label] of commands) run(command, args, label);
console.log(`\n[fast] ${commands.length} affected check(s) passed`);
