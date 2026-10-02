export function validateArtifactGates(browserSteps) {
  const preparationIndex = browserSteps.findIndex((step) => step.id === 'prepare');
  const preparation = browserSteps[preparationIndex]?.run ?? '';
  const buildIndex = preparation.indexOf('pnpm build');
  const binaryIndex = preparation.indexOf('go build -trimpath -o tmp/oh-my-cpa-browser');
  if (buildIndex < 0 || binaryIndex <= buildIndex || preparation.includes('pnpm check:bundle')) {
    throw new Error('CI must build the SPA and binary independently of bundle verification');
  }
  const bundleIndex = browserSteps.findIndex((step) => step.id === 'bundle');
  const bundle = browserSteps[bundleIndex];
  if (bundleIndex <= preparationIndex || bundle?.run !== 'pnpm check:bundle'
      || bundle['continue-on-error'] !== true || bundle.if) {
    throw new Error('CI must capture bundle failure without suppressing browser evidence');
  }
  const cleanIndex = browserSteps.findIndex((step) => step.name === 'Verify generated state before browser tests');
  const browserIndex = browserSteps.findIndex((step) => /pnpm verify:browser/.test(step.run ?? ''));
  if (cleanIndex <= bundleIndex || browserIndex <= cleanIndex) throw new Error('CI must check generated state before browser tests');
  if (!browserSteps[cleanIndex].run?.includes('test -z "$(git status --porcelain)"')) {
    throw new Error('the early generated-state gate must reject a dirty worktree');
  }
  const verdictIndex = browserSteps.findIndex((step) => step.name === 'Require bundle verification success');
  const verdict = browserSteps[verdictIndex];
  const demoIndex = browserSteps.findIndex((step) => step.run === 'pnpm verify:demo');
  if (verdictIndex <= browserIndex || verdictIndex <= demoIndex
      || verdict?.if !== "always() && steps.prepare.outcome == 'success'"
      || verdict.env?.BUNDLE_OUTCOME !== '${{ steps.bundle.outcome }}'
      || verdict.run !== 'test "${BUNDLE_OUTCOME}" = success' || verdict['continue-on-error']) {
    throw new Error('CI must fail the browser job on any failed or skipped bundle verdict');
  }
  const uploadIndex = browserSteps.findIndex((step) => step.with?.name === 'bundle-report');
  const upload = browserSteps[uploadIndex];
  if (uploadIndex <= demoIndex || upload?.uses !== 'actions/upload-artifact@v7'
      || upload.if !== "always() && steps.prepare.outcome == 'success'"
      || upload.with['if-no-files-found'] !== 'error') throw new Error('CI must retain bundle evidence even when a check fails');
}

/**
 * The browser job's test phases: pull requests run P0 (which contains the smoke path),
 * master runs the whole acceptance suite, and both reuse the prepared binary.
 */
export function validateBrowserPhases(browserSteps) {
  const pullRequest = "github.event_name == 'pull_request'";
  const master = "github.event_name != 'pull_request'";
  const p0 = browserSteps.find((step) => step.run === 'pnpm verify:browser:p0');
  if (p0?.if !== pullRequest) throw new Error('CI workflow has no pull-request browser P0 gate');
  const full = browserSteps.find((step) => step.run === 'pnpm verify:browser');
  if (full?.if !== master) throw new Error('CI workflow does not run the whole browser acceptance on master');
  for (const step of [p0, full]) {
    if (step.env?.OMCPA_BROWSER_BINARY !== 'tmp/oh-my-cpa-browser') {
      throw new Error(`${step.name} does not reuse the prepared browser binary`);
    }
  }
}

/**
 * The probe catalog runs as disjoint shards on every event, and one aggregate check
 * fails unless every shard passed. A shard count that disagrees with the matrix
 * would leave part of the catalog unrun while every job reported green.
 */
export function validateProbeJobs(jobs) {
  const probes = jobs.probes;
  if (!probes) throw new Error('CI workflow has no probe job');
  if (probes.if) throw new Error('the probe job must run on pull requests and master alike');
  const shards = probes.strategy?.matrix?.shard;
  if (!Array.isArray(shards) || shards.length === 0 || !shards.every((shard, index) => shard === index + 1)) {
    throw new Error('the probe matrix must list shards 1..n');
  }
  if (probes.strategy['fail-fast'] !== false) {
    throw new Error('one failing probe shard must not cancel the others');
  }
  const run = probes.steps?.find((step) => /pnpm verify:probes/.test(step.run ?? ''));
  if (run?.run !== `pnpm verify:probes --shard \${{ matrix.shard }}/${shards.length}`) {
    throw new Error(`the probe step must run shard \${{ matrix.shard }}/${shards.length}`);
  }
  if (!probes.steps.some((step) => step.uses === 'actions/upload-artifact@v7' && step.if === 'failure()')) {
    throw new Error('the probe job does not keep failure diagnostics');
  }
  const aggregate = jobs['probes-complete'];
  const needs = [aggregate?.needs].flat();
  if (!aggregate || !needs.includes('probes') || !/always\(\)/.test(aggregate.if ?? '')) {
    throw new Error('CI workflow has no aggregate probe check that runs after every shard');
  }
  if (!aggregate.steps?.some((step) => step.env?.PROBES_RESULT === '${{ needs.probes.result }}'
      && step.run === 'test "${PROBES_RESULT}" = success')) {
    throw new Error('the aggregate probe check must fail unless every shard succeeded');
  }
}
