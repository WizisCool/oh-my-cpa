import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createNativePlan, validateEmbeddedConsole } from './native-release.mjs';
import { createShutdownController, stopProcess } from './acceptance/lifecycle.mjs';

const NATIVE_INPUTS = ['cmd', 'internal', 'migrations', 'go.mod', 'go.sum'];

function hashNativeInputs(root) {
  const hash = createHash('sha256');
  const inspect = relative => {
    const filename = path.join(root, relative);
    if (fs.statSync(filename).isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) inspect(path.join(relative, name));
    } else {
      hash.update(relative).update('\0').update(fs.readFileSync(filename)).update('\0');
    }
  };
  for (const entry of NATIVE_INPUTS) inspect(entry);
  return hash.digest('hex');
}

export function snapshotNativeInputs(root, destination) {
  const inputSHA256 = hashNativeInputs(root);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of NATIVE_INPUTS) {
    fs.cpSync(path.join(root, entry), path.join(destination, entry), { recursive: true });
  }
  assert.equal(hashNativeInputs(destination), inputSHA256, 'Native inputs changed while capturing the experiment snapshot');
  validateEmbeddedConsole(path.join(destination, 'internal/web/dist'));
  return inputSHA256;
}

export async function runBuildPool(targets, concurrency, execute, { signal } = {}) {
  assert.ok([1, 2].includes(concurrency), 'Only serial and bounded two-worker experiments are supported');
  const results = new Array(targets.length);
  let next = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (next < targets.length && !signal?.aborted) {
      const index = next++;
      try { results[index] = await execute(targets[index]); }
      catch (error) { errors.push(error); break; }
    }
  }));
  if (signal?.aborted) {
    const error = new Error(signal.reason?.message ?? 'Build experiment interrupted', { cause: signal.reason });
    error.results = results.filter(result => result !== undefined);
    throw error;
  }
  if (errors.length) throw new AggregateError(errors, 'Build experiment failed');
  return results;
}

async function benchmarkNativeBuilds(arguments_) {
  const allowed = new Set(['--warm', '--linux-only']);
  assert.ok(arguments_.every(argument => allowed.has(argument)), 'Expected [--warm] [--linux-only]');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  validateEmbeddedConsole(path.join(root, 'internal/web/dist'));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const webVersion = JSON.parse(fs.readFileSync(path.join(root, 'web/package.json'), 'utf8')).version;
  const targets = createNativePlan(`v${version}`, version, webVersion).filter(target => !arguments_.includes('--linux-only') || target.goos === 'linux');
  const working = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-build-benchmark-'));
  const children = new Set();
  const cancellation = new AbortController();
  const stopChildren = () => Promise.all([...children].map(child => stopProcess(child, 2000, { isGroup: true })));
  const shutdown = createShutdownController(stopChildren);
  const abort = () => {
    cancellation.abort(new Error('Native build experiment interrupted'));
    process.exitCode = 2;
    shutdown.shutdown().catch(error => console.error(`[benchmark] cancellation cleanup: ${error.message}`));
  };
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  const report = {
    purpose: 'local experiment, not publication input',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    isDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    platform: `${process.platform}/${process.arch}`, cpus: os.availableParallelism(),
    toolchain: execFileSync('go', ['version'], { encoding: 'utf8' }).trim(),
    cache: arguments_.includes('--warm') ? 'every measured target primed before timed cases' : 'fresh build cache per case; existing module downloads', cases: [],
  };
  try {
    const sourceRoot = path.join(working, 'source');
    report.inputSHA256 = snapshotNativeInputs(root, sourceRoot);
    const executeTarget = (target, label, cache) => new Promise(resolve => {
        const binary = path.join(working, `${label}-${target.goos}-${target.goarch}${target.goos === 'windows' ? '.exe' : ''}`);
        const targetStarted = performance.now();
        const child = spawn('go', [...target.buildArgs, '-o', binary, './cmd/oh-my-cpa'], { cwd: sourceRoot, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: {
          ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch,
          ...(arguments_.includes('--warm') ? {} : { GOCACHE: cache }),
        } });
        children.add(child);
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        let spawnError;
        child.once('error', error => { spawnError = error; });
        const deadline = setTimeout(() => { stopProcess(child, 2000, { isGroup: true }).catch(error => { output += error.message; }); }, 180_000);
        child.once('close', code => {
          clearTimeout(deadline); children.delete(child);
          let metadata = '';
          if (code === 0) {
            try { metadata = execFileSync('go', ['version', '-m', binary], { encoding: 'utf8', timeout: 10_000 }); }
            catch (error) { spawnError = error; }
          }
          const hasPassed = !spawnError && code === 0 && [`GOOS=${target.goos}`, `GOARCH=${target.goarch}`, 'CGO_ENABLED=0'].every(setting => metadata.includes(`\tbuild\t${setting}\n`));
          resolve({ target: `${target.goos}/${target.goarch}`, durationMs: Math.round(performance.now() - targetStarted), hasPassed, ...(hasPassed ? {} : { output, error: spawnError?.message }) });
        });
    });
    if (arguments_.includes('--warm')) {
      const primingStarted = performance.now();
      const priming = await runBuildPool(targets, 1, target => executeTarget(target, 'prime'), { signal: cancellation.signal });
      report.priming = { durationMs: Math.round(performance.now() - primingStarted), results: priming };
      assert.ok(priming.every(result => result.hasPassed), 'Warm-cache priming must build every measured target');
    }
    for (const concurrency of [1, 2]) {
      const cache = path.join(working, `cache-${concurrency}`);
      const started = performance.now();
      const results = await runBuildPool(targets, concurrency, target => executeTarget(target, concurrency, cache), { signal: cancellation.signal });
      const entry = { concurrency, durationMs: Math.round(performance.now() - started), results };
      report.cases.push(entry);
      console.log(`[benchmark] workers=${concurrency}: ${(entry.durationMs / 1000).toFixed(2)}s; passed=${results.filter(result => result.hasPassed).length}/${targets.length}`);
    }
    if (!report.cases.every(entry => entry.results.every(result => result.hasPassed))) process.exitCode = 1;
  } catch (error) {
    report.error = error.message;
    process.exitCode = cancellation.signal.aborted ? 2 : 1;
    report.isInterrupted = cancellation.signal.aborted;
    if (error.results) report.interruptedResults = error.results;
    console.error(`[benchmark] ${error.message}`);
  } finally {
    try {
      if (cancellation.signal.aborted) await shutdown.shutdown();
      fs.mkdirSync(path.join(root, 'tmp/build-benchmarks'), { recursive: true });
      const reportPath = path.join(root, `tmp/build-benchmarks/native-${Date.now()}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      for (const result of [...(report.priming?.results ?? []), ...report.cases.flatMap(entry => entry.results), ...(report.interruptedResults ?? [])]) {
        if (!result.hasPassed) console.error(`[benchmark] ${result.target}: ${result.error ?? result.output}`);
      }
      console.log(`[benchmark] report: ${path.relative(root, reportPath)}`);
    } finally {
      process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
      try { await stopChildren(); }
      finally { fs.rmSync(working, { recursive: true, force: true }); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await benchmarkNativeBuilds(process.argv.slice(2));
