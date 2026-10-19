import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planLogicSuites } from '../logic-plan.mjs';
import { runChecks } from '../parallel-checks.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function discoverLogicSuites(root = ROOT) {
  return [
    ...readdirSync(resolve(root, 'scripts'))
      .filter(name => /^test-.+\.ts$/.test(name) && !name.endsWith('.test.ts'))
      .sort()
      .map(name => ({ script: `scripts/${name}` })),
    { script: 'scripts/test-base-path.mjs' },
  ];
}

export function parseLogicOptions(args: string[]) {
  let files: string[] | undefined;
  let isPlan = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--plan' && !isPlan) isPlan = true;
    else if (argument === '--files' && files === undefined) {
      try {
        const value: unknown = JSON.parse(args[++index]);
        if (!Array.isArray(value) || !value.every(file => typeof file === 'string')) throw new Error();
        files = value;
      } catch { throw new Error('--files requires a JSON path array'); }
    } else throw new Error(`Unknown or duplicate logic-runner option: ${argument}`);
  }
  return { files, isPlan };
}

export function logicTestArguments(files: string[], concurrency = 2) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Logic concurrency must be a positive integer');
  // Node owns isolation, bounded scheduling, test verdicts and reporting. tsx owns
  // TypeScript/bundler resolution; application code carries no test-only ESM hook.
  return ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, '--test-reporter=spec', ...files];
}

export async function runLogicChecks(args = process.argv.slice(2)) {
  const { files, isPlan } = parseLogicOptions(args);
  const discovered = discoverLogicSuites();
  const suites: { script: string }[] = planLogicSuites(files, discovered, ROOT);
  console.log(`[logic] selected ${suites.length}/${discovered.length} suites`);
  if (isPlan) {
    for (const suite of suites) console.log(`  ${suite.script}`);
    return true;
  }
  if (!suites.length) return true;
  const requestedConcurrency = Number(process.env.OMCPA_LOGIC_CONCURRENCY ?? '2');
  const concurrency = Number.isSafeInteger(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 2;
  return runChecks([{ label: 'logic tests', command: 'node', args: logicTestArguments(suites.map(suite => suite.script), concurrency) }], { quiet: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runLogicChecks()) process.exitCode = 1;
}
