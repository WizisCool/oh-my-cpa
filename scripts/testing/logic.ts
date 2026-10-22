import { availableParallelism } from 'node:os';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../parallel-checks.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function discoverLogicSuites(root = ROOT) {
  return [
    ...readdirSync(resolve(root, 'scripts'))
      .filter(name => /^test-.+\.ts$/.test(name) && !name.endsWith('.test.ts'))
      .sort()
      .map(name => `scripts/${name}`),
    'scripts/test-base-path.mjs',
  ];
}

export async function runLogicChecks() {
  // Every suite runs: the whole set is fast, and a selection that missed a dependency
  // would be a green run that checked nothing.
  const suites = discoverLogicSuites();
  const concurrency = Number(process.env.OMCPA_LOGIC_CONCURRENCY ?? availableParallelism());
  console.log(`[logic] ${suites.length} suites`);
  return runChecks([{
    label: 'logic tests',
    command: 'node',
    args: ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, '--test-reporter=spec', ...suites],
  }], { quiet: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runLogicChecks()) process.exitCode = 1;
}
