/**
 * Runs the frontend logic suites from one process.
 *
 * `test:logic` used to be a `pnpm` chain, so every suite meant another package-manager startup
 * startups - each one re-resolving the workspace and spawning a shell before the
 * test itself began. That overhead was a fixed cost paid on every run, unrelated to
 * the work being verified.
 *
 * Suites run with bounded concurrency rather than all at once. They are CPU-bound
 * (TypeScript parsing and assertion loops), and each already runs inside a
 * `pnpm verify:static` group that is itself parallel, so an unbounded fan-out here
 * would trade a startup saving for scheduler thrash on a small machine.
 *
 * Each suite is spawned as its own process, so one suite's failure cannot leave
 * state behind for the next, and the exit code is the first non-zero one.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planLogicSuites } from './logic-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The suites to run: every `scripts/test-*.ts`, discovered rather than listed, so a
 * new suite cannot be written and then never run because nobody registered it. The
 * loader hook is passed to all of them; a suite that does not import application
 * modules pays nothing for it. `test-base-path.mjs` is the one JavaScript suite here.
 */
const DISCOVERED_SUITES = [
  ...fs.readdirSync(path.join(root, 'scripts'))
    .filter((file) => /^test-.+\.ts$/.test(file))
    .sort()
    .map((file) => ({
      name: file.replace(/^test-|\.ts$/g, '').replaceAll('-', ' '),
      script: `scripts/${file}`,
      flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'],
    })),
  { name: 'deploy base path', script: 'scripts/test-base-path.mjs', flags: [] },
];

const flags = process.argv.slice(2);
if (flags.some((flag, index) => flag !== '--files' && flag !== '--plan' && flags[index - 1] !== '--files')) throw new Error('Unknown logic-runner option');
const filesIndex = flags.indexOf('--files');
const files = filesIndex < 0 ? undefined : JSON.parse(flags[filesIndex + 1]);
if (files && (!Array.isArray(files) || !files.every(file => typeof file === 'string'))) throw new Error('--files requires a JSON path array');
const SUITES = planLogicSuites(files, DISCOVERED_SUITES, root);
if (flags.includes('--plan')) {
  console.log(`[logic] selected ${SUITES.length}/${DISCOVERED_SUITES.length} suites`);
  for (const suite of SUITES) console.log(`  ${suite.script}`);
} else {
/** Bounded so a small machine is not asked to schedule every parser at once. */
// Parsed with Number rather than parseInt so a malformed value falls back to the
// default instead of being silently truncated: parseInt reads "1workers" and
// "2.5" as 1 and 2, which would quietly run the suites with the wrong width.
const requestedConcurrency = Number(process.env.OMCPA_LOGIC_CONCURRENCY ?? '2');
const concurrency = Number.isSafeInteger(requestedConcurrency) && requestedConcurrency > 0
  ? Math.min(requestedConcurrency, SUITES.length)
  : 2;

function runSuite(suite) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...suite.flags, suite.script], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // A spawn failure reports itself rather than leaving a promise that never
    // settles; without this a missing interpreter would hang the gate.
    child.once('error', (error) => {
      resolve({ suite, code: 1, stdout, stderr: `${stderr}${error.message}\n`, durationMs: Date.now() - startedAt });
    });
    child.once('close', (code) => {
      resolve({ suite, code: code ?? 1, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

/** Runs `tasks` with at most `limit` in flight, preserving input order in the result. */
async function runWithConcurrency(tasks, limit, run) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      results[index] = await run(tasks[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const startedAt = Date.now();
const results = await runWithConcurrency(SUITES, concurrency, runSuite);

let failed = 0;
for (const result of results) {
  const seconds = (result.durationMs / 1000).toFixed(2);
  const status = result.code === 0 ? 'PASS' : 'FAIL';
  console.log(`\n[logic] ${status} ${result.suite.name} (${seconds}s)`);
  if (result.code !== 0) {
    failed += 1;
    // The whole captured output, so a failure here is as diagnostic as running the
    // suite on its own would have been.
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } else {
    // A passing suite prints one line per assertion, which is noise at this level;
    // its final summary line is what says how much ran.
    const summary = result.stdout.trimEnd().split('\n').filter((line) => /passed|^ok \d|# pass/.test(line));
    for (const line of summary.slice(-2)) console.log(`[logic]   ${line}`);
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);
if (failed > 0) {
  console.error(`\n[logic] ${failed} of ${SUITES.length} suite(s) failed in ${seconds}s`);
  process.exit(1);
}
console.log(`\n[logic] ${SUITES.length} suites passed in ${seconds}s (concurrency ${concurrency})`);

}
