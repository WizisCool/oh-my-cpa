/**
 * What a configuration save sends (web/src/components/config/configPatch.ts), and
 * the schema it is computed over.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from '../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/browser/index.js';

import { updateFieldWithBaseline } from '../web/src/components/config/configDirty.ts';
import { computeConfigChanges, rebaseDraft } from '../web/src/components/config/configPatch.ts';
import { writePayloadCategory } from '../web/src/components/config/payloadRules.ts';
import { ALL_CONFIG_FIELDS, type ConfigFieldDefinition } from '../web/src/types/configSchema.ts';

// The top-level sections CPA v8 accepts. A name outside them is refused by CPA as
// an unknown section or a legacy field, so an editor field placed there could
// never be saved.
const V8_SECTIONS = new Set([
  'server', 'management', 'access', 'credentials', 'routing', 'requests', 'oauth',
  'multimedia', 'observability', 'plugins', 'quota-exceeded', 'api-keys',
]);

function field(id: string): ConfigFieldDefinition {
  const found = ALL_CONFIG_FIELDS.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

const SERVER_YAML = `# gateway
server:
    port: 8317
observability:
    logs:
        debug: false
access:
    api-keys:
        - __OMC_SECRET_SENTINEL_1__
requests:
    payload:
        default:
            - models:
                - name: gpt-5
              params:
                temperature: 0.2
`;

test('every editor field lives in a CPA v8 section', () => {
  for (const item of ALL_CONFIG_FIELDS) {
    assert.ok(V8_SECTIONS.has(item.yamlPath[0]), `${item.id} is placed at ${item.yamlPath.join('.')}`);
    assert.ok(item.yamlPath.length >= 2, `${item.id} names a whole section`);
  }
});

test('an untouched draft sends nothing, and formatting alone is not a change', () => {
  const server = parseDocument(SERVER_YAML);
  assert.deepEqual(computeConfigChanges(server, parseDocument(SERVER_YAML)), []);
  const reformatted = parseDocument(`access: {api-keys: [__OMC_SECRET_SENTINEL_1__]}
server: {port: 8317}
observability: {logs: {debug: false}}
requests:
  payload:
    default:
      - params: {temperature: 0.2}
        models: [{name: gpt-5}]
`);
  assert.deepEqual(computeConfigChanges(server, reformatted), []);
});

test('an edited setting is sent at its own path and nothing else is', () => {
  const server = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  updateFieldWithBaseline(draft, server, field('debug'), true);
  updateFieldWithBaseline(draft, server, field('requestRetry'), 5);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['observability', 'logs', 'debug'], value: true },
    // The fixture has no routing section, so the whole new section is one value.
    { path: ['routing'], value: { retry: { 'request-retry': 5 } } },
  ]);
});

test('a cleared setting is removed so CPA falls back to its default', () => {
  const server = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  draft.deleteIn(['server', 'port']);
  assert.deepEqual(computeConfigChanges(server, draft), [{ path: ['server', 'port'], remove: true }]);
});

test('a list is replaced whole, sentinels included, for the server to restore', () => {
  const server = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  updateFieldWithBaseline(draft, server, field('apiKeys'), ['__OMC_SECRET_SENTINEL_1__', 'sk-new']);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['access', 'api-keys'], value: ['__OMC_SECRET_SENTINEL_1__', 'sk-new'] },
  ]);
});

test('payload rules are sent per category, and map key order is not a change', () => {
  const server = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  writePayloadCategory(draft, 'default', [{ params: { temperature: 0.2 }, models: [{ name: 'gpt-5' }] }]);
  assert.deepEqual(computeConfigChanges(server, draft), []);
  writePayloadCategory(draft, 'filter', [{ models: [{ name: 'gpt-5' }], params: ['metadata'] }]);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['requests', 'payload', 'filter'], value: [{ models: [{ name: 'gpt-5' }], params: ['metadata'] }] },
  ]);
});

test('a section the server did not have is sent as one value', () => {
  const server = parseDocument('server:\n    port: 8317\n');
  const draft = parseDocument('server:\n    port: 8317\n');
  updateFieldWithBaseline(draft, server, field('debug'), true);
  assert.deepEqual(computeConfigChanges(server, draft), [{ path: ['observability'], value: { logs: { debug: true } } }]);
});

// A save names its path as deeply as the server already nests a map: only the maps both sides
// hold are descended into, and a map the server never had travels whole.
test('an OAuth provider switch is sent at the deepest path the server already has', () => {
  const bare = parseDocument(SERVER_YAML);
  const bareDraft = parseDocument(SERVER_YAML);
  updateFieldWithBaseline(bareDraft, bare, field('codexLiveEnabled'), true);
  assert.deepEqual(computeConfigChanges(bare, bareDraft), [
    { path: ['oauth'], value: { providers: { codex: { 'live-media-relay': { enabled: true } } } } },
  ]);

  const providerYaml = `${SERVER_YAML}oauth:\n    providers:\n        codex:\n            header-defaults:\n                user-agent: codex\n`;
  const provider = parseDocument(providerYaml);
  const providerDraft = parseDocument(providerYaml);
  updateFieldWithBaseline(providerDraft, provider, field('codexLiveEnabled'), true);
  assert.deepEqual(computeConfigChanges(provider, providerDraft), [
    { path: ['oauth', 'providers', 'codex', 'live-media-relay'], value: { enabled: true } },
  ]);

  const relayYaml = `${SERVER_YAML}oauth:\n    providers:\n        codex:\n            live-media-relay:\n                max-sessions: 32\n`;
  const relay = parseDocument(relayYaml);
  const relayDraft = parseDocument(relayYaml);
  updateFieldWithBaseline(relayDraft, relay, field('codexLiveEnabled'), true);
  assert.deepEqual(computeConfigChanges(relay, relayDraft), [
    { path: ['oauth', 'providers', 'codex', 'live-media-relay', 'enabled'], value: true },
  ]);
});

test('a trusted-proxy list is replaced whole', () => {
  const serverYaml = 'server:\n    trusted-proxies:\n        - 127.0.0.1\n';
  const server = parseDocument(serverYaml);
  const draft = parseDocument(serverYaml);
  updateFieldWithBaseline(draft, server, field('trustedProxies'), ['127.0.0.1', '10.0.0.0/8']);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['server', 'trusted-proxies'], value: ['127.0.0.1', '10.0.0.0/8'] },
  ]);
});

test('a draft is carried over onto a newer baseline without undoing what it did not see', () => {
  const base = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  updateFieldWithBaseline(draft, base, field('debug'), true);
  // Another session changed the port, and CPA added a default when it converted the file.
  const newer = SERVER_YAML.replace('port: 8317', 'port: 9000') + 'server-extra: true\n';
  const rebased = parseDocument(rebaseDraft(base, draft, newer) ?? '');
  assert.equal(rebased.getIn(['server', 'port']), 9000);
  assert.equal(rebased.get('server-extra'), true);
  assert.equal(rebased.getIn(['observability', 'logs', 'debug']), true);
  // Against its new baseline, the carried-over draft sends only its own edit.
  assert.deepEqual(computeConfigChanges(parseDocument(newer), rebased), [
    { path: ['observability', 'logs', 'debug'], value: true },
  ]);
});

test('a draft without edits takes the newer baseline as it is', () => {
  const newer = SERVER_YAML.replace('port: 8317', 'port: 9000');
  assert.equal(rebaseDraft(parseDocument(SERVER_YAML), parseDocument(SERVER_YAML), newer), newer);
});

test('an edit that no longer fits the newer document is reported, not dropped', () => {
  const base = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  updateFieldWithBaseline(draft, base, field('debug'), true);
  assert.equal(rebaseDraft(base, draft, 'observability: disabled\n'), null);
});
