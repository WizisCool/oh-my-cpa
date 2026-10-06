import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { createFakeCpaServer, FAKE_CLIENT_SECRET, FAKE_CPA_MANAGEMENT_KEY, FAKE_PROVIDER_SECRET, FAKE_ACCOUNT_SECRET } from './fake-cpa.mjs';

async function startFixture(context) {
  const { server } = createFakeCpaServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  return (path, key, options = {}) => fetch(`${baseURL}${path}`, {
    ...options,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...options.headers },
  });
}

test('gateway directory authenticates client keys independently of management reads', async (context) => {
  const request = await startFixture(context);
  for (const key of [undefined, 'invalid', FAKE_CPA_MANAGEMENT_KEY]) {
    assert.equal((await request('/v1/models', key)).status, 401);
  }
  assert.equal((await request('/v8/management/config', FAKE_CLIENT_SECRET)).status, 401);
  assert.equal((await request('/v8/management/config', FAKE_CPA_MANAGEMENT_KEY)).status, 200);
  const reply = await request('/v1/models', FAKE_CLIENT_SECRET);
  assert.equal(reply.status, 200);
  const body = await reply.json();
  assert.equal(body.object, 'list');
  const identities = body.data.map((model) => model.id);
  assert.ok(identities.includes('gpt-e2e'));
  assert.ok(identities.includes('gpt-e2e-preview'));
  assert.ok(identities.includes('sonnet-latest'));
  assert.ok(!identities.includes('claude-3-5-sonnet'));
  assert.equal(new Set(identities).size, identities.length);
  for (const model of body.data) assert.deepEqual(Object.keys(model).sort(), ['id', 'object', 'owned_by']);
  for (const secret of [FAKE_CLIENT_SECRET, FAKE_CPA_MANAGEMENT_KEY, FAKE_PROVIDER_SECRET, FAKE_ACCOUNT_SECRET]) {
    assert.ok(!JSON.stringify(body).includes(secret));
  }
  assert.equal((await request('/v1/models', FAKE_CLIENT_SECRET, { method: 'POST' })).status, 405);
  assert.equal((await request('/v1/models/extra', FAKE_CLIENT_SECRET)).status, 401);
});

test('gateway directory follows client-key rotation and revocation', async (context) => {
  const request = await startFixture(context);
  const replacementKey = 'fixture-replacement-client';
  assert.equal((await request('/v8/management/config/access/api-keys', FAKE_CPA_MANAGEMENT_KEY, {
    method: 'PUT', body: JSON.stringify([replacementKey]),
  })).status, 200);
  assert.equal((await request('/v1/models', FAKE_CLIENT_SECRET)).status, 401);
  assert.equal((await request('/v1/models', replacementKey)).status, 200);
  assert.equal((await request('/v8/management/config/access/api-keys', FAKE_CPA_MANAGEMENT_KEY, { method: 'DELETE' })).status, 200);
  assert.equal((await request('/v1/models', replacementKey)).status, 401);
});

test('gateway directory reads current configured model aliases and prefixes', async (context) => {
  const request = await startFixture(context);
  assert.equal((await request('/v8/management/config', FAKE_CPA_MANAGEMENT_KEY, {
    method: 'PATCH', body: JSON.stringify({ 'api-keys': { codex: [{ name: 'fixture-route', prefix: 'team', models: [{ name: 'gpt-e2e-second', alias: 'client-name' }], keys: [{ 'api-key': FAKE_PROVIDER_SECRET }] }] } }),
  })).status, 200);
  const body = await (await request('/v1/models', FAKE_CLIENT_SECRET)).json();
  const identities = body.data.map((model) => model.id);
  assert.ok(identities.includes('team/client-name'));
  assert.ok(!identities.includes('gpt-e2e-second'));
  assert.ok(identities.includes('gpt-e2e'));
});

test('gateway directory leaves out models a provider or credential excludes', async (context) => {
  const request = await startFixture(context);
  const route = (excluded) => request('/v8/management/config', FAKE_CPA_MANAGEMENT_KEY, {
    method: 'PATCH',
    body: JSON.stringify({ 'api-keys': { codex: [{ name: 'fixture-route', 'excluded-models': excluded, models: [{ name: 'Route-Kept' }, { name: 'route-hidden', alias: 'hidden-alias' }], keys: [{ 'api-key': FAKE_PROVIDER_SECRET }] }] } }),
  });
  const identities = async () => (await (await request('/v1/models', FAKE_CLIENT_SECRET)).json()).data.map((model) => model.id);

  assert.equal((await route(['ROUTE-hid*'])).status, 200);
  assert.ok((await identities()).includes('Route-Kept'));
  assert.ok(!(await identities()).includes('hidden-alias'));

  assert.equal((await route(['*'])).status, 200);
  assert.ok(!(await identities()).includes('Route-Kept'));
  assert.ok(!(await identities()).includes('hidden-alias'));

  assert.ok((await identities()).includes('sonnet-latest'));
  assert.equal((await request('/v8/management/credentials/fields', FAKE_CPA_MANAGEMENT_KEY, {
    method: 'PATCH', body: JSON.stringify({ name: 'claude-fixture.json', excluded_models: ['claude-*'] }),
  })).status, 200);
  assert.ok(!(await identities()).includes('sonnet-latest'));
});


test('OAuth exclusion snapshots follow provider updates and deletions', async (context) => {
  const request = await startFixture(context);
  const readJson = async (path) => {
    const response = await request(path, FAKE_CPA_MANAGEMENT_KEY);
    assert.equal(response.status, 200);
    return response.json();
  };
  const assertSnapshots = async (expected) => {
    assert.deepEqual(await readJson('/v8/management/config/oauth/excluded-models'), expected);
    const config = await readJson('/v8/management/config');
    assert.deepEqual(config.oauth['excluded-models'], expected);
    assert.equal(config.server.port, 8317);
    assert.equal(config.oauth['custom-setting'], 'preserved');
    for (const path of ['/v8/management/config.yaml', '/v0/management/config.yaml']) {
      const response = await request(path, FAKE_CPA_MANAGEMENT_KEY);
      assert.equal(response.status, 200);
      const snapshot = parseYaml(await response.text());
      assert.deepEqual(snapshot.oauth['excluded-models'], expected);
      assert.equal(snapshot.server.port, 8317);
      assert.equal(snapshot.oauth['custom-setting'], 'preserved');
    }
  };
  const patch = async (oauth) => {
    assert.equal((await request('/v8/management/config', FAKE_CPA_MANAGEMENT_KEY, {
      method: 'PATCH', body: JSON.stringify({ oauth }),
    })).status, 200);
  };
  assert.deepEqual((await readJson('/v8/management/config')).oauth['excluded-models'], { codex: ['GPT-E2E-Legacy', 'gpt-e2e-old-*'] });
  await patch({ 'custom-setting': 'preserved' });
  await assertSnapshots({ codex: ['GPT-E2E-Legacy', 'gpt-e2e-old-*'] });
  await patch({ 'excluded-models': { codex: ['GPT-*'], claude: ['claude-*'] } });
  await assertSnapshots({ codex: ['GPT-*'], claude: ['claude-*'] });
  await patch({ 'excluded-models': { codex: ['replacement'] } });
  await assertSnapshots({ codex: ['replacement'], claude: ['claude-*'] });
  for (const provider of ['codex', 'claude']) {
    assert.equal((await request(`/v8/management/config/oauth/excluded-models/${provider}`, FAKE_CPA_MANAGEMENT_KEY, { method: 'DELETE' })).status, 200);
    await assertSnapshots(provider === 'codex' ? { claude: ['claude-*'] } : {});
  }
});

test('gateway applies global OAuth exclusions before alias mapping without hiding API-key routes', async (context) => {
  const request = await startFixture(context);
  const patch = async (oauth) => {
    assert.equal((await request('/v8/management/config', FAKE_CPA_MANAGEMENT_KEY, {
      method: 'PATCH', body: JSON.stringify({ oauth }),
    })).status, 200);
  };
  const identities = async () => {
    const response = await request('/v1/models', FAKE_CLIENT_SECRET);
    assert.equal(response.status, 200);
    return (await response.json()).data.map((model) => model.id);
  };
  const readCatalog = async () => {
    const response = await request('/v8/management/routing/model-definitions/claude', FAKE_CPA_MANAGEMENT_KEY);
    assert.equal(response.status, 200);
    return response.json();
  };
  const catalog = await readCatalog();
  await patch({ 'model-alias': { claude: [{ name: 'claude-3-5-sonnet', alias: 'sonnet-latest', fork: true }] } });
  for (const rule of ['CLAUDE-3-5-SONNET', 'ClAuDe-*', '*']) {
    await patch({ 'excluded-models': { claude: [rule] } });
    const models = await identities();
    assert.ok(!models.includes('claude-3-5-sonnet'));
    assert.ok(!models.includes('sonnet-latest'));
    assert.ok(models.includes('gpt-e2e-preview'));
    assert.deepEqual(await readCatalog(), catalog);
  }
  await patch({ 'excluded-models': { claude: ['sonnet-latest'] } });
  assert.ok((await identities()).includes('claude-3-5-sonnet'));
  assert.ok((await identities()).includes('sonnet-latest'));
  await patch({ 'excluded-models': { claude: [], codex: ['GPT-E2E'] } });
  const sharedModels = await identities();
  assert.ok(sharedModels.includes('gpt-e2e'));
  assert.ok(!sharedModels.includes('gpt-e2e-preview'));
  assert.ok(sharedModels.includes('sonnet-latest'));
  await patch({ 'excluded-models': { codex: [] } });
  assert.ok((await identities()).includes('gpt-e2e-preview'));
  assert.equal((await request('/v8/management/credentials/fields', FAKE_CPA_MANAGEMENT_KEY, {
    method: 'PATCH', body: JSON.stringify({ name: 'claude-fixture.json', excluded_models: ['claude-*'] }),
  })).status, 200);
  assert.ok(!(await identities()).includes('claude-3-5-sonnet'));
  assert.ok(!(await identities()).includes('sonnet-latest'));
});
