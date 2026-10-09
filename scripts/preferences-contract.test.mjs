import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreferenceFixture, PREFERENCE_CONTRACT } from './acceptance/preferences-fixture.mjs';
import { installRoutes } from './acceptance/probe.mjs';

function validateCorpus() {
  assert.equal(PREFERENCE_CONTRACT.version, 1);
  assert.ok(PREFERENCE_CONTRACT.cases.length > 0);
  assert.equal(new Set(PREFERENCE_CONTRACT.cases.map(entry => entry.id)).size, PREFERENCE_CONTRACT.cases.length);
  assert.equal(new Set(PREFERENCE_CONTRACT.known_keys).size, PREFERENCE_CONTRACT.known_keys.length);
}

test('shared preference fixture agrees with every handler-certified wire case', () => {
  validateCorpus();
  const authenticated = createPreferenceFixture();
  const unauthenticated = createPreferenceFixture({ authenticated: false });
  for (const entry of PREFERENCE_CONTRACT.cases) {
    const handler = entry.authenticated ? authenticated : unauthenticated;
    const response = handler(new URL(entry.path, 'http://127.0.0.1'), entry.method, entry.body);
    assert.equal(response.status, entry.status, entry.id);
    assert.deepEqual(response.json, entry.response, entry.id);
    if (entry.authenticated) assert.equal(response.headers['Cache-Control'], 'no-store', entry.id);
  }
});

test('real default route dispatcher uses the certified preference fixture and retains method faults', async () => {
  let dispatch;
  const context = { route: async (_pattern, handler) => { dispatch = handler; } };
  const problems = [];
  await installRoutes(context, [], { record: problem => problems.push(problem) });
  for (const entry of PREFERENCE_CONTRACT.cases.filter(entry => entry.authenticated)) {
    let response;
    await dispatch({
      request: () => ({ url: () => `http://127.0.0.1${entry.path}`, method: () => entry.method, postData: () => entry.body, frame: () => ({ page: () => ({ context: () => context }) }) }),
      fulfill: value => { response = value; },
    });
    assert.equal(response.status, entry.status, entry.id);
    assert.deepEqual(response.json, entry.response, entry.id);
    assert.equal(response.headers['Cache-Control'], 'no-store', entry.id);
  }
  let response;
  await dispatch({ request: () => ({ url: () => 'http://127.0.0.1/omc/api/v1/preferences', method: () => 'POST' }), fulfill: value => { response = value; } });
  assert.equal(response.status, 501, 'an unsupported fixture method remains a harness fault, not a success');
  assert.equal(problems.length, 1);
});

test('stores are per-context and returned documents cannot mutate later reads', () => {
  const first = createPreferenceFixture();
  const second = createPreferenceFixture();
  const write = new URL('http://127.0.0.1/omc/api/v1/preferences/agent_target');
  const read = new URL('http://127.0.0.1/omc/api/v1/preferences');
  const response = first(write, 'PUT', '{"model":"fixture-model"}');
  response.json.value.model = 'mutated';
  const listed = first(read, 'GET');
  assert.deepEqual(listed.json.preferences, { agent_target: { model: 'fixture-model' } });
  listed.json.preferences.agent_target.model = 'mutated';
  assert.deepEqual(first(read, 'GET').json.preferences, { agent_target: { model: 'fixture-model' } });
  assert.deepEqual(second(read, 'GET').json.preferences, {});
});

test('non-UTC deployment metadata is certified independently of the UTC fallback', () => {
  const alternate = PREFERENCE_CONTRACT.alternate_server;
  const fixture = createPreferenceFixture({ serverTimezone: alternate.timezone });
  assert.deepEqual(fixture(new URL('http://127.0.0.1/omc/api/v1/preferences'), 'GET', null).json, alternate.response);
});
