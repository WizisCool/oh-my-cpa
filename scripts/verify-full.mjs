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

// The two browser phases are one group and run concurrently. They are independent
// processes with their own Chromium and their own service under test (the probe run
// drives Vite and mocked routes; the acceptance run drives the built binary, the
// fake CPA and a seeded SQLite), so neither can observe the other.
//
// Measured under a 2-CPU constraint, which is what a GitHub runner provides:
// sequential 81.4s / 81.6s, concurrent 69.5s / 71.7s - about 12 seconds, with no
// failure in any run. A 4-core machine shows the same direction (74s sequential,
// 60s concurrent). The contention is real but smaller than the tail of the longer
// phase, which is why the parallel form wins even on the smaller machine.
if (!await runChecks([
  { label: 'browser', command: 'pnpm', args: ['verify:browser'] },
  { label: 'probes', command: 'pnpm', args: ['verify:probes'] },
])) process.exit(1);
