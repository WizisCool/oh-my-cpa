import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './parallel-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function componentTestFiles(directory = root) {
  return fs.readdirSync(path.join(directory, 'web/src'), { recursive: true })
    .filter(file => file.endsWith('.component.test.tsx'))
    .map(file => `web/src/${file.split(path.sep).join('/')}`)
    .sort();
}

export function componentCommand(directory = root) {
  const files = componentTestFiles(directory);
  if (files.length === 0) throw new Error('Component discovery must be nonempty');
  return {
    command: process.execPath,
    args: [path.join(directory, 'web/node_modules/vitest/vitest.mjs'), 'run', '--root', path.join(directory, 'web'), '--config', path.join(directory, 'web/vitest.config.ts')],
    cwd: directory,
    files,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Component runner takes no options; full discovery is intentional');
  const { command, args, files } = componentCommand();
  console.log(`[components] ${files.length} automatically discovered suite(s)`);
  // Reuse the repository's process-group ownership, cancellation and retained
  // diagnostics instead of letting a directly spawned Vitest worker outlive us.
  if (!await runChecks([{ label: 'React integration', command, args }])) process.exitCode = 1;
}
