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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The suites to run. `flags` is the Node invocation each needs: the loader hook is
 * required by the suites that import application modules for their runtime values
 * (Node's ESM resolver needs an explicit extension where a bundler does not).
 */
const SUITES = [
  { name: 'payload rules', script: 'scripts/test-payload-rules.ts', flags: ['--experimental-strip-types'] },
  { name: 'config dirty', script: 'scripts/test-dirty.ts', flags: ['--experimental-strip-types'] },
  { name: 'config states', script: 'scripts/test-config-states.ts', flags: ['--experimental-strip-types'] },
  { name: 'auth file logic', script: 'scripts/test-auth-file-logic.ts', flags: ['--experimental-strip-types'] },
  { name: 'usage event view', script: 'scripts/test-usage-event-view.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'usage events view policy', script: 'scripts/test-usage-events-view-policy.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'provider console', script: 'scripts/test-provider-console.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'provider toggle queue', script: 'scripts/test-provider-toggle-queue.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'scroll intent', script: 'scripts/test-scroll-intent.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'overlay history', script: 'scripts/test-overlay-history.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'phone row fields', script: 'scripts/test-phone-rows.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'mask parity', script: 'scripts/test-mask-key.ts', flags: ['--experimental-strip-types'] },
  { name: 'clipboard strategy', script: 'scripts/test-clipboard.ts', flags: ['--experimental-strip-types'] },
  { name: 'visible clock', script: 'scripts/test-visible-clock.ts', flags: ['--experimental-strip-types'] },
  { name: 'chart marks', script: 'scripts/test-chart-marks.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'dashboard cost note', script: 'scripts/test-dashboard-cost-note.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'token heatmap', script: 'scripts/test-token-heatmap.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'token display', script: 'scripts/test-token-display.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'quota renewal display', script: 'scripts/test-quota-renewal.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'theme presets', script: 'scripts/test-theme-presets.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'plugin config', script: 'scripts/test-plugin-config.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'oauth model aliases', script: 'scripts/test-oauth-model-alias.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'oauth providers', script: 'scripts/test-oauth-providers.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'dashboard providers', script: 'scripts/test-dashboard-providers.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'provider icons', script: 'scripts/test-provider-icons.ts', flags: ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs'] },
  { name: 'deploy base path', script: 'scripts/test-base-path.mjs', flags: [] },];

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
