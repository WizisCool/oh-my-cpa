import { spawn } from 'node:child_process';
import path from 'node:path';
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

function runCheck({ label, command, args = [] }) {
  const startedAt = Date.now();
  const resolved = resolveCommand(command, args);
  return new Promise((resolve) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      resolve({ label, code: 1, signal: null, stdout, stderr: `${stderr}${error.message}\n`, durationMs: Date.now() - startedAt });
    });
    child.once('close', (code, signal) => {
      resolve({ label, code: code ?? 1, signal, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

/**
 * Runs independent verification groups concurrently and prints their captured
 * output only after each process exits. Prefixing complete blocks keeps failures
 * readable without interleaving lines from several tools.
 */
export async function runChecks(checks) {
  console.log(`\n[parallel] starting ${checks.length} check(s): ${checks.map((check) => check.label).join(', ')}`);
  const results = await Promise.all(checks.map(runCheck));
  let failed = false;
  for (const result of results) {
    const seconds = (result.durationMs / 1000).toFixed(2);
    if (result.code !== 0) failed = true;
    console[result.code === 0 ? 'log' : 'error'](`\n[parallel] ${result.code === 0 ? 'PASS' : 'FAIL'} ${result.label} (${seconds}s)`);
    formatOutput(result.label, 'log', result.stdout);
    formatOutput(result.label, 'error', result.stderr);
  }
  return !failed;
}
