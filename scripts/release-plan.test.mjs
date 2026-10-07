import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import YAML from 'yaml';
import { createReleasePlan, compareReleaseTags } from './release-plan.mjs';

import { validateReleaseWorkflow } from './release-workflow.mjs';

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
  const prepare = missingBrowser.jobs.browser.steps.find(step => step.id === 'prepare');
  prepare.run = prepare.run.replace('node scripts/install-chromium.mjs', 'true');
  assert.throws(() => validateReleaseWorkflow(missingBrowser));
  const missingShard = structuredClone(workflow);
  missingShard.jobs.probes.strategy.matrix.shard.pop();
  assert.throws(() => validateReleaseWorkflow(missingShard));
  const mutable = structuredClone(workflow);
  mutable.jobs.identity.steps[0].uses = 'actions/checkout@v7';
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

test('native release publication rejects shared dependency cache restoration', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  validateReleaseWorkflow(workflow);
  for (const alter of [
    value => { value.jobs.native.steps.find(step => step.uses?.startsWith('pnpm/action-setup@')).with.cache = true; },
    value => { delete value.jobs.native.steps.find(step => step.uses?.startsWith('pnpm/action-setup@')).with.cache; },
    value => { value.jobs.native.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with.cache = 'pnpm'; },
    value => { value.jobs.native.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['package-manager-cache'] = true; },
    value => { delete value.jobs.native.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['package-manager-cache']; },
    value => { value.jobs.native.steps.find(step => step.uses?.startsWith('actions/setup-go@')).with.cache = true; },
    value => { delete value.jobs.native.steps.find(step => step.uses?.startsWith('actions/setup-go@')).with.cache; },
    value => { value.jobs.native.steps.push({ uses: `actions/cache@${'a'.repeat(40)}` }); },
  ]) {
    const broken = structuredClone(workflow);
    alter(broken);
    assert.throws(() => validateReleaseWorkflow(broken));
  }
});

test('every publication consumer is pinned to the verified commit and rechecks tag identity', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  for (const name of ['publish', 'release', 'promote']) {
    const broken = structuredClone(workflow);
    broken.jobs[name].steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref = 'unverified-ref';
    assert.throws(() => validateReleaseWorkflow(broken), name);
  }
});

test('release aggregate refuses skipped, bypassed or incomplete verification', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  for (const mutate of [
    value => { value.jobs.verify.needs.pop(); },
    value => { delete value.jobs.verify.if; },
    value => { value.jobs.verify.steps[0].run = 'true'; },
    value => { value.jobs.browser.steps.find(step => step.run === 'pnpm verify:browser').if = 'false'; },
    value => { value.jobs.publish.steps = value.jobs.publish.steps.filter(step => step.run !== 'node scripts/release-identity.mjs'); },
  ]) {
    const broken = structuredClone(workflow); mutate(broken);
    assert.throws(() => validateReleaseWorkflow(broken));
  }
});


test('release verification refuses skipped, conditional and softened prerequisites', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  for (const mutate of [
    value => { value.jobs.verify['continue-on-error'] = true; },
    value => { value.jobs.verify.steps[0].if = 'false'; },
    value => { value.jobs.verify.steps[0]['continue-on-error'] = true; },
    value => { value.jobs.static.if = 'false'; },
    value => { value.jobs.static.steps.find(step => step.run === 'pnpm verify:static').if = 'false'; },
    value => { value.jobs.browser.steps.find(step => step.run === 'pnpm verify:browser')['continue-on-error'] = true; },
  ]) {
    const value = structuredClone(workflow); mutate(value);
    assert.throws(() => validateReleaseWorkflow(value), undefined, mutate.toString());
  }
});


test('identity bootstrap and publication boundary checks cannot be softened', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const mutations = [
    value => { value.jobs.identity.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with.cache = 'pnpm'; },
    value => { delete value.jobs.identity.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['package-manager-cache']; },
    value => { value.jobs.identity.steps.find(step => step.id === 'plan').if = 'false'; },
  ];
  for (const name of ['publish', 'native', 'release', 'promote']) {
    mutations.push(value => { value.jobs[name].steps.find(step => step.run === 'node scripts/release-identity.mjs').if = 'false'; });
    mutations.push(value => { value.jobs[name].steps.find(step => step.run === 'node scripts/release-identity.mjs')['continue-on-error'] = true; });
    mutations.push(value => { value.jobs[name]['continue-on-error'] = true; });
  }
  for (const mutate of mutations) {
    const broken = structuredClone(workflow); mutate(broken);
    assert.throws(() => validateReleaseWorkflow(broken));
  }
});
