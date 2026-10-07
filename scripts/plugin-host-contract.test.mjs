import assert from 'node:assert/strict';
import test from 'node:test';
import { auditNativePluginHostResponse, settleNativeResponseAudits, hasPluginHostProtectedSecret, isNativePluginHostResponse } from './acceptance/configuration-plugins.mjs';

test('secret-bearing evidence exception is limited to exact native host API surfaces', () => {
  for (const basePath of ['', '/omc', '/console/custom']) {
    const appURL = `http://127.0.0.1:8317${basePath}`;
    for (const suffix of ['/v0/management/config', '/v8/management/config/api-keys?kind=codex', '/v1/models', '/v1/models?scope=all']) {
      assert.ok(isNativePluginHostResponse(`${appURL}/api/v1/plugin-host${suffix}`, appURL));
    }
    for (const url of [
      `${appURL}/api/v1/management/config`,
      `${appURL}/api/v1/management/plugins`,
      `${appURL}/api/v1/plugin-host/v0/resource/plugins/example/ui`,
      `${appURL}/api/v1/plugin-host/v1/models-extra`,
      `${appURL}/api/v1/plugin-host/v1/models/extra`,
      `${appURL}/api/v1/plugin-host/v1/chat/completions`,
      `${appURL}/api/v1/plugin-host-other/v8/management/config`,
      'http://other.example/omc/api/v1/plugin-host/v8/management/config',
    ]) {
      assert.equal(isNativePluginHostResponse(url, appURL), false, url);
    }
  }
});

test('native startup permits client/provider keys but still detects protected fixture secrets', () => {
  const protectedSecrets = ['management-fixture', 'oauth-fixture'];
  const nativeConfig = { 'api-keys': ['client-fixture'], 'codex-api-key': [{ 'api-key': 'provider-fixture' }] };
  assert.equal(hasPluginHostProtectedSecret(JSON.stringify(nativeConfig), protectedSecrets), false);
  for (const secret of protectedSecrets) {
    assert.equal(hasPluginHostProtectedSecret(JSON.stringify({ ...nativeConfig, unexpected: secret }), protectedSecrets), true);
    assert.equal(hasPluginHostProtectedSecret(`upstream error: ${secret}`, protectedSecrets), true);
  }
});

test('native response audit fails on protected secrets or unreadable evidence', async () => {
  const outcomes = [];
  const check = (label, passed, detail) => outcomes.push({ label, passed, detail });
  const url = 'http://127.0.0.1:8317/omc/api/v1/plugin-host/v0/management/config';
  for (const body of ['{"api-keys":["client-fixture"]}', 'unexpected management-fixture', 'unexpected oauth-fixture']) {
    await auditNativePluginHostResponse({ url: () => url, text: async () => body }, ['management-fixture', 'oauth-fixture'], check);
  }
  await auditNativePluginHostResponse({ url: () => url, text: async () => { throw new Error('response disposed'); } }, ['management-fixture', 'oauth-fixture'], check);
  assert.deepEqual(outcomes.map(outcome => outcome.passed), [true, false, false, false]);
  assert.match(outcomes.at(-1).label, /readable/);
  assert.equal(outcomes.at(-1).detail, url);
});


test('final native verdict waits for pending evidence and retains rejected audits', async () => {
  let releaseAudit;
  const evidence = new Promise(resolve => { releaseAudit = resolve; });
  const outcomes = [];
  let hasSettled = false;
  const settlement = settleNativeResponseAudits([evidence, Promise.reject(new Error('audit interrupted'))],
    (label, passed, detail) => outcomes.push({ label, passed, detail })).then(() => { hasSettled = true; });
  await Promise.resolve();
  assert.equal(hasSettled, false);
  releaseAudit();
  await settlement;
  assert.equal(hasSettled, true);
  assert.deepEqual(outcomes, [{ label: 'native response audit completed', passed: false, detail: 'audit interrupted' }]);
});
