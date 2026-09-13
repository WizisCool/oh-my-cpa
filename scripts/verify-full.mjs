import { runChecks } from './parallel-checks.mjs';

// The pinned toolchain is a precondition for every other gate: the other jobs are
// run by the toolchain this step validates, so a mismatch must fail before them
// rather than alongside them.
if (!await runChecks([
  { label: 'toolchain', command: 'pnpm', args: ['verify:toolchain:strict'] },
])) process.exit(1);

// Independent groups. `build` produces the SPA that `bundle-budget` measures and
// that the browser phase serves; `static` includes the Go tests, which compile the
// same embedded distribution. They are safe together because the build only writes
// `internal/web/dist`, and the Go tests read whatever is there - a Go test that
// depended on the build's output would be reading the previous run's bytes, which
// is why the embedded-stub consistency check is a separate gate (`git status` in
// CI) rather than something this orchestration relies on.
if (!await runChecks([
  { label: 'static', command: 'pnpm', args: ['verify:static'] },
  { label: 'history-secrets', command: 'pnpm', args: ['verify:secrets:history'] },
  { label: 'build', command: 'pnpm', args: ['build'] },
])) process.exit(1);

if (!await runChecks([
  { label: 'worktree-secrets', command: 'pnpm', args: ['verify:secrets:worktree'] },
  { label: 'bundle-budget', command: 'node', args: ['scripts/check-bundle-budget.mjs'] },
])) process.exit(1);

// The browser work is one group, not two jobs: both phases launch their own
// Chromium and their own dev server or Go binary, so running them concurrently on a
// small machine trades a shorter critical path for two browsers competing for the
// same cores. `verify:browser` already runs everything that needs the fake CPA;
// `verify:probes` adds the geometry, stacking and sequencing probes that used to be
// reachable only by remembering a command.
if (!await runChecks([
  { label: 'browser', command: 'pnpm', args: ['verify:browser'] },
  { label: 'probes', command: 'pnpm', args: ['verify:probes'] },
])) process.exit(1);
