import { stopProcess } from './acceptance/lifecycle.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function runCheck({ label, command, args = [] }, signal) {
  const startedAt = Date.now();
  const resolved = resolveCommand(command, args);
  return new Promise((resolve) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: root,
      env: process.env,
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
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  let results;
  try {
  console.log(`\n[parallel] starting ${checks.length} check(s): ${checks.map((check) => check.label).join(', ')}`);
  results = await Promise.all(checks.map(async check => {
    const result = await runCheck(check, controller.signal);
    const seconds = (result.durationMs / 1000).toFixed(2);

    console[result.code === 0 ? 'log' : 'error'](`\n[parallel] ${result.code === 0 ? 'PASS' : 'FAIL'} ${result.label} (${seconds}s)`);
    // A passing check under `quiet` contributes its one line and nothing else; a
    // failing one contributes everything it captured.
    if (quiet && result.code === 0) return result;
    formatOutput(result.label, 'log', fs.readFileSync(result.stdoutFile, 'utf8'));
    formatOutput(result.label, 'error', fs.readFileSync(result.stderrFile, 'utf8'));
    return result;
  }));
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
