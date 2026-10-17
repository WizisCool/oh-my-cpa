import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemUpdaterFixture, SYSTEM_UPDATER_CONTRACT } from './acceptance/system-updater-fixture.mjs';

const statusURL = new URL('http://console.test/api/v1/management/system/updater');
const applyURL = new URL('http://console.test/api/v1/management/system/updater/apply');

test('updater fixture answers with the certified corpus and keeps state per instance', () => {
  const fixture = createSystemUpdaterFixture();
  assert.deepEqual(fixture(statusURL, 'GET').json, SYSTEM_UPDATER_CONTRACT.ready);
  for (const refusal of SYSTEM_UPDATER_CONTRACT.refusals) {
    const answer = fixture(applyURL, 'POST', JSON.stringify(refusal.body));
    assert.equal(answer.status, refusal.status, refusal.id);
    assert.deepEqual(answer.json, refusal.response, refusal.id);
  }
  assert.equal(fixture(statusURL, 'GET').json.job, null, 'a refused update starts no job');

  const accepted = fixture(applyURL, 'POST', JSON.stringify(SYSTEM_UPDATER_CONTRACT.accepted.body));
  assert.equal(accepted.status, SYSTEM_UPDATER_CONTRACT.accepted.status);
  assert.deepEqual(accepted.json.job, SYSTEM_UPDATER_CONTRACT.accepted.job);
  fixture.advance('rolled_back', 'the replacement exited after starting');
  assert.deepEqual(fixture(statusURL, 'GET').json.job, {
    ...SYSTEM_UPDATER_CONTRACT.accepted.job, stage: 'rolled_back', finished: true, error: 'the replacement exited after starting',
  });
  fixture.admit('job-later');
  assert.deepEqual(fixture(statusURL, 'GET').json.job, {
    ...SYSTEM_UPDATER_CONTRACT.accepted.job, id: 'job-later', stage: 'pulling', error: '', finished: false,
  });
  assert.equal(createSystemUpdaterFixture()(statusURL, 'GET').json.job, null, 'another instance has no job');
});

test('updater fixture reports an absent updater without products', () => {
  assert.deepEqual(createSystemUpdaterFixture({ state: 'not_installed' })(statusURL, 'GET').json, SYSTEM_UPDATER_CONTRACT.not_installed);
});
