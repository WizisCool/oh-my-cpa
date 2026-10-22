import assert from 'node:assert/strict';
import test from 'node:test';
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

