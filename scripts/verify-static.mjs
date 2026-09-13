import { runChecks } from './parallel-checks.mjs';

const passed = await runChecks([
  { label: 'go', command: 'pnpm', args: ['verify:static:go'] },
  { label: 'frontend', command: 'pnpm', args: ['verify:static:frontend'] },
  { label: 'repository', command: 'pnpm', args: ['verify:static:repository'] },
]);

if (!passed) process.exit(1);
