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
  const verify = workflow.jobs.verify;
  assert.ok(verify.steps.some(step => step.run?.includes('pnpm verify:full')));
  const publish = workflow.jobs.publish;
  assert.equal(publish.needs, 'verify');
  const smokeIndex = publish.steps.findIndex(step => step.run?.includes('scripts/docker-smoke.mjs'));
  const imageIndex = publish.steps.findIndex(step => step.id === 'image');
  assert.ok(smokeIndex >= 0 && imageIndex > smokeIndex);
  const imageStep = publish.steps[imageIndex];
  assert.equal(imageStep.with.platforms, 'linux/amd64,linux/arm64');
  assert.equal(imageStep.with.push, true);
  assert.ok(imageStep.with['build-args'].includes('VERSION=${{ needs.verify.outputs.tag }}'));
  assert.equal(workflow.jobs.release.needs.includes('publish'), true);
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
});
