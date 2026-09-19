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

// The three browser phases are one group and run concurrently. They are independent
// processes with their own Chromium and their own service under test (the probe run
// drives Vite and mocked routes; the acceptance run drives the built binary, the
// fake CPA and a seeded SQLite; the demo run drives the built binary in demo mode
// with no gateway at all), so none can observe another.
//
// Concurrency was rejected once because the acceptance suite failed under the
// contention. The failures were the suite's own CPU-sensitive reads - a footer read
// racing a refetch, and a poll wait with three intervals of headroom - and they
// reproduce on the unmodified baseline. Those are fixed; eight consecutive trials on
// a 2-CPU constraint now pass concurrently, where the baseline failed two in three.
//
// Measured under that same 2-CPU constraint: sequential 81.4s / 81.6s, concurrent
// 69.5s / 71.7s - about 12 seconds, and the gap is larger on more cores.
if (!await runChecks([
  { label: 'browser', command: 'pnpm', args: ['verify:browser'] },
  { label: 'probes', command: 'pnpm', args: ['verify:probes'] },
  { label: 'demo', command: 'pnpm', args: ['verify:demo'] },
])) process.exit(1);
