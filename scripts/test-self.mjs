import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './parallel-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function repositoryTestFiles(directory = root) {
  return ['scripts', 'deploy/cloudflare'].flatMap((folder) =>
    fs.readdirSync(path.join(directory, folder))
      .filter((name) => name.endsWith('.test.mjs'))
      .map((name) => `${folder}/${name}`),
  ).sort();
}

export function runSelfChecks(execute = runChecks) {
  // Node isolates test files in child processes; bounded concurrency avoids
  // competing with every frontend parser when this runs inside verify:static.
  return execute([
    { label: 'repository tests', command: 'node', args: ['--test', '--test-concurrency=2', ...repositoryTestFiles()] },
    { label: 'demo freshness', command: 'node', args: ['scripts/check-demo.mjs'] },
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runSelfChecks()) process.exitCode = 1;
}
