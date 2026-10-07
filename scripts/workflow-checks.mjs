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
  const uploadIndex = browserSteps.findIndex((step) => /^(?:release-)?bundle-report$/.test(step.with?.name ?? ''));
  const upload = browserSteps[uploadIndex];
  if (uploadIndex <= demoIndex || !upload?.uses?.startsWith('actions/upload-artifact@')
      || upload.if !== "always() && steps.prepare.outcome == 'success'"
      || upload.with['if-no-files-found'] !== 'error') throw new Error('CI must retain bundle evidence even when a check fails');
}

/**
 * Every event runs the full built suite against the same prepared binaries.
 */
export function validateBrowserPhases(browserSteps) {
  const full = browserSteps.filter(step => step.run === 'pnpm verify:browser');
  if (full.length !== 1 || full[0].if || full[0]['continue-on-error']) throw new Error('Every event must run full built acceptance once');
  if (full[0].env?.OMCPA_BROWSER_BINARY !== 'tmp/oh-my-cpa-browser'
      || full[0].env?.OMCPA_SEED_USAGE_BINARY !== 'tmp/seed-usage-browser') {
    throw new Error('Full acceptance must reuse both prepared binaries');
  }
  const harness = browserSteps.filter(step => step.run === 'pnpm verify:browser:harness');
  if (harness.length !== 1 || harness[0].if || harness[0]['continue-on-error']) throw new Error('Browser fault-injection evidence is mandatory');
  if (browserSteps.some(step => /verify:browser:p0|verify:browser:smoke/.test(step.run ?? ''))) {
    throw new Error('A reduced browser lane must not replace or duplicate full acceptance');
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
  if (probes.if || probes['continue-on-error']) throw new Error('the probe job must run on pull requests and master alike');
  const shards = probes.strategy?.matrix?.shard;
  if (!Array.isArray(shards) || shards.length === 0 || !shards.every((shard, index) => shard === index + 1)) {
    throw new Error('the probe matrix must list shards 1..n');
  }
  if (probes.strategy['fail-fast'] !== false) {
    throw new Error('one failing probe shard must not cancel the others');
  }
  const run = probes.steps?.find((step) => /pnpm verify:probes/.test(step.run ?? ''));
  if (run?.if || run?.['continue-on-error'] || run?.run !== `pnpm verify:probes --shard \${{ matrix.shard }}/${shards.length}`) {
    throw new Error(`the probe step must run shard \${{ matrix.shard }}/${shards.length}`);
  }
  if (!probes.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@') && step.if === 'failure()')) {
    throw new Error('the probe job does not keep failure diagnostics');
  }
  if (!probes.steps.some(step => step.uses?.startsWith('actions/upload-artifact@') && step.with?.path === 'tmp/probe-timings/' && step.if === 'always()' && step.with['if-no-files-found'] === 'error' && !step['continue-on-error'])) throw new Error('Probe timing evidence must survive failures');
  const aggregate = jobs['probes-complete'];
  const needs = [aggregate?.needs].flat();
  if (!aggregate || aggregate['continue-on-error'] || !needs.includes('probes') || aggregate.if !== 'always()') {
    throw new Error('CI workflow has no aggregate probe check that runs after every shard');
  }
  if (!aggregate.steps?.some((step) => step.env?.PROBES_RESULT === '${{ needs.probes.result }}'
      && step.run === 'test "${PROBES_RESULT}" = success' && !step.if && !step['continue-on-error'])) {
    throw new Error('the aggregate probe check must fail unless every shard succeeded');
  }
}

export function validateActionSecurity(workflow) {
  for (const job of Object.values(workflow.jobs)) {
    if (job.uses && !/^\.\/\.github\/workflows\/[^@]+\.ya?ml$/.test(job.uses)
        && !/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w./-]+@[a-f0-9]{40}$/.test(job.uses)) {
      throw new Error('External reusable workflows must be SHA-pinned');
    }
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      if (!/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step.uses)) throw new Error('Actions must be SHA-pinned');
      if (step.uses.startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) {
        throw new Error('Checkout credentials must not persist');
      }
    }
  }
}
