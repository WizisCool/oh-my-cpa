import { runChecks } from './parallel-checks.mjs';

if (!await runChecks([
  { label: 'toolchain', command: 'pnpm', args: ['verify:toolchain:strict'] },
])) process.exit(1);

if (!await runChecks([
  { label: 'static', command: 'pnpm', args: ['verify:static'] },
  { label: 'history-secrets', command: 'pnpm', args: ['verify:secrets:history'] },
  { label: 'build', command: 'pnpm', args: ['build'] },
])) process.exit(1);

if (!await runChecks([
  { label: 'worktree-secrets', command: 'pnpm', args: ['verify:secrets:worktree'] },
  { label: 'bundle-budget', command: 'node', args: ['scripts/check-bundle-budget.mjs'] },
])) process.exit(1);

if (!await runChecks([
  { label: 'browser', command: 'pnpm', args: ['verify:browser'] },
])) process.exit(1);
