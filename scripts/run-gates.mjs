#!/usr/bin/env node
/**
 * Runs local and CI verification gates with deterministic failure attribution,
 * non-interleaved output, process-tree cancellation, and a fast `gofmt` check.
 *
 * Modes:
 *   node scripts/run-gates.mjs gofmt
 *   node scripts/run-gates.mjs self-tests
 *   node scripts/run-gates.mjs fast
 *   node scripts/run-gates.mjs static-go
 *   node scripts/run-gates.mjs static-repository
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const GO_BIN = process.platform === 'win32' ? 'go.exe' : 'go';
const GOFMT_BIN = process.platform === 'win32' ? 'gofmt.exe' : 'gofmt';

// Warn when a passing logic test crosses 30% of Vitest's 5s default timeout so
// expensive cases surface before they flake under parallel load.
export const SLOW_LOGIC_TEST_WARN_MS = 1500;
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

export function extractSlowVitestCases(output, thresholdMs = SLOW_LOGIC_TEST_WARN_MS) {
  if (!output) return [];
  const plain = output.replace(ANSI_ESCAPE, '');
  const slow = [];
  let currentFile = '';
  for (const rawLine of plain.split(/\r?\n/)) {
    const fileMatch = /^\s*[✓×❯]\s+(?:(?:\|[^|]+\||[^\s|]+)\s+)?(\S+\.test\.[cm]?[jt]sx?)\s+\(/.exec(rawLine);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    const verboseMatch = /^\s*[✓×]\s+(?:(?:\|[^|]+\||[^\s|]+)\s+)?(\S+\.test\.[cm]?[jt]sx?)\s+>\s+(.+?)\s+(\d+(?:\.\d+)?)(ms|s)\s*$/.exec(rawLine);
    if (verboseMatch) {
      const durationMs = verboseMatch[4] === 's' ? Math.round(Number(verboseMatch[3]) * 1000) : Math.round(Number(verboseMatch[3]));
      if (durationMs >= thresholdMs) {
        slow.push({ file: verboseMatch[1], title: verboseMatch[2], durationMs });
      }
      continue;
    }
    const caseMatch = /^\s{2,}[✓×]\s+(.+?)\s+(\d+(?:\.\d+)?)(ms|s)\s*$/.exec(rawLine);
    if (caseMatch) {
      const durationMs = caseMatch[3] === 's' ? Math.round(Number(caseMatch[2]) * 1000) : Math.round(Number(caseMatch[2]));
      if (durationMs >= thresholdMs) {
        slow.push({ file: currentFile, title: caseMatch[1], durationMs });
      }
    }
  }
  slow.sort((left, right) => right.durationMs - left.durationMs);
  return slow;
}

export function listGoFiles(root = ROOT, execute = execFileSync) {
  const output = execute(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.go'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return output
    .split('\0')
    .filter((relPath) => relPath.length > 0 && fs.existsSync(path.join(root, relPath)));
}

export function checkGofmt(root = ROOT, execute = execFileSync) {
  const files = listGoFiles(root, execute);
  if (files.length === 0) {
    return [];
  }
  const unformatted = [];
  const chunkSize = 200;
  for (let index = 0; index < files.length; index += chunkSize) {
    const chunk = files.slice(index, index + chunkSize);
    const out = execute(GOFMT_BIN, ['-l', '--', ...chunk], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
    if (out) {
      unformatted.push(...out.split(/\r?\n/).filter(Boolean));
    }
  }
  return unformatted;
}

export function discoverNodeSelfTestFiles(root = ROOT) {
  const directories = ['scripts', path.join('deploy', 'cloudflare'), path.join('deploy', 'site')];
  const discovered = [];
  for (const relDir of directories) {
    const fullDir = path.join(root, relDir);
    if (!fs.existsSync(fullDir)) continue;
    const entries = fs.readdirSync(fullDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        discovered.push(path.join(relDir, entry.name));
      }
    }
  }
  return discovered;
}

function isPosixGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessTree(child) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => resolvePromise());
      killer.on('close', () => resolvePromise());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const deadline = performance.now() + 800;
  while (isPosixGroupAlive(pid) && performance.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  }
  if (isPosixGroupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Process group already exited.
    }
  }
}

export function runBufferedCommand(label, command, args, { cwd = ROOT, env = process.env, signal } = {}) {
  const startedAt = performance.now();
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({ label, ok: false, aborted: true, durationMs: 0, output: '' });
      return;
    }

    const isPosix = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      env,
      detached: isPosix,
      shell: !isPosix && command.endsWith('.cmd'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let terminationPromise = null;
    const chunks = [];

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (terminationPromise) {
        terminationPromise.finally(() => resolvePromise(payload));
      } else {
        resolvePromise(payload);
      }
    };

    const onAbort = () => {
      terminationPromise = terminateProcessTree(child).finally(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({
          label,
          ok: false,
          aborted: true,
          durationMs: Math.round(performance.now() - startedAt),
          output: Buffer.concat(chunks).toString('utf8').trim(),
        });
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.stderr?.on('data', (chunk) => chunks.push(chunk));

    child.on('error', (error) => {
      const durationMs = Math.round(performance.now() - startedAt);
      const output = `${Buffer.concat(chunks).toString('utf8')}\n${error.message}`.trim();
      finish({ label, ok: false, aborted: Boolean(signal?.aborted), durationMs, output });
    });

    child.on('close', (code, exitSignal) => {
      const durationMs = Math.round(performance.now() - startedAt);
      const output = Buffer.concat(chunks).toString('utf8').trim();
      const aborted = Boolean(signal?.aborted);
      finish({
        label,
        ok: !aborted && code === 0 && !exitSignal,
        aborted,
        durationMs,
        output,
        code,
        exitSignal,
      });
    });
  });
}

export async function runParallelTasks(tasks, { log = console.log, error = console.error } = {}) {
  const controller = new AbortController();
  let failedResult = null;
  let receivedSignal = null;

  const onProcessSignal = (sig) => {
    if (!receivedSignal) {
      receivedSignal = sig;
      controller.abort();
    }
  };
  process.on('SIGINT', onProcessSignal);
  process.on('SIGTERM', onProcessSignal);

  try {
    const wrapped = tasks.map(async (task) => {
      const result = await task(controller.signal);
      if (result.ok) {
        log(`[gate] PASS ${result.label} (${(result.durationMs / 1000).toFixed(2)}s)`);
        for (const diagnostic of result.diagnostics ?? []) {
          log(diagnostic);
        }
      } else if (!result.aborted && !failedResult) {
        failedResult = result;
        controller.abort();
      }
      return result;
    });

    const results = await Promise.all(wrapped);
    if (receivedSignal) {
      process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143;
      return false;
    }
    const failures = results.filter((item) => !item.ok && !item.aborted);
    if (failures.length > 0) {
      for (const failure of failures) {
        error(`\n[gate] FAIL ${failure.label} (${(failure.durationMs / 1000).toFixed(2)}s)`);
        if (failure.output) {
          error(failure.output);
        }
      }
      return false;
    }
    return true;
  } finally {
    process.removeListener('SIGINT', onProcessSignal);
    process.removeListener('SIGTERM', onProcessSignal);
  }
}

async function runStreamingStep(command, args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32' && command.endsWith('.cmd'),
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error(err.message);
      resolvePromise(false);
    });
    child.on('close', (code, signal) => {
      resolvePromise(code === 0 && !signal);
    });
  });
}

export async function runGateMode(mode, { root = ROOT } = {}) {
  switch (mode) {
    case 'gofmt': {
      const unformatted = checkGofmt(root);
      if (unformatted.length > 0) {
        console.error(`Unformatted Go files (run gofmt -w):\n  ${unformatted.join('\n  ')}`);
        return false;
      }
      return true;
    }

    case 'self-tests': {
      if (!(await runStreamingStep(process.execPath, ['scripts/generate-demo-data.mjs', '--if-missing'], { cwd: root }))) {
        return false;
      }
      const testFiles = discoverNodeSelfTestFiles(root);
      if (testFiles.length === 0) {
        throw new Error('No *.test.mjs files discovered for self-tests');
      }
      return runStreamingStep(
        process.execPath,
        ['--import', 'tsx', '--test', '--test-concurrency=2', ...testFiles],
        { cwd: root },
      );
    }

    case 'fast': {
      const sharedCpuEnv = { ...process.env, OMC_SHARED_CPU: process.env.OMC_SHARED_CPU ?? '1' };
      return runParallelTasks([
        (signal) => runBufferedCommand('gofmt', process.execPath, [path.join('scripts', 'run-gates.mjs'), 'gofmt'], { cwd: root, signal }),
        (signal) => runBufferedCommand('web-type-check', PNPM_BIN, ['--dir', 'web', 'type-check'], { cwd: root, signal }),
        (signal) => runBufferedCommand('tooling-type-check', PNPM_BIN, ['type-check:tooling'], { cwd: root, signal }),
        (signal) =>
          runBufferedCommand('logic-tests', PNPM_BIN, ['test:logic'], { cwd: root, env: sharedCpuEnv, signal }).then((result) => {
            if (!result.ok) return result;
            const slowCases = extractSlowVitestCases(result.output);
            if (slowCases.length === 0) return result;
            return {
              ...result,
              diagnostics: slowCases.map(
                ({ file, title, durationMs }) =>
                  `[gate] SLOW logic-tests: ${file ? `${file} > ` : ''}${title} (${durationMs}ms)`,
              ),
            };
          }),
        (signal) => runBufferedCommand('go-test-short', GO_BIN, ['test', '-short', './...'], { cwd: root, signal }),
      ]);
    }

    case 'static-go': {
      if (!(await runGateMode('gofmt', { root }))) return false;
      if (!(await runStreamingStep(GO_BIN, ['test', './...'], { cwd: root }))) return false;
      return runStreamingStep(GO_BIN, ['vet', './...'], { cwd: root });
    }

    case 'static-repository': {
      const testFiles = discoverNodeSelfTestFiles(root);
      const demoPipeline = async (signal) => {
        const startedAt = performance.now();
        const gen = await runBufferedCommand(
          'demo-dataset',
          process.execPath,
          ['scripts/generate-demo-data.mjs', '--if-missing'],
          { cwd: root, signal },
        );
        if (!gen.ok) return gen;

        const [selfTests, demoContract] = await Promise.all([
          runBufferedCommand(
            'self-tests',
            process.execPath,
            ['--import', 'tsx', '--test', '--test-concurrency=2', ...testFiles],
            { cwd: root, signal },
          ),
          runBufferedCommand(
            'check-demo',
            process.execPath,
            ['--import', 'tsx', 'scripts/check-demo.ts'],
            { cwd: root, signal },
          ),
        ]);
        const durationMs = Math.round(performance.now() - startedAt);
        const completedFailures = [selfTests, demoContract].filter((item) => !item.ok && !item.aborted);
        if (completedFailures.length > 0) {
          return {
            label: completedFailures.map((item) => item.label).join(' + '),
            ok: false,
            aborted: false,
            durationMs,
            output: completedFailures
              .map((item) => (item.output ? `[${item.label}]\n${item.output}` : `[${item.label}] failed`))
              .join('\n\n'),
          };
        }
        if (selfTests.aborted || demoContract.aborted) {
          return {
            label: 'demo-and-self-tests',
            ok: false,
            aborted: true,
            durationMs,
            output: '',
          };
        }
        return {
          label: 'demo-and-self-tests',
          ok: true,
          aborted: false,
          durationMs,
          output: '',
        };
      };

      return runParallelTasks([
        (signal) => runBufferedCommand('check:openui-prompt', process.execPath, ['--import', 'tsx', 'scripts/generate-openui-prompt.ts', '--check'], { cwd: root, signal }),
        (signal) => runBufferedCommand('check-i18n', process.execPath, ['--import', 'tsx', 'scripts/check-i18n.ts'], { cwd: root, signal }),
        (signal) => runBufferedCommand('check-brand', process.execPath, ['scripts/sync-brand.mjs', '--check'], { cwd: root, signal }),
        (signal) => runBufferedCommand('check-css-modules', process.execPath, ['scripts/check-css-modules.mjs'], { cwd: root, signal }),
        (signal) => runBufferedCommand('check:feedback', process.execPath, ['scripts/check-feedback.mjs'], { cwd: root, signal }),
        (signal) => runBufferedCommand('check:openapi', process.execPath, ['scripts/generate-openapi.mjs', '--check'], { cwd: root, signal }),
        demoPipeline,
      ]);
    }

    default:
      throw new Error(`Unknown gate mode: ${mode ?? '(missing)'}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  runGateMode(mode)
    .then((ok) => {
      if (!ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`run-gates: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
