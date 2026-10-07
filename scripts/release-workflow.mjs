import assert from 'node:assert/strict';
import { validateArtifactGates, validateProbeJobs, validateActionSecurity, validateBrowserPhases } from './workflow-checks.mjs';

export function validateReleaseWorkflow(workflow) {
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.concurrency.queue, 'max');
  assert.equal(workflow.permissions.contents, 'read');
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (jobName !== 'release') assert.equal(job.permissions?.contents ?? workflow.permissions.contents, 'read');
    for (const step of job.steps.filter(step => step.uses)) {
      assert.match(step.uses, /@[a-f0-9]{40}$/, 'Release actions use immutable revisions');
      if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
    }
  }
  validateActionSecurity(workflow);
  const identity = workflow.jobs.identity;
  assert.ok(!identity.if && !identity['continue-on-error']);
  const identityNode = identity.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(identityNode.with.cache, undefined, 'Identity resolution has no pnpm installation to cache');
  assert.equal(identityNode.with['package-manager-cache'], false);
  const identityPlan = identity.steps.find(step => step.id === 'plan');
  assert.ok(identityPlan && !identityPlan.if && !identityPlan['continue-on-error']);
  const verify = workflow.jobs.verify;
  assert.deepEqual(verify.needs, ['identity', 'static', 'browser', 'probes-complete']);
  assert.equal(verify.if, 'always()');
  assert.ok(!verify['continue-on-error']);
  const verdict = verify.steps[0];
  assert.ok(!verdict.if && !verdict['continue-on-error']);
  for (const [name, id] of [['IDENTITY','identity'], ['STATIC','static'], ['BROWSER','browser'], ['PROBES','probes-complete']]) {
    assert.equal(verdict.env[name], '${{ needs.' + id + '.result }}');
    assert.ok(verdict.run.includes('test "$' + name + '" = success'));
  }
  for (const name of ['static', 'browser', 'probes']) {
    const job = workflow.jobs[name];
    assert.equal(job.needs, 'identity');
    assert.ok(!job.if && !job['continue-on-error']);
    assert.equal(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ needs.identity.outputs.revision }}');
  }
  const bundle = workflow.jobs.browser.steps.find(step => step.id === 'bundle');
  assert.equal(bundle.env?.BUNDLE_BASE_SHA, '', 'Release bundle baseline must explicitly be unavailable, never the candidate itself');
  validateArtifactGates(workflow.jobs.browser.steps);
  validateBrowserPhases(workflow.jobs.browser.steps);
  validateProbeJobs(workflow.jobs);
  assert.ok(workflow.jobs.static.steps.some(step => step.run?.includes('pnpm verify:secrets:history')));
  assert.ok(workflow.jobs.static.steps.some(step => step.run === 'pnpm verify:static' && !step.if && !step['continue-on-error']));
  const preparation = workflow.jobs.browser.steps.find(step => step.id === 'prepare');
  assert.ok(preparation.run.includes('install-chromium.mjs'));
  const full = workflow.jobs.browser.steps.find(step => step.run === 'pnpm verify:browser');
  assert.ok(full && !full.if);
  for (const name of ['publish', 'native', 'release', 'promote']) {
    const job = workflow.jobs[name];
    assert.ok(!job['continue-on-error']);
    assert.ok(!job.if || (name === 'promote' && job.if === "needs.verify.outputs.is_latest == 'true'"));
    const steps = job.steps;
    assert.equal(steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ needs.verify.outputs.revision }}');
    const identityChecks = steps.filter(step => step.run === 'node scripts/release-identity.mjs');
    assert.ok(identityChecks.length > 0);
    assert.ok(identityChecks.every(step => (!step.if || (name === 'promote' && step.if === "steps.plan.outputs.is_latest == 'true'")) && !step['continue-on-error']));
    assert.ok(steps.some(step => step.run === 'node scripts/release-identity.mjs'
      && step.env.RELEASE_REVISION === '${{ needs.verify.outputs.revision }}'
      && step.env.RELEASE_TAG === '${{ needs.verify.outputs.tag }}'
      && !step.if && !step['continue-on-error']));
  }
  const publish = workflow.jobs.publish;
  assert.equal(publish.needs, 'verify');
  const smokeIndex = publish.steps.findIndex(step => step.run?.includes('scripts/docker-smoke.mjs'));
  const imageIndex = publish.steps.findIndex(step => step.id === 'image');
  assert.ok(smokeIndex >= 0 && imageIndex > smokeIndex);
  const imageStep = publish.steps[imageIndex];
  assert.equal(imageStep.with.platforms, 'linux/amd64,linux/arm64');
  assert.equal(imageStep.with.push, true);
  assert.ok(imageStep.with['build-args'].includes('VERSION=${{ needs.verify.outputs.tag }}'));
  assert.deepEqual(workflow.jobs.release.needs, ['verify', 'publish', 'native']);
  assert.equal(workflow.jobs.native.needs, 'verify');
  const nativeSteps = workflow.jobs.native.steps;
  const nativePnpm = nativeSteps.find(step => step.uses?.startsWith('pnpm/action-setup@'));
  const nativeNode = nativeSteps.find(step => step.uses?.startsWith('actions/setup-node@'));
  const nativeGo = nativeSteps.find(step => step.uses?.startsWith('actions/setup-go@'));
  assert.equal(nativePnpm.with?.cache, false, 'Published native artifacts must not restore the shared pnpm cache');
  assert.equal(nativeNode.with['package-manager-cache'], false, 'Published native artifacts must disable automatic package caching');
  assert.equal(nativeNode.with.cache, undefined, 'Published native artifacts must not select a dependency cache');
  assert.equal(nativeGo.with.cache, false, 'Published native artifacts must not restore shared Go caches');
  assert.ok(!nativeSteps.some(step => step.uses?.startsWith('actions/cache@')), 'Native publication must not add a direct shared cache');
  assert.equal(nativeSteps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ needs.verify.outputs.revision }}');
  const nativeBuildIndex = nativeSteps.findIndex(step => step.run === 'node scripts/native-release.mjs');
  const nativeSmokeIndex = nativeSteps.findIndex(step => step.run === 'node scripts/native-release-smoke.mjs');
  const nativeUploadIndex = nativeSteps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(nativeBuildIndex >= 0 && nativeSmokeIndex > nativeBuildIndex && nativeUploadIndex > nativeSmokeIndex);
  assert.equal(nativeSteps[nativeUploadIndex].with['if-no-files-found'], 'error');
  assert.equal(nativeSteps[nativeUploadIndex].with.name, 'native-release');
  const releaseSteps = workflow.jobs.release.steps;
  const downloadIndex = releaseSteps.findIndex(step => step.uses?.startsWith('actions/download-artifact@'));
  const publicationIndex = releaseSteps.findIndex(step => step.run?.includes('gh release create'));
  assert.ok(downloadIndex >= 0 && publicationIndex > downloadIndex);
  assert.equal(releaseSteps[downloadIndex].with.name, 'native-release');
  const publication = releaseSteps[publicationIndex].run;
  assert.ok(publication.includes('native-release.mjs --verify'));
  assert.ok(publication.indexOf('native-release.mjs --verify') < publication.indexOf('gh release upload'));
  assert.ok(publication.includes('gh release upload "$RELEASE_TAG" tmp/native-release/* --clobber'));
  assert.ok(publication.includes('gh release create "$RELEASE_TAG" tmp/native-release/*'));
  assert.ok(publication.includes('--generate-notes --draft --latest=false'));
  assert.ok(publication.includes('gh release edit "$RELEASE_TAG" --draft=false --latest="$IS_LATEST"'));
  assert.ok(publication.lastIndexOf('IS_LATEST=$(node scripts/release-plan.mjs') > publication.indexOf('gh release upload'));
  assert.ok(publication.indexOf('gh release edit') > publication.indexOf('gh release create'));
  assert.equal(workflow.jobs.release.permissions.contents, 'write');
  assert.deepEqual(workflow.jobs.promote.needs, ['verify', 'publish', 'release']);
  assert.ok(workflow.jobs.promote.steps.some(step => step.run?.includes('imagetools create')));
  assert.equal(workflow.jobs.verify.outputs.tags, '${{ needs.identity.outputs.tags }}');
  assert.ok(workflow.jobs.release.steps.some(step => step.run?.includes('gh release create')));
}
