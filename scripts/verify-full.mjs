import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './parallel-checks.mjs';
import { parseProbePort } from './acceptance/probe-options.mjs';

export async function runFullVerification({ execute = runChecks, isSerial = false, probePort } = {}) {
  if (probePort !== undefined) parseProbePort(probePort);
  async function runGroup(checks) {
    if (!isSerial) return execute(checks);
    let hasPassed = true;
    for (const check of checks) {
      if (!await execute([check])) hasPassed = false;
    }
    return hasPassed;
  }
  // Build and secret/toolchain correctness remain prerequisites for serving a binary.
  if (!await runGroup([{ label: 'toolchain', command: 'pnpm', args: ['verify:toolchain:strict'] }])) return false;
  // Go's embed walks files by path; pruning a distribution during that walk can
  // invalidate an already-enumerated asset even when HTML is copied last.
  if (!await runGroup([{ label: 'build', command: 'pnpm', args: ['build'] }])) return false;
  if (!await runGroup([
    ...(isSerial ? [
      { label: 'static-go', command: 'pnpm', args: ['verify:static:go'] },
      { label: 'static-frontend', command: 'pnpm', args: ['verify:static:frontend'] },
      { label: 'static-repository', command: 'pnpm', args: ['verify:static:repository'] },
    ] : [{ label: 'static', command: 'pnpm', args: ['verify:static'] }]),
    { label: 'history-secrets', command: 'pnpm', args: ['verify:secrets:history'] },
  ])) return false;
  if (!await runGroup([{ label: 'worktree-secrets', command: 'pnpm', args: ['verify:secrets:worktree'] }])) return false;

  // Bundle policy is a separate verdict, not a prerequisite for browser evidence.
  // Every verdict is retained: a successful browser cannot erase a bundle failure.
  const hasPassedBundle = await runGroup([{ label: 'bundle', command: 'pnpm', args: ['check:bundle'] }]);
  // Hosted lanes have separate runners. Locally they share CPU and Chromium
  // scheduling; overlapping them distorts frame assertions and lazy-route readiness.
  let hasPassedBrowser = true;
  for (const check of [
    { label: 'browser-harness', command: 'pnpm', args: ['verify:browser:harness'] },
    { label: 'browser', command: 'pnpm', args: ['verify:browser'] },
    { label: 'probes', command: 'pnpm', args: ['verify:probes', ...(isSerial ? ['--workers', '1'] : []), ...(probePort === undefined ? [] : ['--port', String(probePort)])] },
  ]) {
    if (!await runGroup([check])) hasPassedBrowser = false;
  }
  // The demo has its own server; keep it out of the CPU-sensitive browser group.
  const hasPassedDemo = await runGroup([{ label: 'demo', command: 'pnpm', args: ['verify:demo'] }]);
  return hasPassedBundle && hasPassedBrowser && hasPassedDemo;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  let isSerial = false, probePort;
  for (let i = 0; i < arguments_.length; i += 1) {
    if (arguments_[i] === '--serial' && !isSerial) isSerial = true;
    else if (arguments_[i] === '--probe-port' && probePort === undefined) probePort = parseProbePort(arguments_[++i]);
    else throw new Error('Expected [--serial] [--probe-port PORT]');
  }
  if (!await runFullVerification({ isSerial, probePort })) process.exitCode = 1;
}
