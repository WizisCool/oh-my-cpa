/**
 * What a configuration save sends (web/src/components/config/configPatch.ts), and
 * the schema it is computed over.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseDocument } from 'yaml';

import { getFieldSemanticValue, updateFieldWithBaseline } from '../../src/components/config/configDirty.ts';
import { computeConfigChanges, rebaseDraft } from '../../src/components/config/configPatch.ts';
import { rebaseStringMapDraft, stringMapRowsToWire } from '../../src/components/config/StringMapEditor.tsx';
import { writePayloadCategory } from '../../src/components/config/payloadRules.ts';
import { ALL_CONFIG_FIELDS, CONFIG_GROUPS, type ConfigFieldDefinition } from '../../src/types/configSchema.ts';

// The top-level sections CPA v8 accepts. A name outside them is refused by CPA as
// an unknown section or a legacy field, so an editor field placed there could
// never be saved.
const V8_SECTIONS = new Set([
  'server', 'management', 'access', 'credentials', 'routing', 'requests', 'oauth',
  'multimedia', 'observability', 'plugins', 'quota-exceeded', 'api-keys', 'client', 'upstream',
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
    for (const yamlPath of [item.yamlPath, ...(item.legacyYamlPath ? [item.legacyYamlPath] : [])]) {
      assert.ok(V8_SECTIONS.has(yamlPath[0]), `${item.id} is placed at ${yamlPath.join('.')}`);
      assert.ok(yamlPath.length >= 2, `${item.id} names a whole section`);
    }
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

for (const setting of [
  {
    id: 'trustedProxies',
    groupId: 'grp_service',
    path: ['server', 'trusted-proxies'],
    yaml: 'server:\n    trusted-proxies: [127.0.0.1]\n',
    initial: ['127.0.0.1'],
    edited: ['127.0.0.1', '10.0.0.0/8'],
  },
  {
    id: 'claudeHeaderNativeEntrypoints',
    groupId: 'grp_claude_headers',
    path: ['upstream', 'claude', 'header-defaults', 'native-entrypoints'],
    yaml: `${SERVER_YAML}upstream:
    claude:
        tool-search: false
        header-defaults:
            user-agent: claude-cli/2.1.0
            stabilize-device-profile: true
            native-entrypoints: [custom-ide]
            anthropic-beta-strip: [cache-diagnosis-2026-04-07]
            anthropic-beta-append: [context-1m-2025-08-07]
            inject-diagnostics: false
            client-request-id: passthrough
            operator-extra: retained # unmodeled sibling
`,
    initial: ['custom-ide'],
    // CPA owns case folding and deduplication; the editor must transport free-form labels.
    edited: ['custom-ide', 'T3-Code', 't3-code'],
  },
]) {
  test(`${setting.id} reads, replaces and clears a list without changing sibling settings`, () => {
    const listField = field(setting.id);
    assert.equal(listField.type, 'string_list');
    assert.ok(CONFIG_GROUPS.find((group) => group.id === setting.groupId)?.fieldIds.includes(listField.id));
    const server = parseDocument(setting.yaml);
    const draft = server.clone();
    assert.deepEqual(getFieldSemanticValue(server, listField), setting.initial);
    assert.deepEqual(computeConfigChanges(server, draft), []);

    updateFieldWithBaseline(draft, server, listField, setting.edited);
    assert.deepEqual(computeConfigChanges(server, draft), [{ path: setting.path, value: setting.edited }]);
    const readback = parseDocument(draft.toString());
    assert.deepEqual(getFieldSemanticValue(readback, listField), setting.edited);
    const expected = server.clone();
    expected.setIn(setting.path, setting.edited);
    assert.deepEqual(readback.toJS(), expected.toJS());

    const cleared = readback.clone();
    updateFieldWithBaseline(cleared, readback, listField, []);
    assert.deepEqual(computeConfigChanges(readback, cleared), [{ path: setting.path, remove: true }]);
    expected.deleteIn(setting.path);
    assert.deepEqual(parseDocument(cleared.toString()).toJS(), expected.toJS());

    const absent = parseDocument(cleared.toString());
    const empty = absent.clone();
    updateFieldWithBaseline(empty, absent, listField, []);
    assert.deepEqual(computeConfigChanges(absent, empty), [], 'an absent list stays unconfigured');
    updateFieldWithBaseline(empty, absent, listField, setting.edited);
    assert.deepEqual(computeConfigChanges(absent, empty), [{ path: setting.path, value: setting.edited }]);

    updateFieldWithBaseline(draft, server, listField, setting.initial);
    assert.equal(draft.toString(), server.toString(), 'reverting restores the original nodes and comments');
  });
}

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

test('a new nested map merges into a newer baseline without dropping siblings', () => {
  const base = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  updateFieldWithBaseline(draft, base, field('kvStorePath'), '/data/cpa/kv.db');
  const newer = SERVER_YAML.replace(
    'port: 8317',
    'port: 8317\n    kv-store:\n        disabled: true\n        operator-extra: retained',
  );

  const rebased = parseDocument(rebaseDraft(base, draft, newer) ?? '');
  assert.equal(rebased.getIn(['server', 'port']), 8317, 'the newer server map is retained');
  assert.equal(rebased.getIn(['server', 'kv-store', 'disabled']), true, 'a newer sibling is retained');
  assert.equal(rebased.getIn(['server', 'kv-store', 'operator-extra']), 'retained');
  assert.equal(rebased.getIn(['server', 'kv-store', 'path']), '/data/cpa/kv.db');
  assert.deepEqual(computeConfigChanges(parseDocument(newer), rebased), [
    { path: ['server', 'kv-store', 'path'], value: '/data/cpa/kv.db' },
  ]);

  // The same merge applies when the whole parent map is new.
  const nestedBase = parseDocument(SERVER_YAML.replace('server:\n    port: 8317\n', ''));
  const nestedDraft = parseDocument(nestedBase.toString());
  updateFieldWithBaseline(nestedDraft, nestedBase, field('kvStorePath'), '/nested/kv.db');
  const nested = parseDocument(rebaseDraft(nestedBase, nestedDraft, newer) ?? '');
  assert.equal(nested.getIn(['server', 'port']), 8317);
  assert.equal(nested.getIn(['server', 'kv-store', 'disabled']), true);
  assert.equal(nested.getIn(['server', 'kv-store', 'operator-extra']), 'retained');
  assert.equal(nested.getIn(['server', 'kv-store', 'path']), '/nested/kv.db');
  assert.deepEqual(computeConfigChanges(parseDocument(newer), nested), [
    { path: ['server', 'kv-store', 'path'], value: '/nested/kv.db' },
  ]);
});

test('rebase keeps newer siblings beside an existing map edit, its removal and a type replacement', () => {
  const configured = SERVER_YAML.replace(
    'port: 8317',
    'port: 8317\n    kv-store:\n        disabled: true\n        path: /old/kv.db',
  );
  const base = parseDocument(configured);
  const draft = parseDocument(configured);
  updateFieldWithBaseline(draft, base, field('kvStorePath'), '/new/kv.db');
  const newer = configured.replace('/old/kv.db', '/concurrent/kv.db').replace(
    'disabled: true',
    'disabled: true\n        operator-extra: retained',
  );

  const rebased = parseDocument(rebaseDraft(base, draft, newer) ?? '');
  assert.equal(rebased.getIn(['server', 'kv-store', 'path']), '/new/kv.db');
  assert.equal(rebased.getIn(['server', 'kv-store', 'disabled']), true);
  assert.equal(rebased.getIn(['server', 'kv-store', 'operator-extra']), 'retained');
  assert.deepEqual(computeConfigChanges(parseDocument(newer), rebased), [
    { path: ['server', 'kv-store', 'path'], value: '/new/kv.db' },
  ]);

  const removeBase = parseDocument(newer);
  const removeDraft = parseDocument(newer);
  updateFieldWithBaseline(removeDraft, removeBase, field('kvStorePath'), '');
  const removed = parseDocument(rebaseDraft(removeBase, removeDraft, newer) ?? '');
  assert.equal(removed.hasIn(['server', 'kv-store', 'path']), false);
  assert.equal(removed.getIn(['server', 'kv-store', 'disabled']), true);
  assert.equal(removed.getIn(['server', 'kv-store', 'operator-extra']), 'retained');
  assert.deepEqual(computeConfigChanges(parseDocument(newer), removed), [
    { path: ['server', 'kv-store', 'path'], remove: true },
  ]);

  const replaced = parseDocument(rebaseDraft(
    parseDocument('server:\n    kv-store:\n        path: /old/kv.db\n'),
    parseDocument('server:\n    kv-store: false\n'),
    'server:\n    kv-store:\n        disabled: true\n        operator-extra: retained\n',
  ) ?? '');
  assert.equal(replaced.getIn(['server', 'kv-store']), false, 'a value that is not a map still replaces whole');
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

const CODEX_BEHAVIOR_FIELDS = [
  { id: 'codexOptimizeMultiAgentV2', path: ['client', 'codex', 'optimize-multi-agent-v2'], key: 'optimize-multi-agent-v2' },
  { id: 'codexOrphanDelegationCompatibility', path: ['upstream', 'codex', 'orphan-delegation-compatibility'], key: 'orphan-delegation-compatibility' },
];

for (const setting of CODEX_BEHAVIOR_FIELDS) {
  const canonicalYaml = `${setting.path[0]}:\n  codex:\n    ${setting.key}: true # enabled\n`;
  const historicalYaml = `oauth:\n  providers:\n    codex:\n      ${setting.key}: true # enabled\n`;
  const historicalPath = ['oauth', 'providers', 'codex', setting.key];

  test(`${setting.id} reads and edits CPA's canonical path without creating an alias`, () => {
    const baseline = parseDocument(canonicalYaml);
    const draft = parseDocument(canonicalYaml);
    assert.equal(getFieldSemanticValue(baseline, field(setting.id)), true);
    updateFieldWithBaseline(draft, baseline, field(setting.id), false);
    assert.equal(getFieldSemanticValue(draft, field(setting.id)), false);
    assert.deepEqual(computeConfigChanges(baseline, draft), [{ path: setting.path, value: false }]);
    assert.equal(draft.hasIn(historicalPath), false);
    const reloaded = parseDocument(draft.toString());
    assert.equal(getFieldSemanticValue(reloaded, field(setting.id)), false);
    updateFieldWithBaseline(draft, baseline, field(setting.id), true);
    assert.equal(draft.toString(), baseline.toString(), 'returning to baseline preserves its comments and style');
  });

  test(`${setting.id} keeps early CPA v8 read and write compatibility`, () => {
    const baseline = parseDocument(historicalYaml);
    const draft = parseDocument(historicalYaml);
    assert.equal(getFieldSemanticValue(baseline, field(setting.id)), true);
    updateFieldWithBaseline(draft, baseline, field(setting.id), false);
    assert.deepEqual(computeConfigChanges(baseline, draft), [{ path: historicalPath, value: false }]);
    assert.equal(draft.hasIn(setting.path), false);
    updateFieldWithBaseline(draft, baseline, field(setting.id), true);
    assert.equal(draft.toString(), baseline.toString());
  });

  test(`${setting.id} gives canonical false and null precedence over historical true`, () => {
    for (const value of ['false', 'null']) {
      const yaml = canonicalYaml.replace('true # enabled', value) + historicalYaml;
      const baseline = parseDocument(yaml);
      const draft = parseDocument(yaml);
      assert.equal(getFieldSemanticValue(baseline, field(setting.id)), false);
      updateFieldWithBaseline(draft, baseline, field(setting.id), true);
      assert.deepEqual(computeConfigChanges(baseline, draft), [{ path: setting.path, value: true }]);
      assert.equal(draft.getIn(historicalPath), true);
      updateFieldWithBaseline(draft, baseline, field(setting.id), false);
      assert.equal(draft.toString(), baseline.toString());
    }
  });

  test(`${setting.id} uses the historical alias when omitted and prunes a reverted edit`, () => {
    const baseline = parseDocument('server: {port: 8317}\n');
    const draft = parseDocument(baseline.toString());
    assert.equal(getFieldSemanticValue(baseline, field(setting.id)), false);
    updateFieldWithBaseline(draft, baseline, field(setting.id), true);
    assert.equal(draft.getIn(historicalPath), true);
    assert.equal(draft.hasIn(setting.path), false);
    updateFieldWithBaseline(draft, baseline, field(setting.id), false);
    assert.equal(draft.toString(), baseline.toString());
  });

  test(`${setting.id} edits a path relocated in source without undoing its relocation`, () => {
    for (const [baselineYaml, sourceYaml] of [
      [historicalYaml, canonicalYaml],
      [canonicalYaml, historicalYaml],
      [historicalYaml, canonicalYaml + historicalYaml],
      ['server: {port: 8317}\n', canonicalYaml.replace('true # enabled', 'false # disabled')],
    ]) {
      const baseline = parseDocument(baselineYaml);
      const source = parseDocument(sourceYaml);
      const draft = source.clone();
      const originalValue = getFieldSemanticValue(source, field(setting.id));
      updateFieldWithBaseline(draft, baseline, field(setting.id), !originalValue);
      assert.equal(getFieldSemanticValue(draft, field(setting.id)), !originalValue);
      const sourcePath = source.hasIn(setting.path) ? setting.path : historicalPath;
      assert.equal(draft.getIn(sourcePath), !originalValue);
      assert.equal(draft.hasIn(setting.path), source.hasIn(setting.path));
      assert.equal(draft.hasIn(historicalPath), source.hasIn(historicalPath));
      updateFieldWithBaseline(draft, baseline, field(setting.id), originalValue);
      assert.equal(getFieldSemanticValue(draft, field(setting.id)), originalValue);
      assert.equal(draft.toString(), source.toString(), 'visual revert preserves the independent source relocation');
    }
  });

  test(`${setting.id} carries a later edit onto CPA's canonical readback`, () => {
    const sentDraft = parseDocument(historicalYaml);
    const laterDraft = parseDocument(historicalYaml);
    updateFieldWithBaseline(laterDraft, sentDraft, field(setting.id), false);
    const nextYaml = canonicalYaml + 'server: {port: 9000}\n';
    const rebased = parseDocument(rebaseDraft(sentDraft, laterDraft, nextYaml) ?? '');
    assert.equal(getFieldSemanticValue(rebased, field(setting.id)), false);
    assert.equal(rebased.hasIn(historicalPath), false);
    assert.equal(rebased.getIn(['server', 'port']), 9000);
    assert.deepEqual(computeConfigChanges(parseDocument(nextYaml), rebased), [{ path: setting.path, value: false }]);
  });

  test(`${setting.id} carries an edit from an omitted setting onto a canonical readback`, () => {
    const baseline = parseDocument('server: {port: 8317}\n');
    const draft = parseDocument(baseline.toString());
    updateFieldWithBaseline(draft, baseline, field(setting.id), true);
    const nextYaml = canonicalYaml.replace('true # enabled', 'false') + 'server: {port: 9000}\n';
    const rebased = parseDocument(rebaseDraft(baseline, draft, nextYaml) ?? '');
    assert.equal(getFieldSemanticValue(rebased, field(setting.id)), true);
    assert.equal(rebased.hasIn(historicalPath), false);
    assert.deepEqual(computeConfigChanges(parseDocument(nextYaml), rebased), [{ path: setting.path, value: true }]);
  });
}

test('KV store defaults remain omitted through unrelated saves and reverted edits', () => {
  const disabled = field('kvStoreDisabled');
  const path = field('kvStorePath');
  const server = parseDocument(SERVER_YAML);
  const draft = server.clone();
  assert.equal(disabled.type, 'switch');
  assert.equal(path.type, 'string');
  for (const setting of [disabled, path]) {
    assert.ok(CONFIG_GROUPS.find((group) => group.id === 'grp_service')?.fieldIds.includes(setting.id));
  }
  assert.equal(getFieldSemanticValue(server, disabled), false);
  assert.equal(getFieldSemanticValue(server, path), '');

  updateFieldWithBaseline(draft, server, disabled, false);
  updateFieldWithBaseline(draft, server, path, '');
  assert.equal(draft.toString(), server.toString());
  assert.deepEqual(computeConfigChanges(server, draft), []);

  updateFieldWithBaseline(draft, server, field('debug'), true);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['observability', 'logs', 'debug'], value: true },
  ]);
  assert.equal(draft.hasIn(['server', 'kv-store']), false);
  updateFieldWithBaseline(draft, server, field('debug'), false);

  updateFieldWithBaseline(draft, server, disabled, true);
  updateFieldWithBaseline(draft, server, path, '/data/cpa/kv.db');
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['server', 'kv-store'], value: { disabled: true, path: '/data/cpa/kv.db' } },
  ]);
  updateFieldWithBaseline(draft, server, disabled, false);
  updateFieldWithBaseline(draft, server, path, '');
  assert.deepEqual(computeConfigChanges(server, draft), []);
  assert.equal(draft.toString(), server.toString());
});

for (const setting of [
  { disabled: false, path: '', pinDays: 0, editedPath: '/data/cpa/kv.db' },
  { disabled: true, path: '/data/cpa/kv.db', pinDays: 21, editedPath: '' },
]) {
  test(`KV store edits preserve siblings and retention with disabled=${setting.disabled} and path=${JSON.stringify(setting.path)}`, () => {
    const disabled = field('kvStoreDisabled');
    const path = field('kvStorePath');
    const server = parseDocument(`${SERVER_YAML}upstream:
    claude:
        session-date-pin-days: ${setting.pinDays} # retained policy
`);
    server.setIn(['server', 'kv-store'], server.createNode({
      disabled: setting.disabled,
      path: setting.path,
      'operator-extra': 'retained',
    }));
    assert.equal(getFieldSemanticValue(server, disabled), setting.disabled);
    assert.equal(getFieldSemanticValue(server, path), setting.path);

    const unrelated = server.clone();
    updateFieldWithBaseline(unrelated, server, field('debug'), true);
    assert.deepEqual(computeConfigChanges(server, unrelated), [
      { path: ['observability', 'logs', 'debug'], value: true },
    ]);

    const draft = server.clone();
    updateFieldWithBaseline(draft, server, disabled, !setting.disabled);
    updateFieldWithBaseline(draft, server, path, setting.editedPath);
    assert.deepEqual(computeConfigChanges(server, draft), [
      { path: ['server', 'kv-store', 'disabled'], value: !setting.disabled },
      setting.editedPath === ''
        ? { path: ['server', 'kv-store', 'path'], remove: true }
        : { path: ['server', 'kv-store', 'path'], value: setting.editedPath },
    ]);
    const expected = server.clone();
    expected.setIn(['server', 'kv-store', 'disabled'], !setting.disabled);
    if (setting.editedPath === '') expected.deleteIn(['server', 'kv-store', 'path']);
    else expected.setIn(['server', 'kv-store', 'path'], setting.editedPath);

    const readback = parseDocument(draft.toString());
    assert.deepEqual(readback.toJS(), expected.toJS());
    assert.equal(getFieldSemanticValue(readback, disabled), !setting.disabled);
    assert.equal(getFieldSemanticValue(readback, path), setting.editedPath);
    assert.equal(getFieldSemanticValue(readback, field('claudeSessionDatePinDays')), setting.pinDays);
    assert.equal(readback.toString().includes('# retained policy'), true);

    updateFieldWithBaseline(draft, server, disabled, setting.disabled);
    updateFieldWithBaseline(draft, server, path, setting.path);
    assert.deepEqual(computeConfigChanges(server, draft), []);
    assert.deepEqual(draft.toJS(), server.toJS());
  });
}

// In memory mode, CPA holds the Claude session date pin as a pointer (`*int`): an
// absent key is its 7-day default, while an explicit 0 is a different setting — the legacy
// continuity-scoped pin. The schema default therefore has to reproduce the absent
// key, not stand in for a value, so an untouched gateway is never written, and a
// zero the operator typed has to survive the save and the readback instead of
// reading as "unset".
const CLAUDE_SESSION_YAML = `${SERVER_YAML}upstream:
    claude:
        tool-search: false # unrelated
`;

test('an untouched Claude session date pin sends nothing, and an explicit zero is a saved value', () => {
  const pinDays = field('claudeSessionDatePinDays');
  const server = parseDocument(CLAUDE_SESSION_YAML);
  assert.equal(getFieldSemanticValue(server, pinDays), 7, 'an absent key reads as the default of 7 days');

  const untouched = parseDocument(CLAUDE_SESSION_YAML);
  updateFieldWithBaseline(untouched, server, pinDays, 7);
  assert.equal(untouched.toString(), server.toString(), 'the default reproduces the absent key');
  assert.deepEqual(computeConfigChanges(server, untouched), []);

  const draft = parseDocument(CLAUDE_SESSION_YAML);
  updateFieldWithBaseline(draft, server, pinDays, 0);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['upstream', 'claude', 'session-date-pin-days'], value: 0 },
  ]);
  assert.equal(draft.getIn(['upstream', 'claude', 'tool-search']), false, 'the sibling setting is untouched');
  assert.equal(draft.toString().includes('# unrelated'), true, 'the rest of the file keeps its text');

  const readback = parseDocument(draft.toString());
  assert.equal(getFieldSemanticValue(readback, pinDays), 0, 'the explicit zero is not read back as the default');
  const reopened = parseDocument(draft.toString());
  updateFieldWithBaseline(reopened, readback, pinDays, 0);
  assert.deepEqual(computeConfigChanges(readback, reopened), [], 'reopening on the zero leaves the field clean');
});

test('the Claude session date pin reads and edits only the canonical path', () => {
  const pinDays = field('claudeSessionDatePinDays');
  const server = parseDocument(CLAUDE_SESSION_YAML);
  const draft = parseDocument(CLAUDE_SESSION_YAML);
  updateFieldWithBaseline(draft, server, pinDays, 4);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['upstream', 'claude', 'session-date-pin-days'], value: 4 },
  ]);
  assert.equal(draft.hasIn(['oauth']), false, 'the pre-relocation spelling is never written');
});

test('a gateway with no Claude settings at all gets the canonical upstream path, not the relocated alias', () => {
  const server = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  updateFieldWithBaseline(draft, server, field('claudeSessionDatePinDays'), 0);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['upstream'], value: { claude: { 'session-date-pin-days': 0 } } },
  ]);
  assert.equal(draft.hasIn(['oauth']), false, 'the pre-relocation spelling is never written');
});

test('clearing the Claude session date pin restores the omitted key instead of storing a zero', () => {
  const pinDays = field('claudeSessionDatePinDays');
  const server = parseDocument(CLAUDE_SESSION_YAML);
  const draft = parseDocument(CLAUDE_SESSION_YAML);
  updateFieldWithBaseline(draft, server, pinDays, null);
  assert.equal(draft.toString(), server.toString(), 'a cleared box leaves the key absent');
  assert.deepEqual(computeConfigChanges(server, draft), []);

  // An explicit 0 is a setting, so clearing it removes the override the only way a number
  // can state its default: CPA drops a written 7 as its known default on the way to disk.
  const configuredYaml = CLAUDE_SESSION_YAML.replace(
    'tool-search: false # unrelated',
    "tool-search: false\n        session-date-pin-days: 0",
  );
  const configured = parseDocument(configuredYaml);
  const cleared = parseDocument(configuredYaml);
  updateFieldWithBaseline(cleared, configured, pinDays, null);
  assert.deepEqual(computeConfigChanges(configured, cleared), [
    { path: ['upstream', 'claude', 'session-date-pin-days'], value: 7 },
  ]);
});

const WEB_SEARCH_CACHE_YAML = `client:
    codex:
        optimize-multi-agent-v2: true
        web-search-result-cache:
            enabled: true # opted in
            ttl: 1800
`;

test('the web search result cache edits one leaf at a time beside its siblings', () => {
  const server = parseDocument(WEB_SEARCH_CACHE_YAML);
  assert.equal(getFieldSemanticValue(server, field('codexWebSearchCacheEnabled')), true);
  assert.equal(getFieldSemanticValue(server, field('codexWebSearchCacheTtl')), 1800);
  assert.equal(getFieldSemanticValue(server, field('codexWebSearchCacheLimit')), 1024, 'an omitted limit reads as the default');

  const draft = parseDocument(WEB_SEARCH_CACHE_YAML);
  updateFieldWithBaseline(draft, server, field('codexWebSearchCacheLimit'), 1024);
  assert.deepEqual(computeConfigChanges(server, draft), [], 'confirming the default limit writes nothing');

  updateFieldWithBaseline(draft, server, field('codexWebSearchCacheEnabled'), false);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['client', 'codex', 'web-search-result-cache', 'enabled'], value: false },
  ], 'an explicit false is written at its own path and leaves the TTL in place');

  updateFieldWithBaseline(draft, server, field('codexWebSearchCacheEnabled'), true);
  updateFieldWithBaseline(draft, server, field('codexWebSearchCacheTtl'), '');
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['client', 'codex', 'web-search-result-cache', 'ttl'], remove: true },
  ], 'a cleared TTL drops the key so CPA reads its 24h default');
});

test('the web search result cache writes the TTL as text and the limit as an integer', () => {
  // CPA's decoder refuses a non-integer limit and accepts the TTL as a string or
  // whole seconds, so typed seconds must reach the YAML as text, not as a float.
  const server = parseDocument('client:\n    codex:\n        optimize-multi-agent-v2: true\n');
  const draft = parseDocument('client:\n    codex:\n        optimize-multi-agent-v2: true\n');
  updateFieldWithBaseline(draft, server, field('codexWebSearchCacheTtl'), '1800');
  updateFieldWithBaseline(draft, server, field('codexWebSearchCacheLimit'), 0);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['client', 'codex', 'web-search-result-cache'], value: { ttl: '1800', limit: 0 } },
  ]);
  const reloaded = parseDocument(draft.toString());
  assert.equal(reloaded.getIn(['client', 'codex', 'web-search-result-cache', 'ttl']), '1800');
  assert.equal(getFieldSemanticValue(reloaded, field('codexWebSearchCacheLimit')), 0, 'an explicit zero survives readback rather than reading as the default');
  assert.equal(reloaded.getIn(['client', 'codex', 'optimize-multi-agent-v2']), true);
});

test('compression settings keep omitted defaults and send only canonical overrides', () => {
  const yaml = `${SERVER_YAML}upstream:\n    codex:\n        response-steering: true\n`;
  const baseline = parseDocument(yaml);
  const draft = parseDocument(yaml);
  const settings = [
    ['responseCompressionEnabled', true, false],
    ['responseCompressionMinBytes', 1024, 0],
    ['codexUpstreamRequestCompression', false, true],
    ['codexUpstreamRequestCompressionMinBytes', 1024, 0],
    ['codexWebsocketCompression', true, false],
  ] as const;

  assert.deepEqual(settings.map(([id]) => getFieldSemanticValue(baseline, field(id))), [true, 1024, false, 1024, true]);
  for (const [id, defaultValue] of settings) updateFieldWithBaseline(draft, baseline, field(id), defaultValue);
  assert.deepEqual(computeConfigChanges(baseline, draft), []);

  for (const [id, , value] of settings) updateFieldWithBaseline(draft, baseline, field(id), value);
  assert.deepEqual(computeConfigChanges(baseline, draft), [
    { path: ['server', 'response-compression'], value: { enabled: false, 'min-bytes': 0 } },
    { path: ['upstream', 'codex', 'upstream-request-compression'], value: true },
    { path: ['upstream', 'codex', 'upstream-request-compression-min-bytes'], value: 0 },
    { path: ['upstream', 'codex', 'websocket-compression'], value: false },
  ]);

  const readback = parseDocument(draft.toString());
  assert.deepEqual(settings.map(([id]) => getFieldSemanticValue(readback, field(id))), [false, 0, true, 0, false]);
  for (const [id, defaultValue] of settings) updateFieldWithBaseline(draft, baseline, field(id), defaultValue);
  assert.deepEqual(draft.toJS(), baseline.toJS());
});

const CLAUDE_CLIENT_YAML = `client:
    codex:
        optimize-multi-agent-v2: true
`;

test('the Claude Codex commentary setting edits client.claude beside existing client settings', () => {
  const commentaryField = field('claudeShowCodexCommentary');
  const server = parseDocument(CLAUDE_CLIENT_YAML);
  assert.equal(getFieldSemanticValue(server, commentaryField), false, 'an absent setting defaults to false');

  const draft = parseDocument(CLAUDE_CLIENT_YAML);
  updateFieldWithBaseline(draft, server, commentaryField, false);
  assert.deepEqual(computeConfigChanges(server, draft), [], 'confirming the omitted false writes nothing');
  assert.equal(draft.toString(), server.toString());

  updateFieldWithBaseline(draft, server, commentaryField, true);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['client', 'claude'], value: { 'show-codex-commentary': true } },
  ]);
  assert.equal(draft.getIn(['client', 'codex', 'optimize-multi-agent-v2']), true, 'unrelated codex settings are preserved');

  const reloaded = parseDocument(draft.toString());
  assert.equal(getFieldSemanticValue(reloaded, commentaryField), true);
  assert.equal(reloaded.getIn(['client', 'claude', 'show-codex-commentary']), true);

  // Returning to baseline leaves document clean
  updateFieldWithBaseline(draft, server, commentaryField, false);
  assert.deepEqual(computeConfigChanges(server, draft), []);
  assert.equal(draft.toString(), server.toString());

  // When client.claude already exists on the server, editing changes the leaf key
  const serverWithClaude = parseDocument('client:\n    codex:\n        optimize-multi-agent-v2: true\n    claude:\n        show-codex-commentary: false\n');
  const draftWithClaude = parseDocument(serverWithClaude.toString());
  updateFieldWithBaseline(draftWithClaude, serverWithClaude, commentaryField, true);
  assert.deepEqual(computeConfigChanges(serverWithClaude, draftWithClaude), [
    { path: ['client', 'claude', 'show-codex-commentary'], value: true },
  ]);
});

test('explicitly configured false for Claude Codex commentary is preserved against true', () => {
  const commentaryField = field('claudeShowCodexCommentary');
  const configuredYaml = `client:
    claude:
        show-codex-commentary: true
`;
  const server = parseDocument(configuredYaml);
  assert.equal(getFieldSemanticValue(server, commentaryField), true);

  const draft = parseDocument(configuredYaml);
  updateFieldWithBaseline(draft, server, commentaryField, false);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['client', 'claude', 'show-codex-commentary'], value: false },
  ]);
  const reloaded = parseDocument(draft.toString());
  assert.equal(getFieldSemanticValue(reloaded, commentaryField), false);
  assert.equal(reloaded.getIn(['client', 'claude', 'show-codex-commentary']), false);
});

test('Claude server-side fallback sits beside tool-search, defaults to false, and writes only canonical upstream.claude', () => {
  const fallbackField = field('claudeServerSideFallback');
  assert.equal(fallbackField.type, 'switch');
  assert.equal(fallbackField.legacyYamlPath, undefined);
  const claudeGroup = CONFIG_GROUPS.find((group) => group.id === 'grp_claude_behavior');
  assert.ok(claudeGroup);
  assert.equal(
    claudeGroup.fieldIds.indexOf('claudeServerSideFallback'),
    claudeGroup.fieldIds.indexOf('claudeToolSearch') + 1,
  );

  const server = parseDocument(CLAUDE_SESSION_YAML);
  assert.equal(getFieldSemanticValue(server, fallbackField), false);

  const draft = parseDocument(CLAUDE_SESSION_YAML);
  updateFieldWithBaseline(draft, server, fallbackField, false);
  assert.deepEqual(computeConfigChanges(server, draft), []);
  assert.equal(draft.toString(), server.toString());

  updateFieldWithBaseline(draft, server, fallbackField, true);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['upstream', 'claude', 'server-side-fallback'], value: true },
  ]);
  assert.equal(draft.getIn(['upstream', 'claude', 'tool-search']), false);

  const readback = parseDocument(draft.toString());
  assert.equal(getFieldSemanticValue(readback, fallbackField), true);

  // Explicit false overrides an enabled server value; reverting restores server bytes.
  const disabledDraft = readback.clone();
  updateFieldWithBaseline(disabledDraft, readback, fallbackField, false);
  assert.deepEqual(computeConfigChanges(readback, disabledDraft), [
    { path: ['upstream', 'claude', 'server-side-fallback'], value: false },
  ]);

  updateFieldWithBaseline(draft, server, fallbackField, false);
  assert.equal(draft.toString(), server.toString());
});

for (const setting of [
  {
    id: 'antigravitySensitiveWordsReplace',
    siblingId: 'antigravitySensitiveWords',
    groupId: 'grp_antigravity_behavior',
    path: ['oauth', 'providers', 'antigravity', 'sensitive-words-replace'],
    yaml: `${SERVER_YAML}oauth:
    providers:
        antigravity:
            sensitive-words: [claude]
            sensitive-words-replace:
                old/phrase: masked # retained comment
`,
    initial: { 'old/phrase': 'masked' },
    // Slash, dot, interior space, and empty-string deletion must travel inside one map replacement,
    // never as child configuration path segments.
    edited: { 'api/v1.internal': 'public', 'Claude Code': '' },
  },
  {
    id: 'devinSensitiveWordsReplace',
    siblingId: 'devinSensitiveWords',
    groupId: 'grp_other_providers',
    path: ['oauth', 'providers', 'devin', 'sensitive-words-replace'],
    yaml: `${SERVER_YAML}oauth:
    providers:
        devin:
            sensitive-words: [secret-line]
            sensitive-words-replace:
                Devin internal: ""
`,
    initial: { 'Devin internal': '' },
    edited: { 'Devin internal': 'Assistant', 'drop\\phrase': '' },
  },
]) {
  test(`${setting.id} replaces and clears a phrase map atomically without splitting keys into path segments`, () => {
    const mapField = field(setting.id);
    assert.equal(mapField.type, 'string_map');
    const group = CONFIG_GROUPS.find((item) => item.id === setting.groupId);
    assert.ok(group);
    assert.equal(
      group.fieldIds.indexOf(setting.id),
      group.fieldIds.indexOf(setting.siblingId) + 1,
    );

    const server = parseDocument(setting.yaml);
    const draft = server.clone();
    assert.deepEqual(getFieldSemanticValue(server, mapField), setting.initial);
    assert.deepEqual(computeConfigChanges(server, draft), []);

    updateFieldWithBaseline(draft, server, mapField, setting.edited);
    assert.deepEqual(computeConfigChanges(server, draft), [
      { path: setting.path, value: setting.edited },
    ]);
    const readback = parseDocument(draft.toString());
    assert.deepEqual(getFieldSemanticValue(readback, mapField), setting.edited);

    const cleared = readback.clone();
    updateFieldWithBaseline(cleared, readback, mapField, {});
    assert.deepEqual(computeConfigChanges(readback, cleared), [
      { path: setting.path, remove: true },
    ]);

    const absent = parseDocument(cleared.toString());
    const empty = absent.clone();
    updateFieldWithBaseline(empty, absent, mapField, {});
    assert.deepEqual(computeConfigChanges(absent, empty), []);
    updateFieldWithBaseline(empty, absent, mapField, setting.edited);
    assert.deepEqual(computeConfigChanges(absent, empty), [
      { path: setting.path, value: setting.edited },
    ]);

    updateFieldWithBaseline(draft, server, mapField, setting.initial);
    assert.equal(draft.toString(), server.toString());
  });
}

test('rebasing a sensitive-words-replace edit preserves concurrent additions while applying draft edits and removals', () => {
  const mapField = field('antigravitySensitiveWordsReplace');
  const base = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  updateFieldWithBaseline(draft, base, mapField, { 'Claude Code': '' });

  const newer = `${SERVER_YAML}oauth:
    providers:
        antigravity:
            sensitive-words: [claude]
            sensitive-words-replace:
                concurrent: kept
`;
  const rebased = parseDocument(rebaseDraft(base, draft, newer) ?? '');
  assert.deepEqual(rebased.getIn(['oauth', 'providers', 'antigravity', 'sensitive-words'])?.toJSON(), ['claude']);
  assert.deepEqual(getFieldSemanticValue(rebased, mapField), { concurrent: 'kept', 'Claude Code': '' });

  const existingYaml = `${SERVER_YAML}oauth:
    providers:
        antigravity:
            sensitive-words-replace:
                old: one
                drop: bye
`;
  const existingBase = parseDocument(existingYaml);
  const existingDraft = existingBase.clone();
  updateFieldWithBaseline(existingDraft, existingBase, mapField, { old: 'two', added: '' });
  const refreshedYaml = `${SERVER_YAML}oauth:
    providers:
        antigravity:
            sensitive-words-replace:
                old: one
                drop: bye
                concurrent: three
`;
  const rebasedExisting = parseDocument(rebaseDraft(existingBase, existingDraft, refreshedYaml) ?? '');
  assert.deepEqual(getFieldSemanticValue(rebasedExisting, mapField), {
    old: 'two',
    concurrent: 'three',
    added: '',
  });
  assert.deepEqual(computeConfigChanges(parseDocument(refreshedYaml), rebasedExisting), [
    {
      path: ['oauth', 'providers', 'antigravity', 'sensitive-words-replace'],
      value: { old: 'two', concurrent: 'three', added: '' },
    },
  ]);
});

test('stringMapRowsToWire trims target keys, keeps empty deletion values and __proto__ keys, and ignores blank draft rows', () => {
  const wire = stringMapRowsToWire([
    { key: '  Claude Code  ', value: '' },
    { key: '   ', value: '' },
    { key: 'target', value: '  literal  ' },
    { key: '__proto__', value: 'safe' },
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(wire, '__proto__'), true);
  assert.equal(wire['__proto__'], 'safe');
  assert.deepEqual(Object.entries(wire), [
    ['Claude Code', ''],
    ['target', '  literal  '],
    ['__proto__', 'safe'],
  ]);
});

test('rebaseStringMapDraft carries concurrent baseline entries into retained invalid rows while preserving unique row IDs', () => {
  const rebased = rebaseStringMapDraft(
    {
      rows: [
        // Pretend an earlier refresh allocated `smap_sync_concurrent`, which the operator then renamed to `b`.
        { id: 'smap_sync_concurrent', key: 'b', value: 'renamed' },
        { id: 'row-invalid', key: '', value: 'two' },
      ],
      baseWire: {},
    },
    { concurrent: 'kept' },
  );
  assert.equal(rebased.rows[0]?.id, 'smap_sync_concurrent');
  assert.equal(rebased.rows[1]?.id, 'row-invalid');
  assert.notEqual(rebased.rows[2]?.id, 'smap_sync_concurrent');
  assert.notEqual(rebased.rows[2]?.id, 'row-invalid');
  assert.deepEqual(
    rebased.rows.map(({ key, value }) => ({ key, value })),
    [
      { key: 'b', value: 'renamed' },
      { key: '', value: 'two' },
      { key: 'concurrent', value: 'kept' },
    ],
  );
});

