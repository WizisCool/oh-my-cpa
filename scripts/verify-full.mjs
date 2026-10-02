import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './parallel-checks.mjs';

export async function runFullVerification({ execute = runChecks, isSerial = false } = {}) {
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
  if (!await runGroup([
    ...(isSerial ? [
      { label: 'static-go', command: 'pnpm', args: ['verify:static:go'] },
      { label: 'static-frontend', command: 'pnpm', args: ['verify:static:frontend'] },
      { label: 'static-repository', command: 'pnpm', args: ['verify:static:repository'] },
    ] : [{ label: 'static', command: 'pnpm', args: ['verify:static'] }]),
    { label: 'history-secrets', command: 'pnpm', args: ['verify:secrets:history'] },
    { label: 'build', command: 'pnpm', args: ['build'] },
  ])) return false;
  if (!await runGroup([{ label: 'worktree-secrets', command: 'pnpm', args: ['verify:secrets:worktree'] }])) return false;

  // Bundle policy is a separate verdict, not a prerequisite for browser evidence.
  // Every verdict is retained: a successful browser cannot erase a bundle failure.
  const hasPassedBundle = await runGroup([{ label: 'bundle', command: 'pnpm', args: ['check:bundle'] }]);
  const hasPassedBrowser = await runGroup([
    { label: 'browser', command: 'pnpm', args: ['verify:browser'] },
    { label: 'probes', command: 'pnpm', args: ['verify:probes'] },
  ]);
  // The demo has its own server; keep it out of the CPU-sensitive browser group.
  const hasPassedDemo = await runGroup([{ label: 'demo', command: 'pnpm', args: ['verify:demo'] }]);
  return hasPassedBundle && hasPassedBrowser && hasPassedDemo;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((argument) => argument !== '--serial')) throw new Error('Only --serial is supported');
  if (!await runFullVerification({ isSerial: process.argv.includes('--serial') })) process.exitCode = 1;
}
