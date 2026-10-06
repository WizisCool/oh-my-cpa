import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import YAML from 'yaml';
import { createReleasePlan, compareReleaseTags } from './release-plan.mjs';

const INPUT = {tag: 'v0.1.0', packageVersion: '0.1.0', webVersion: '0.1.0', image: 'wiziscool/oh-my-cpa'};

test('first stable release names the image and both version aliases, then latest', () => {
  assert.deepEqual(createReleasePlan(INPUT).tags,
    ['wiziscool/oh-my-cpa:v0.1.0', 'wiziscool/oh-my-cpa:0.1.0', 'wiziscool/oh-my-cpa:latest']);
});
test('backports cannot move latest backwards, regardless of publication order', () => {
  const plan = createReleasePlan({...INPUT, releases: [
    {tag_name: 'v0.2.0'}, {tag_name: 'v0.0.9'}, {tag_name: 'v9.0.0', prerelease: true},
  ]});
  assert.equal(plan.isLatest, false);
  assert.equal(plan.tags.length, 2);
  assert.equal(compareReleaseTags('v0.10.0', 'v0.9.99'), 1);
  assert.equal(createReleasePlan({...INPUT, releases: [{tag_name: 'v9.0.0', draft: true}]}).isLatest, true);
});
test('malformed or mismatched release identities never reach Docker or GitHub', () => {
  for (const tag of ['v0.1.0-rc.1', 'v0.1.0+meta', 'v01.1.0', '0.1.0', 'v1.2', 'v0.1.0\nother=value']) {
    assert.throws(() => createReleasePlan({...INPUT, tag}));
  }
  assert.throws(() => createReleasePlan({...INPUT, packageVersion: '0.2.0'}));
  assert.throws(() => createReleasePlan({...INPUT, webVersion: '0.2.0'}));
  for (const image of ['WizisCool/omc', 'docker.io/wiziscool/omc', 'wiziscool/omc:latest', 'wiziscool/omc\nkey=bad']) {
    assert.throws(() => createReleasePlan({...INPUT, image}));
  }
});

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
  const verify = workflow.jobs.verify;
  const installIndex = verify.steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile');
  const chromiumIndex = verify.steps.findIndex(step => step.run === 'node scripts/install-chromium.mjs');
  const gatesIndex = verify.steps.findIndex(step => step.run === 'pnpm verify:full');
  assert.ok(installIndex >= 0 && chromiumIndex > installIndex && gatesIndex > chromiumIndex,
    'Fresh release runners must provision a launchable browser before running all gates');
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
  assert.equal(workflow.jobs.verify.outputs.tags, '${{ steps.plan.outputs.version_tags }}');
  assert.ok(workflow.jobs.release.steps.some(step => step.run?.includes('gh release create')));
}

test('release pipeline gates image publishing and GitHub visibility in order', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  validateReleaseWorkflow(workflow);
  const broken = structuredClone(workflow);
  broken.jobs.publish.steps.find(step => step.id === 'image').with.push = false;
  assert.throws(() => validateReleaseWorkflow(broken));
  const ungated = structuredClone(workflow);
  ungated.jobs.publish.needs = [];
  assert.throws(() => validateReleaseWorkflow(ungated));
  const unqueued = structuredClone(workflow);
  delete unqueued.concurrency.queue;
  assert.throws(() => validateReleaseWorkflow(unqueued));
  const missingBrowser = structuredClone(workflow);
  missingBrowser.jobs.verify.steps = missingBrowser.jobs.verify.steps.filter(step => step.run !== 'node scripts/install-chromium.mjs');
  assert.throws(() => validateReleaseWorkflow(missingBrowser));
  const lateBrowser = structuredClone(workflow);
  lateBrowser.jobs.verify.steps.push(lateBrowser.jobs.verify.steps.splice(
    lateBrowser.jobs.verify.steps.findIndex(step => step.run === 'node scripts/install-chromium.mjs'), 1)[0]);
  assert.throws(() => validateReleaseWorkflow(lateBrowser));
  const mutable = structuredClone(workflow);
  mutable.jobs.verify.steps[0].uses = 'actions/checkout@v7';
  assert.throws(() => validateReleaseWorkflow(mutable));
  const persisted = structuredClone(workflow);
  persisted.jobs.release.steps[0].with['persist-credentials'] = true;
  assert.throws(() => validateReleaseWorkflow(persisted));
});

test('native release publication rejects missing build, smoke, transfer and integrity gates', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  for (const alter of [
    value => { value.jobs.release.needs = ['verify', 'publish']; },
    value => { value.jobs.native.needs = []; },
    value => { value.jobs.native.permissions = { contents: 'write' }; },
    value => { const step = value.jobs.release.steps.find(step => step.run?.includes('gh release create')); step.run = step.run.replace('--generate-notes --draft --latest=false', '--generate-notes'); },
    value => { value.jobs.native.steps = value.jobs.native.steps.filter(step => !step.run?.includes('native-release-smoke')); },
    value => { value.jobs.release.steps = value.jobs.release.steps.filter(step => !step.uses?.startsWith('actions/download-artifact@')); },
    value => { const step = value.jobs.release.steps.find(step => step.run?.includes('gh release create')); step.run = step.run.replace('node scripts/native-release.mjs --verify', ''); },
    value => { value.jobs.native.steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).with['if-no-files-found'] = 'warn'; },
  ]) {
    const broken = structuredClone(workflow);
    alter(broken);
    assert.throws(() => validateReleaseWorkflow(broken));
  }
});
