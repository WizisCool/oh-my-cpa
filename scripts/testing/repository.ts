import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Execute } from './checks.ts';
import { runChecks } from '../parallel-checks.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function repositoryTestFiles(root = ROOT) {
  return ['scripts', 'deploy/cloudflare'].flatMap(folder =>
    readdirSync(join(root, folder))
      .filter(name => /\.test\.(?:mjs|ts)$/.test(name))
      .map(name => `${folder}/${name}`),
  ).sort();
}

export function runSelfChecks(execute: Execute = runChecks) {
  // Each negative control owns a temporary tree, so freshness can safely overlap
  // the test pool. Serialization would hide the race instead of removing it.
  return execute([
    { label: 'repository tests', command: 'node', args: ['--import', 'tsx', '--test', '--test-concurrency=2', ...repositoryTestFiles()] },
    { label: 'demo freshness', command: 'node', args: ['--import', 'tsx', 'scripts/check-demo.ts'] },
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runSelfChecks()) process.exitCode = 1;
}
