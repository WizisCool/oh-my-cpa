import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oauthManagementFixtures } from './acceptance/probes/oauthManagement.mjs';

test('OAuth warmup fixture binds provider and saved state to the exact credential within one scenario', () => {
  const routes = oauthManagementFixtures.routes;
  const request = (index, method = 'GET', body, suffix = '') => {
    const url = new URL(`http://console.test/omc/api/v1/management/quota/warmup/credentials/${index}${suffix}`);
    const route = routes.find(([matches]) => matches(url, method));
    return route[1](url, method, body ? JSON.stringify(body) : null);
  };
  for (const [index, provider] of [['auth-01', 'codex'], ['auth-12', 'codex'], ['auth-02', 'claude']]) {
    const credential = request(index).json;
    assert.equal(credential.provider, provider);
    assert.equal(credential.state.provider, provider);
    assert.equal(credential.auth_index, index);
    assert.equal(credential.models[0], provider === 'codex' ? 'gpt-codex-test' : 'claude-haiku-test');
  }
  const original = request('auth-01').json;
  const policy = { ...original.policy, model: 'gpt-codex-test' };
  const saved = request('auth-01', 'PUT', { inherit: false, policy, confirmed: true, revision: original.revision }).json;
  assert.deepEqual(request('auth-01').json.policy, policy);
  const result = request('auth-01', 'POST', { request_id: 'codex-fixture-run', revision: saved.revision, confirmed: true }, '/run');
  assert.equal(result.json.model, 'gpt-codex-test');
  assert.equal(request('auth-01').json.state.last_result.request_id, 'codex-fixture-run');
  assert.equal(request('auth-12').json.state.protocol_verified, false);
  const freshURL = new URL('http://console.test/omc/api/v1/management/quota/warmup/credentials/auth-01');
  const freshRoute = oauthManagementFixtures.routes.find(([matches]) => matches(freshURL, 'GET'));
  assert.equal(freshRoute[1](freshURL, 'GET', null).json.state.protocol_verified, false);
});
