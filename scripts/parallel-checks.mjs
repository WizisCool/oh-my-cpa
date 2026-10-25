import { stopProcess } from './acceptance/lifecycle.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHECK_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

export function pruneCheckArtifacts(directory, { now = Date.now(), isOwnerAlive = isProcessAlive } = {}) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^([1-9]\d*)-(?:.*\.(?:stdout|stderr)\.log|\d+\.json)$/);
    if (!match) continue;
    const file = path.join(directory, entry.name);
    try {
      // Keep recent diagnostics of either verdict, and never unlink a live owner's
      // output. Unknown files and permission-denied owners are not ours to prune.
      if (now - fs.statSync(file).mtimeMs < CHECK_ARTIFACT_RETENTION_MS || isOwnerAlive(Number(match[1]))) continue;
      fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function formatOutput(label, stream, output) {
  if (!output) return;
  const lines = output.replace(/\n$/, '').split('\n');
  for (const line of lines) console[stream](`[${label}] ${line}`);
}

function resolveCommand(command, args) {
  if (command === 'node') return { command: process.execPath, args };
  if (command === 'pnpm' && process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  if (command === 'pnpm' && process.platform === 'win32') return { command: 'pnpm.cmd', args };
  return { command, args };
}

function runCheck({ label, command, args = [] }, signal, env) {
  const startedAt = Date.now();
  const resolved = resolveCommand(command, args);
  return new Promise((resolve) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    const outputDirectory = path.join(root, 'tmp/check-output');
    fs.mkdirSync(outputDirectory, {recursive:true});
    const prefix = path.join(outputDirectory, `${process.pid}-${label.replace(/[^a-z0-9-]/gi, '-')}-${startedAt}`);
    const stdoutFile = `${prefix}.stdout.log`;
    const stderrFile = `${prefix}.stderr.log`;
    fs.writeFileSync(stdoutFile, '');
    fs.writeFileSync(stderrFile, '');
    child.stdout.on('data', chunk => fs.appendFileSync(stdoutFile, chunk));
    child.stderr.on('data', chunk => fs.appendFileSync(stderrFile, chunk));
    const abort = () => {
      stopProcess(child, 2000, { isGroup: true }).catch(error => fs.appendFileSync(stderrFile, `${error.message}\n`));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort);
      fs.appendFileSync(stderrFile, `${error.message}\n`);
      resolve({ label, code: 1, signal: null, stdoutFile, stderrFile, durationMs: Date.now() - startedAt });
    });
    child.once('close', async (code, exitSignal) => {
      signal.removeEventListener('abort', abort);
      try { await stopProcess(child, 2000, { isGroup: true }); }
      catch (error) { fs.appendFileSync(stderrFile, `${error.message}\n`); code = 1; }
      resolve({ label, code: code ?? 1, signal: exitSignal, stdoutFile, stderrFile, durationMs: Date.now() - startedAt });
    });
  });
}

/**
 * Runs independent verification groups concurrently and prints their captured
 * output only after each process exits. Prefixing complete blocks keeps failures
 * readable without interleaving lines from several tools.
 *
 * `quiet` prints a passing check as a single line and holds its output back. That is
 * for the development fast path, where the question is "did I break something" and a
 * few thousand lines of passing tool output buries the answer. A failing check always
 * prints its full output, because that is the case the transcript exists for.
 */
export async function runChecks(checks, { quiet = false, signal } = {}) {
  for (const directory of ['tmp/check-output', 'tmp/check-timings']) pruneCheckArtifacts(path.join(root, directory));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  let results;
  try {
  console.log(`\n[parallel] starting ${checks.length} check(s): ${checks.map((check) => check.label).join(', ')}`);
  // Checks started together share the machine, and so does everything they start in
  // turn: a suite that sizes its own worker pool reads OMC_SHARED_CPU and keeps to one
  // worker beside its siblings. An exclusive check runs after them, on its own, so it
  // can use every core; it still inherits the flag when an outer runner set it.
  const concurrent = checks.filter((check) => !check.isExclusive);
  const exclusive = checks.filter((check) => check.isExclusive);
  const sharedEnv = concurrent.length > 1 ? { ...process.env, OMC_SHARED_CPU: '1' } : process.env;
  const report = (result) => {
    const seconds = (result.durationMs / 1000).toFixed(2);
    console[result.code === 0 ? 'log' : 'error'](`\n[parallel] ${result.code === 0 ? 'PASS' : 'FAIL'} ${result.label} (${seconds}s)`);
    // A passing check under `quiet` contributes its one line and nothing else; a
    // failing one contributes everything it captured.
    if (quiet && result.code === 0) return result;
    formatOutput(result.label, 'log', fs.readFileSync(result.stdoutFile, 'utf8'));
    formatOutput(result.label, 'error', fs.readFileSync(result.stderrFile, 'utf8'));
    return result;
  };
  results = await Promise.all(concurrent.map(async (check) => report(await runCheck(check, controller.signal, sharedEnv))));
  for (const check of exclusive) {
    if (controller.signal.aborted) break;
    results.push(report(await runCheck(check, controller.signal, process.env)));
  }
  } finally {
    signal?.removeEventListener('abort', abort);
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
  const timingDirectory = path.join(root, 'tmp/check-timings');
  fs.mkdirSync(timingDirectory, {recursive:true});
  fs.writeFileSync(path.join(timingDirectory, `${process.pid}-${Date.now()}.json`), JSON.stringify(results, null, 2) + '\n');
  return !controller.signal.aborted && results.every(result => result.code === 0);
}

// A sample is not a regression. Keep the first three successful observations as
// this host's baseline and fail only when three subsequent samples all exceed it
// substantially. Cold starts and failures remain visible but cannot ratchet it up.
export function recordVerificationCost(lane, seconds, { directory = path.join(root, 'tmp/verification-cost'), baselineSeconds, workload = [], output = console } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-z0-9-]+-(?:linux|darwin|win32)-[a-z0-9]+-\d+-[a-f0-9]{12}\.json$/.test(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    try { if (Date.now() - fs.statSync(candidate).mtimeMs > CHECK_ARTIFACT_RETENTION_MS) fs.unlinkSync(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const planId = createHash('sha256').update(JSON.stringify(workload)).digest('hex').slice(0, 12);
  const file = path.join(directory, `${lane}-${process.platform}-${process.arch}-${availableParallelism()}-${planId}.json`);
  const history = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { baseline: [], recent: [] };
  if (baselineSeconds === undefined && history.baseline.length < 3) history.baseline.push(seconds);
  else history.recent = [...history.recent, seconds].slice(-3);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`);
  fs.renameSync(temporary, file);
  const sorted = [...history.baseline].sort((a, b) => a - b);
  const baseline = baselineSeconds ?? (sorted.length === 3 ? sorted[1] : undefined);
  const limit = baseline === undefined ? undefined : baseline * 1.5 + 10;
  const message = `[cost] ${lane}: ${seconds.toFixed(2)}s; ${limit === undefined ? `collecting baseline (${sorted.length}/3)` : `baseline ${baseline.toFixed(2)}s, significant-growth threshold ${limit.toFixed(2)}s`}`;
  output.log(message);
  if (limit !== undefined && seconds > limit) output.warn('[cost] Investigate the slow check/scenario in the timing report; remove duplicate work or justify a measured baseline change. Do not retry, skip tests or relax assertions.');
  const hasRegression = limit !== undefined && history.recent.length === 3 && history.recent.every(value => value > limit);
  if (hasRegression) output.error(`[cost] ${lane} exceeded its budget on three successive successful runs; inspect tmp/check-timings before adjusting the baseline.`);
  return !hasRegression;
}

export async function measureVerification(lane, task, workload = []) {
  const started = performance.now();
  const hasPassed = await task();
  if (!hasPassed) return false;
  return recordVerificationCost(lane, (performance.now() - started) / 1000, { workload });
}

// Native Actions timestamps include setup/cache costs, without a new service or
// another test suite. Compare three completed runs so one cold runner only warns.
export async function checkCiVerificationCost(env = process.env) {
  const baselineSeconds = env.GITHUB_EVENT_NAME === 'pull_request' ? 506 : 282;
  const baselineRunnerSeconds = env.GITHUB_EVENT_NAME === 'pull_request' ? 857 : 1167;
  const api = endpoint => JSON.parse(execFileSync('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/${endpoint}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }));
  const summary = [];
  try {
    const current = api(`actions/runs/${env.GITHUB_RUN_ID}`);
    const previous = api(`actions/workflows/${current.workflow_id}/runs?event=${current.event}&status=success&per_page=3`).workflow_runs.filter(run => run.id !== current.id);
    const samples = [current, ...previous].slice(0, 3).map(run => {
      const jobs = api(`actions/runs/${run.id}/jobs?per_page=100`).jobs.filter(job => job.conclusion === 'success' && job.completed_at);
      if (!jobs.length) throw new Error('No completed verification jobs');
      const duration = job => (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
      const setup = jobs.find(job => job.name === 'changes');
      const seconds = (setup ? duration(setup) : 0) + Math.max(0, ...jobs.filter(job => !['changes', 'static', 'probes'].includes(job.name)).map(duration));
      const runnerSeconds = jobs.reduce((total, job) => total + duration(job), 0);
      return { id: run.id, seconds, runnerSeconds };
    });
    const limit = baselineSeconds * 1.5 + 30;
    summary.push(`### Verification cost\n\nBaseline: ${baselineSeconds}s; significant-growth threshold: ${limit}s (50% + 30s runner/cache allowance).\n`, ...samples.map(sample => `- Run ${sample.id}: ${sample.seconds.toFixed(1)}s execution critical path, ${sample.runnerSeconds.toFixed(1)} runner-seconds`));
    const isSlow = samples[0].seconds > limit;
    if (isSlow || samples[0].runnerSeconds > baselineRunnerSeconds * 1.5 + 30) console.warn(`::warning::Verification exceeds ${limit}s. Inspect job timings; consolidate duplicate tests before changing the measured baseline.`);
    const runnerLimit = baselineRunnerSeconds * 1.5 + 30;
    const hasRegression = samples.length === 3 && (samples.every(sample => sample.seconds > limit) || samples.every(sample => sample.runnerSeconds > runnerLimit));
    summary.push(`Runner-time baseline: ${baselineRunnerSeconds}s; significant-growth threshold: ${runnerLimit}s.`);
    if (hasRegression) console.error('::error::Three consecutive verification runs exceed the measured budget. Reduce cost or document evidence for a new baseline in scripts/parallel-checks.mjs and docs/testing.md.');
    console.log(summary.join('\n'));
    return !hasRegression;
  } catch (error) {
    // Cost telemetry cannot turn a GitHub API outage into a product-test failure.
    summary.push('### Verification cost\n\nGitHub timing data unavailable; verification verdicts remain independent. Inspect the native job timings.');
    console.warn(`::warning::GitHub verification-cost telemetry is unavailable (${error.code ?? error.status ?? error.name}): ${error.message.split('\n')[0]}`);
    return true;
  } finally {
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--ci-cost') {
  if (!await checkCiVerificationCost()) process.exitCode = 1;
}
