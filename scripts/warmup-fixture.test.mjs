import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWarmupFixture, WARMUP_CONTRACT } from './acceptance/warmup-fixture.mjs';

test('warmup fixture uses the certified refusal corpus and isolates state per context', () => {
  const fixture = createWarmupFixture();
  const run = new URL('http://console.test/api/v1/management/quota/warmup/credentials/exact-claude/run');
  for (const entry of WARMUP_CONTRACT.cases) {
    const result = fixture(run, 'POST', JSON.stringify(entry.body));
    assert.equal(result.status, entry.status); assert.deepEqual(result.json, entry.response);
  }
  const credential = new URL('http://console.test/api/v1/management/quota/warmup/credentials/exact-claude');
  fixture(run, 'POST', JSON.stringify({ request_id: 'other-manual-id', revision: 'wire-revision', confirmed: true }));
  assert.equal(fixture(credential, 'GET', null).json.state.protocol_verified, true);
  assert.equal(createWarmupFixture()(credential, 'GET', null).json.state.protocol_verified, false);
});

test('warmup fixture validates each field rather than matching literal refusal bodies', () => {
  const run = new URL('http://console.test/api/v1/management/quota/warmup/credentials/exact-claude/run');
  for (const entry of WARMUP_CONTRACT.cases) {
    const fixture = createWarmupFixture();
    const body = { ...entry.body, ...('request_id' in entry.body && entry.id !== 'short-request-id' ? { request_id: 'a-different-request-id' } : {}) };
    const result = fixture(run, 'POST', JSON.stringify(body));
    assert.equal(result.status, entry.status, entry.id);
    assert.deepEqual(result.json, entry.response, entry.id);
  }
  const fixture = createWarmupFixture();
  const saved = fixture(new URL('http://console.test/api/v1/management/quota/warmup/credentials/exact-claude'), 'PUT', JSON.stringify({ inherit: false, policy: WARMUP_CONTRACT.credential.policy }));
  const refused = fixture(run, 'POST', JSON.stringify({ request_id: 'after-policy-save', revision: 'wire-revision', confirmed: true }));
  assert.equal(refused.status, 409);
  assert.equal(fixture(run, 'POST', JSON.stringify({ request_id: 'after-policy-save', revision: saved.json.revision, confirmed: true })).status, 200);
});
