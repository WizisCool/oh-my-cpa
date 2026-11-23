/**
 * What a configuration save sends (web/src/components/config/configPatch.ts), and
 * the schema it is computed over.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseDocument } from 'yaml';

import { getFieldSemanticValue, updateFieldWithBaseline } from '../../src/components/config/configDirty.ts';
import { computeConfigChanges, rebaseDraft } from '../../src/components/config/configPatch.ts';
import {
  findRe2PatternProblem,
  patternRulesRowsToWire,
  rebasePatternRulesDraft,
  reconcileWirePatternRows,
  validatePatternRuleRows,
} from '../../src/components/config/PatternRulesEditor.tsx';
import { validateGoRe2Pattern } from '../../src/components/config/goRegex.ts';
import { rebaseStringMapDraft, stringMapRowsToWire } from '../../src/components/config/StringMapEditor.tsx';
import {
  generateServerId,
  isValidServerId,
  reconcileServerIdDraft,
  validateServerIdInput,
} from '../../src/components/config/ServerIdField.tsx';
import { writePayloadCategory } from '../../src/components/config/payloadRules.ts';
import { ALL_CONFIG_FIELDS, CONFIG_GROUPS, type ConfigFieldDefinition } from '../../src/types/configSchema.ts';

// The top-level sections CPA v8 accepts. A name outside them is refused by CPA as
// an unknown section or a legacy field, so an editor field placed there could
// never be saved.
const V8_SECTIONS = new Set([
  'models', 'server', 'management', 'access', 'credentials', 'routing', 'requests', 'oauth',
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
  assert.deepEqual((rebased.getIn(['oauth', 'providers', 'antigravity', 'sensitive-words']) as { toJSON(): unknown } | undefined)?.toJSON(), ['claude']);
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

for (const setting of [
  {
    id: 'antigravitySensitivePatternsReplace',
    siblingId: 'antigravitySensitiveWordsReplace',
    groupId: 'grp_antigravity_behavior',
    path: ['oauth', 'providers', 'antigravity', 'sensitive-patterns-replace'],
    yaml: `${SERVER_YAML}oauth:
    providers:
        antigravity:
            sensitive-words: [claude]
            sensitive-words-replace:
                Claude Code: ""
            sensitive-patterns-replace:
                - pattern: "(?i)claude\\\\s+code" # retained comment
                  replacement: ""
                - pattern: "internal/v1"
                  replacement: "public"
`,
    initial: [
      { pattern: '(?i)claude\\s+code', replacement: '' },
      { pattern: 'internal/v1', replacement: 'public' },
    ],
    // Order and duplicate patterns are significant in CPA's ordered rule sequence.
    edited: [
      { pattern: 'internal/v1', replacement: 'public' },
      { pattern: '(?i)claude\\s+code', replacement: '' },
      { pattern: 'internal/v1', replacement: 'edge' },
    ],
  },
  {
    id: 'devinSensitivePatternsReplace',
    siblingId: 'devinSensitiveWordsReplace',
    groupId: 'grp_other_providers',
    path: ['oauth', 'providers', 'devin', 'sensitive-patterns-replace'],
    yaml: `${SERVER_YAML}oauth:
    providers:
        devin:
            sensitive-words: [secret-line]
            sensitive-patterns-replace:
                - pattern: "(?m)^Devin internal.*$"
                  replacement: ""
`,
    initial: [{ pattern: '(?m)^Devin internal.*$', replacement: '' }],
    edited: [
      { pattern: 'foo ', replacement: '' },
      { pattern: '(?m)^Devin internal.*$', replacement: 'Assistant' },
    ],
  },
]) {
  test(`${setting.id} reads, replaces in order, and clears pattern rules while preserving siblings`, () => {
    const rulesField = field(setting.id);
    assert.equal(rulesField.type, 'pattern_rules');
    const group = CONFIG_GROUPS.find((item) => item.id === setting.groupId);
    assert.ok(group);
    assert.equal(
      group.fieldIds.indexOf(setting.id),
      group.fieldIds.indexOf(setting.siblingId) + 1,
    );

    const server = parseDocument(setting.yaml);
    const draft = server.clone();
    assert.deepEqual(getFieldSemanticValue(server, rulesField), setting.initial);
    assert.deepEqual(computeConfigChanges(server, draft), []);

    updateFieldWithBaseline(draft, server, rulesField, setting.edited);
    assert.deepEqual(computeConfigChanges(server, draft), [
      { path: setting.path, value: setting.edited },
    ]);
    const readback = parseDocument(draft.toString());
    assert.deepEqual(getFieldSemanticValue(readback, rulesField), setting.edited);

    const cleared = readback.clone();
    updateFieldWithBaseline(cleared, readback, rulesField, []);
    assert.deepEqual(computeConfigChanges(readback, cleared), [
      { path: setting.path, remove: true },
    ]);

    const absent = parseDocument(cleared.toString());
    const empty = absent.clone();
    updateFieldWithBaseline(empty, absent, rulesField, []);
    assert.deepEqual(computeConfigChanges(absent, empty), []);
    updateFieldWithBaseline(empty, absent, rulesField, setting.edited);
    assert.deepEqual(computeConfigChanges(absent, empty), [
      { path: setting.path, value: setting.edited },
    ]);

    updateFieldWithBaseline(draft, server, rulesField, setting.initial);
    assert.equal(draft.toString(), server.toString());
  });
}

test('rebasing a sensitive-patterns-replace edit preserves concurrent sibling settings', () => {
  const rulesField = field('antigravitySensitivePatternsReplace');
  const base = parseDocument(SERVER_YAML);
  const draft = parseDocument(SERVER_YAML);
  updateFieldWithBaseline(draft, base, rulesField, [{ pattern: '(?i)claude', replacement: '' }]);

  const newer = `${SERVER_YAML}oauth:
    providers:
        antigravity:
            sensitive-words: [claude]
            sensitive-words-replace:
                concurrent: kept
`;
  const rebased = parseDocument(rebaseDraft(base, draft, newer) ?? '');
  assert.deepEqual((rebased.getIn(['oauth', 'providers', 'antigravity', 'sensitive-words']) as { toJSON(): unknown } | undefined)?.toJSON(), ['claude']);
  assert.deepEqual((rebased.getIn(['oauth', 'providers', 'antigravity', 'sensitive-words-replace']) as { toJSON(): unknown } | undefined)?.toJSON(), { concurrent: 'kept' });
  assert.deepEqual(getFieldSemanticValue(rebased, rulesField), [{ pattern: '(?i)claude', replacement: '' }]);
  assert.deepEqual(computeConfigChanges(parseDocument(newer), rebased), [
    {
      path: ['oauth', 'providers', 'antigravity', 'sensitive-patterns-replace'],
      value: [{ pattern: '(?i)claude', replacement: '' }],
    },
  ]);

  // Concurrent refresh adding a rule while a valid local pattern_rules edit is pending preserves the added rule.
  const existingBase = parseDocument(`${SERVER_YAML}oauth:
    providers:
        antigravity:
            sensitive-patterns-replace:
                - pattern: a
                  replacement: one
`);
  const editedDraft = existingBase.clone();
  updateFieldWithBaseline(editedDraft, existingBase, rulesField, [{ pattern: 'a', replacement: 'edited' }]);
  const refreshedAdded = `${SERVER_YAML}oauth:
    providers:
        antigravity:
            sensitive-patterns-replace:
                - pattern: a
                  replacement: one
                - pattern: c
                  replacement: added
`;
  const rebasedAdded = parseDocument(rebaseDraft(existingBase, editedDraft, refreshedAdded) ?? '');
  assert.deepEqual(getFieldSemanticValue(rebasedAdded, rulesField), [
    { pattern: 'a', replacement: 'edited' },
    { pattern: 'c', replacement: 'added' },
  ]);

  // Overlapping edits to the same existing rule report a rebase conflict rather than silently dropping server changes.
  const conflictingNext = `${SERVER_YAML}oauth:
    providers:
        antigravity:
            sensitive-patterns-replace:
                - pattern: a
                  replacement: server-edited
`;
  assert.equal(rebaseDraft(existingBase, editedDraft, conflictingNext), null);
});

test('reconcileWirePatternRows preserves row IDs across prepended rules and duplicates', () => {
  let serial = 1;
  const alloc = () => `prule_wire_${serial++}`;
  const initial = reconcileWirePatternRows(
    [
      { pattern: 'dup', replacement: 'first' },
      { pattern: 'dup', replacement: 'first' },
      { pattern: 'target', replacement: 'keep' },
    ],
    [],
    alloc,
  );
  const shifted = reconcileWirePatternRows(
    [
      { pattern: 'prepended', replacement: '' },
      { pattern: 'dup', replacement: 'first' },
      { pattern: 'dup', replacement: 'first' },
      { pattern: 'target', replacement: 'keep' },
    ],
    initial,
    alloc,
  );
  assert.equal(shifted[1]?.id, initial[0]?.id);
  assert.equal(shifted[2]?.id, initial[1]?.id);
  assert.equal(shifted[3]?.id, initial[2]?.id);
  assert.equal(new Set(shifted.map((row) => row.id)).size, 4);
});

test('patternRulesRowsToWire preserves significant whitespace in patterns and empty deletions', () => {
  assert.deepEqual(
    patternRulesRowsToWire([
      { pattern: '  foo  ', replacement: '' },
      { pattern: '   ', replacement: '' },
      { pattern: '(?i)bar', replacement: '  baz  ' },
    ]),
    [
      { pattern: '  foo  ', replacement: '' },
      { pattern: '(?i)bar', replacement: '  baz  ' },
    ],
  );
});

test('findRe2PatternProblem and validatePatternRuleRows accept valid Go RE2 and flag blank or unsupported rules', () => {
  for (const valid of [
    '(?i)claude\\s+code',
    '(?P<word>foo|bar)',
    '\\Q(?=a)\\1\\E',
    '\\\\1',
    '\\0',
    '\\12',
    '\\123',
    '\\777',
    '\\123\\12',
    '\\(?=a)',
    '[(?=)]',
    '[[:alpha:]]+',
    '[]a]',
    '[^]a]',
  ]) {
    assert.equal(findRe2PatternProblem(valid), null, valid);
  }
  for (const unsupported of ['foo(?=bar)', 'foo(?!bar)', '(?<=a)b', '(?<!a)b', '(a)\\1', '\\18', '\\80', '\\9']) {
    assert.equal(findRe2PatternProblem(unsupported), 'unsupported_re2', unsupported);
  }
  assert.equal(findRe2PatternProblem('foo\\'), 'trailing_backslash');

  for (const valid of [
    '(?i)claude\\s+code',
    '(?P<word>foo|bar)',
    '\\Q(?=a)\\1\\E',
    '\\\\1',
    '\\0',
    '\\12',
    '\\123',
    '\\777',
    '\\123\\12',
    '\\(?=a\\)',
    '[(?=)]',
    '[[:alpha:]]+',
    '[]a]',
    '[^]a]',
    '(?<name>foo|bar)',
    'a{1,2}?',
    '\\Qunclosed',
    '{01}',
    'a{0,01}',
    'a(?i)*',
    'a*(?i)+',
    '\\p{Han}',
    '\\p{Cc}+',
    '\\p{cntrl}+',
    '\\p{Separator}+',
    '\\p{Kawi}',
    '\\p{Old_Italic}+',
    '\\p{Uppercase-Letter}',
    '\\p{Uppercase Letter}',
    '\\p{^Uppercase_Letter}',
    '\\pL',
    '\\A\\b\\w+\\z',
    '\\-',
    '[A-[:]]',
    '[A-[:alpha:]]',
    '[a-]',
    '(?:a{20}){40}',
    '((a{100}){0}b){11}',
    'a+\\Q\\E+',
    '\\Qa\\E*',
    `[${'[:'.repeat(200)}x]`,
    'é',
    '\\.',
  ]) {
    assert.equal(validateGoRe2Pattern(valid), null, valid);
  }
  for (const unsupported of [
    'foo(?=bar)',
    'foo(?!bar)',
    '(?<=a)b',
    '(?<!a)b',
    '(a)\\1',
    '\\18',
    '\\80',
    '\\9',
    '(?>abc)',
    '(?(1)a|b)',
    '(?x)abc',
    '\\u0041',
    '\\Z',
  ]) {
    assert.equal(validateGoRe2Pattern(unsupported), 'unsupported_re2', unsupported);
  }
  for (const invalidSyntax of [
    '\\(?=a)',
    '(?i)*',
    '\\q',
    '\\E',
    '[\\b]',
    '\\p{123}',
    '\\p{Leter}',
    '\\p{Garay}',
    '\\p{\u212Aawi}',
    '\\Q\\E*',
    '\\é',
    '[z-a]',
    '(?:a{40}){40}',
    '(?:(?:a{1000}){0,}){2}',
    '((a{100}){1}b){11}',
    '(a{100}(b)){11}',
    '((a{100})*b){11}',
    '((a{100})+b){11}',
    'a++',
    '[unclosed',
    'a{2,1}',
  ]) {
    assert.equal(validateGoRe2Pattern(invalidSyntax), 'invalid_syntax', invalidSyntax);
  }
  assert.equal(validateGoRe2Pattern('foo\\'), 'trailing_backslash');

  assert.deepEqual(validatePatternRuleRows([{ pattern: '', replacement: '' }]), {
    issue: null,
    rowErrors: [false],
  });
  assert.deepEqual(validatePatternRuleRows([{ pattern: '   ', replacement: '' }]), {
    issue: { kind: 'empty_pattern' },
    rowErrors: [true],
  });
  assert.deepEqual(validatePatternRuleRows([{ pattern: '', replacement: 'x' }]), {
    issue: { kind: 'empty_pattern' },
    rowErrors: [true],
  });
  assert.deepEqual(validatePatternRuleRows([{ pattern: 'a', replacement: '' }, { pattern: '(a)\\1', replacement: '' }]), {
    issue: { kind: 'unsupported_re2', pattern: '(a)\\1' },
    rowErrors: [false, true],
  });
});

test('rebasePatternRulesDraft carries concurrent baseline rules into retained incomplete rows without ID collisions', () => {
  const rebased = rebasePatternRulesDraft(
    {
      rows: [
        { id: 'prule_wire_0', pattern: 'a', replacement: 'one' },
        // Simulate an earlier refresh row that now sits at index 1 while index 0 changes on refresh.
        { id: 'prule_sync_0', pattern: 'kept', replacement: 'stay' },
        { id: 'prule_sync_1', pattern: '', replacement: 'two' },
      ],
      baseWire: [
        { pattern: 'a', replacement: 'one' },
        { pattern: 'kept', replacement: 'stay' },
      ],
    },
    [
      { pattern: 'updated', replacement: 'fresh' },
      { pattern: 'kept', replacement: 'stay' },
      { pattern: 'concurrent', replacement: 'kept' },
    ],
  );
  assert.equal(rebased.rows[1]?.id, 'prule_sync_0');
  assert.equal(rebased.rows[3]?.id, 'prule_sync_1');
  const ids = rebased.rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    rebased.rows.map(({ pattern, replacement }) => ({ pattern, replacement })),
    [
      { pattern: 'updated', replacement: 'fresh' },
      { pattern: 'kept', replacement: 'stay' },
      { pattern: 'concurrent', replacement: 'kept' },
      { pattern: '', replacement: 'two' },
    ],
  );

  // A pending blank row moved before an existing rule retains its relative precedence on refresh.
  const rebasedLeadingBlank = rebasePatternRulesDraft(
    {
      rows: [
        { id: 'prule_new_1', pattern: '', replacement: 'leading' },
        { id: 'prule_wire_0', pattern: 'a', replacement: 'one' },
      ],
      baseWire: [{ pattern: 'a', replacement: 'one' }],
    },
    [
      { pattern: 'a_updated', replacement: 'two' },
      { pattern: 'concurrent', replacement: 'kept' },
    ],
  );
  assert.deepEqual(
    rebasedLeadingBlank.rows.map(({ pattern, replacement }) => ({ pattern, replacement })),
    [
      { pattern: '', replacement: 'leading' },
      { pattern: 'a_updated', replacement: 'two' },
      { pattern: 'concurrent', replacement: 'kept' },
    ],
  );
});

test('shutdownTimeout sits in grp_service, preserves omitted defaults, writes positive budgets, and reverts to server bytes', () => {
  const shutdownField = field('shutdownTimeout');
  assert.equal(shutdownField.type, 'number');
  assert.equal(shutdownField.sectionId, 'connectivity');
  assert.deepEqual(shutdownField.yamlPath, ['server', 'shutdown-timeout']);
  assert.equal(shutdownField.legacyYamlPath, undefined);
  assert.equal(shutdownField.min, 0);
  assert.equal(shutdownField.max, undefined);
  assert.equal(shutdownField.defaultValue, 0);
  assert.equal(shutdownField.unitKey, 'cfg.unit_seconds');

  const serviceGroup = CONFIG_GROUPS.find((group) => group.id === 'grp_service');
  assert.ok(serviceGroup);
  assert.equal(serviceGroup.sectionId, 'connectivity');
  assert.equal(serviceGroup.variant, 'form-grid');
  assert.ok(serviceGroup.fieldIds.includes('shutdownTimeout'));

  // Omitted default stays absent through default confirmation, cleared input, and unrelated saves.
  const server = parseDocument(SERVER_YAML);
  const draft = server.clone();
  assert.equal(getFieldSemanticValue(server, shutdownField), 0);
  updateFieldWithBaseline(draft, server, shutdownField, 0);
  assert.equal(draft.hasIn(['server', 'shutdown-timeout']), false);
  assert.equal(draft.toString(), server.toString());
  updateFieldWithBaseline(draft, server, shutdownField, null);
  assert.equal(draft.hasIn(['server', 'shutdown-timeout']), false);
  assert.equal(draft.toString(), server.toString());

  updateFieldWithBaseline(draft, server, field('debug'), true);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['observability', 'logs', 'debug'], value: true },
  ]);
  assert.equal(draft.hasIn(['server', 'shutdown-timeout']), false);
  updateFieldWithBaseline(draft, server, field('debug'), false);

  // Positive drain budgets above 30s remain representable without client-side clamping.
  updateFieldWithBaseline(draft, server, shutdownField, 45);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['server', 'shutdown-timeout'], value: 45 },
  ]);
  assert.equal(getFieldSemanticValue(parseDocument(draft.toString()), shutdownField), 45);

  // Reverting an added value restores the original server bytes.
  updateFieldWithBaseline(draft, server, shutdownField, 0);
  assert.deepEqual(computeConfigChanges(server, draft), []);
  assert.equal(draft.toString(), server.toString());

  // Existing explicit positive value preserves comments on revert and allows explicit 0 override.
  const configuredYaml = `${SERVER_YAML.replace('port: 8317\n', 'port: 8317\n    shutdown-timeout: 45 # drain budget\n')}`;
  const configured = parseDocument(configuredYaml);
  assert.equal(getFieldSemanticValue(configured, shutdownField), 45);
  const zeroDraft = configured.clone();
  updateFieldWithBaseline(zeroDraft, configured, shutdownField, 0);
  assert.deepEqual(computeConfigChanges(configured, zeroDraft), [
    { path: ['server', 'shutdown-timeout'], value: 0 },
  ]);
  assert.equal(getFieldSemanticValue(parseDocument(zeroDraft.toString()), shutdownField), 0);
  updateFieldWithBaseline(zeroDraft, configured, shutdownField, 45);
  assert.deepEqual(computeConfigChanges(configured, zeroDraft), []);
  assert.equal(zeroDraft.toString(), configured.toString());

  // Rebase carries a shutdownTimeout edit onto a newer baseline without dropping concurrent changes.
  const rebasedDraft = server.clone();
  updateFieldWithBaseline(rebasedDraft, server, shutdownField, 60);
  const newerYaml = SERVER_YAML.replace('port: 8317', 'port: 9000');
  const rebased = parseDocument(rebaseDraft(server, rebasedDraft, newerYaml) ?? '');
  assert.equal(rebased.getIn(['server', 'port']), 9000);
  assert.equal(getFieldSemanticValue(rebased, shutdownField), 60);
  assert.deepEqual(computeConfigChanges(parseDocument(newerYaml), rebased), [
    { path: ['server', 'shutdown-timeout'], value: 60 },
  ]);
});

test('antigravityTosPauseWindow sits in grp_antigravity_behavior, preserves omitted defaults, writes durations or disable words, and rebases beside siblings', () => {
  const pauseField = field('antigravityTosPauseWindow');
  assert.equal(pauseField.type, 'string');
  assert.equal(pauseField.sectionId, 'providers');
  assert.deepEqual(pauseField.yamlPath, ['oauth', 'providers', 'antigravity', 'tos-pause-window']);
  assert.equal(pauseField.placeholder, '0');

  const antigravityGroup = CONFIG_GROUPS.find((group) => group.id === 'grp_antigravity_behavior');
  assert.ok(antigravityGroup);
  assert.equal(antigravityGroup.sectionId, 'providers');
  assert.ok(antigravityGroup.fieldIds.includes('antigravityTosPauseWindow'));

  // Omitted default stays absent through empty confirmation and unrelated saves.
  const server = parseDocument(SERVER_YAML);
  const draft = server.clone();
  assert.equal(getFieldSemanticValue(server, pauseField), undefined);
  updateFieldWithBaseline(draft, server, pauseField, '');
  assert.equal(draft.hasIn(['oauth']), false);
  assert.equal(draft.toString(), server.toString());

  // Writing duration or disable words ("30m", "off", "0") emits the canonical path.
  for (const value of ['30m', 'off', '0']) {
    const edited = server.clone();
    updateFieldWithBaseline(edited, server, pauseField, value);
    assert.deepEqual(computeConfigChanges(server, edited), [
      { path: ['oauth'], value: { providers: { antigravity: { 'tos-pause-window': value } } } },
    ]);
    assert.equal(getFieldSemanticValue(parseDocument(edited.toString()), pauseField), value);
    updateFieldWithBaseline(edited, server, pauseField, '');
    assert.deepEqual(computeConfigChanges(server, edited), []);
    assert.equal(edited.toString(), server.toString());
  }

  // Existing explicit value preserves comments on revert and supports clearing to absent.
  const configuredYaml = `${SERVER_YAML}oauth:
    providers:
        antigravity:
            antigravity-credits: true # retained sibling
            tos-pause-window: 6h # explicit pool pause
`;
  const configured = parseDocument(configuredYaml);
  assert.equal(getFieldSemanticValue(configured, pauseField), '6h');

  const updatedDraft = configured.clone();
  updateFieldWithBaseline(updatedDraft, configured, pauseField, '2h');
  assert.deepEqual(computeConfigChanges(configured, updatedDraft), [
    { path: ['oauth', 'providers', 'antigravity', 'tos-pause-window'], value: '2h' },
  ]);
  updateFieldWithBaseline(updatedDraft, configured, pauseField, '6h');
  assert.equal(updatedDraft.toString(), configured.toString());

  const clearedDraft = configured.clone();
  updateFieldWithBaseline(clearedDraft, configured, pauseField, '');
  assert.deepEqual(computeConfigChanges(configured, clearedDraft), [
    { path: ['oauth', 'providers', 'antigravity', 'tos-pause-window'], remove: true },
  ]);
  assert.equal(clearedDraft.getIn(['oauth', 'providers', 'antigravity', 'antigravity-credits']), true);

  // Rebase carries an edit onto a newer baseline with concurrent sibling changes.
  const rebasedDraft = configured.clone();
  updateFieldWithBaseline(rebasedDraft, configured, pauseField, 'disabled');
  const newerYaml = configuredYaml.replace('antigravity-credits: true', 'antigravity-credits: false');
  const rebased = parseDocument(rebaseDraft(configured, rebasedDraft, newerYaml) ?? '');
  assert.equal(rebased.getIn(['oauth', 'providers', 'antigravity', 'antigravity-credits']), false);
  assert.equal(getFieldSemanticValue(rebased, pauseField), 'disabled');
  assert.deepEqual(computeConfigChanges(parseDocument(newerYaml), rebased), [
    { path: ['oauth', 'providers', 'antigravity', 'tos-pause-window'], value: 'disabled' },
  ]);
});

test('payloadReplaceRules schema registration, searchability, patch emission, and rebase preservation', () => {
  const replaceField = field('payloadReplaceRules');
  assert.equal(replaceField.sectionId, 'payload');
  assert.deepEqual(replaceField.yamlPath, ['requests', 'payload', 'replace']);
  assert.ok(replaceField.keywords?.includes('replace'));

  const payloadGroup = CONFIG_GROUPS.find((group) => group.id === 'grp_payload_rules');
  assert.ok(payloadGroup);
  assert.ok(payloadGroup.fieldIds.includes('payloadReplaceRules'));

  const server = parseDocument(SERVER_YAML);
  const draft = server.clone();
  const replaceValue = [
    {
      models: [{ name: '*', protocol: 'claude', 'from-protocol': 'openai' }],
      target: { role: 'system', positions: [1, 2] },
      replacements: [
        { 'you are hero': 'you are fool' },
        { pattern: '(?i)secret-(\\d+)', replacement: '[redacted-$1]' },
        { 'remove this phrase': '' },
      ],
    },
    {
      models: [{ name: 'gpt-*', protocol: 'codex' }],
      target: { paths: ['instructions', 'input.0.content'] },
      replacements: [{ pattern: '^prefix:\\s*', replacement: '' }],
    },
  ];
  writePayloadCategory(draft, 'replace', replaceValue);
  assert.deepEqual(computeConfigChanges(server, draft), [
    { path: ['requests', 'payload', 'replace'], value: replaceValue },
  ]);

  // Concurrent server update outside requests.payload.replace preserves the replace draft.
  const newer = SERVER_YAML.replace('port: 8317', 'port: 9000');
  const rebased = parseDocument(rebaseDraft(server, draft, newer) ?? '');
  assert.equal(rebased.getIn(['server', 'port']), 9000);
  assert.deepEqual(computeConfigChanges(parseDocument(newer), rebased), [
    { path: ['requests', 'payload', 'replace'], value: replaceValue },
  ]);

  // Clearing replace emits removal when server previously held replace rules.
  const populatedServer = parseDocument(draft.toString());
  const clearedDraft = populatedServer.clone();
  writePayloadCategory(clearedDraft, 'replace', []);
  assert.deepEqual(computeConfigChanges(populatedServer, clearedDraft), [
    { path: ['requests', 'payload', 'replace'], remove: true },
  ]);
});

test('Claude OAuth create_api_key scope switch stays omitted at default and persists explicit false', () => {
  const scopeField = field('claudeOAuthIncludeCreateAPIKey');
  assert.equal(scopeField.sectionId, 'providers');
  assert.equal(scopeField.type, 'switch');
  assert.equal(scopeField.defaultValue, true);
  assert.deepEqual(scopeField.yamlPath, ['oauth', 'providers', 'claude', 'oauth-include-create-api-key']);
  assert.equal(scopeField.legacyYamlPath, undefined);
  for (const keyword of ['claude', 'oauth', 'scope', 'create_api_key']) {
    assert.ok(scopeField.keywords?.includes(keyword), `expected keyword ${keyword}`);
  }
  const claudeGroup = CONFIG_GROUPS.find((group) => group.id === 'grp_claude_behavior');
  assert.ok(claudeGroup?.fieldIds.includes('claudeOAuthIncludeCreateAPIKey'));

  // Default install: omitted key reads as true and never writes a redundant line.
  const defaultServer = parseDocument(SERVER_YAML);
  const defaultDraft = defaultServer.clone();
  assert.equal(getFieldSemanticValue(defaultServer, scopeField), true);
  updateFieldWithBaseline(defaultDraft, defaultServer, scopeField, true);
  assert.deepEqual(computeConfigChanges(defaultServer, defaultDraft), []);
  assert.equal(defaultDraft.toString(), defaultServer.toString());

  // Toggling OFF writes explicit false; toggling back ON before save prunes empty ancestors.
  updateFieldWithBaseline(defaultDraft, defaultServer, scopeField, false);
  assert.deepEqual(computeConfigChanges(defaultServer, defaultDraft), [
    { path: ['oauth'], value: { providers: { claude: { 'oauth-include-create-api-key': false } } } },
  ]);
  updateFieldWithBaseline(defaultDraft, defaultServer, scopeField, true);
  assert.equal(defaultDraft.has('oauth'), false);
  assert.deepEqual(computeConfigChanges(defaultServer, defaultDraft), []);
  assert.equal(defaultDraft.toString(), defaultServer.toString());

  // Explicit false survives subsequent unrelated edits and reads back as false.
  const optedOutYaml = `${SERVER_YAML}oauth:
    providers:
        claude:
            oauth-include-create-api-key: false # org policy
        antigravity:
            tos-pause-window: 10m
`;
  const optedOutServer = parseDocument(optedOutYaml);
  const optedOutDraft = optedOutServer.clone();
  assert.equal(getFieldSemanticValue(optedOutServer, scopeField), false);
  updateFieldWithBaseline(optedOutDraft, optedOutServer, field('debug'), true);
  assert.deepEqual(computeConfigChanges(optedOutServer, optedOutDraft), [
    { path: ['observability', 'logs', 'debug'], value: true },
  ]);
  assert.equal(optedOutDraft.getIn(['oauth', 'providers', 'claude', 'oauth-include-create-api-key']), false);

  // Toggling explicit false back to true updates only the leaf key and reverting restores comments.
  const reenableDraft = optedOutServer.clone();
  updateFieldWithBaseline(reenableDraft, optedOutServer, scopeField, true);
  assert.deepEqual(computeConfigChanges(optedOutServer, reenableDraft), [
    { path: ['oauth', 'providers', 'claude', 'oauth-include-create-api-key'], value: true },
  ]);
  assert.equal(reenableDraft.getIn(['oauth', 'providers', 'antigravity', 'tos-pause-window']), '10m');
  updateFieldWithBaseline(reenableDraft, optedOutServer, scopeField, false);
  assert.equal(reenableDraft.toString(), optedOutServer.toString());

  // Explicit null in YAML matches Go *bool nil semantics (defaults to true).
  const nullServer = parseDocument('oauth:\n    providers:\n        claude:\n            oauth-include-create-api-key: null\n');
  assert.equal(getFieldSemanticValue(nullServer, scopeField), true);

  // Rebasing an opt-out onto a newer server baseline preserves sibling OAuth provider settings.
  const rebaseBase = parseDocument(SERVER_YAML);
  const rebaseEdit = rebaseBase.clone();
  updateFieldWithBaseline(rebaseEdit, rebaseBase, scopeField, false);
  const newerWithSibling = `${SERVER_YAML}oauth:
    providers:
        antigravity:
            tos-pause-window: 15m
`;
  const rebased = parseDocument(rebaseDraft(rebaseBase, rebaseEdit, newerWithSibling) ?? '');
  assert.equal(rebased.getIn(['oauth', 'providers', 'antigravity', 'tos-pause-window']), '15m');
  assert.equal(rebased.getIn(['oauth', 'providers', 'claude', 'oauth-include-create-api-key']), false);
  assert.deepEqual(computeConfigChanges(parseDocument(newerWithSibling), rebased), [
    { path: ['oauth', 'providers', 'claude'], value: { 'oauth-include-create-api-key': false } },
  ]);
});

test('model catalog source fields preserve absent default, emit canonical patches, clear cleanly, and rebase', () => {
  const catalogGroup = CONFIG_GROUPS.find((group) => group.id === 'grp_model_catalogs');
  assert.ok(catalogGroup);
  assert.equal(catalogGroup.sectionId, 'providers');
  assert.equal(catalogGroup.variant, 'form-grid');
  assert.deepEqual(catalogGroup.fieldIds, ['modelsCatalog', 'modelsCodexCatalog', 'modelsDevinCatalog']);

  const specs = [
    {
      id: 'modelsCatalog',
      key: 'catalog',
      values: ['https://mirror.example.test/models.json', '/etc/cpa/models.json'],
    },
    {
      id: 'modelsCodexCatalog',
      key: 'codex-catalog',
      values: ['https://mirror.example.test/codex_client_models.json', '/etc/cpa/codex.json'],
    },
    {
      id: 'modelsDevinCatalog',
      key: 'devin-catalog',
      values: ['https://mirror.example.test/devin_models.json', 'C:\\cpa\\devin_models.json'],
    },
  ] as const;

  const bareServer = parseDocument(SERVER_YAML);
  for (const spec of specs) {
    const catalogField = field(spec.id);
    assert.equal(catalogField.sectionId, 'providers');
    assert.equal(catalogField.type, 'string');
    assert.deepEqual(catalogField.yamlPath, ['models', spec.key]);
    assert.equal(catalogField.legacyYamlPath, undefined);

    // Unconfigured models stays absent so older CPA gateways remain untouched.
    const untouched = bareServer.clone();
    assert.equal(getFieldSemanticValue(bareServer, catalogField), undefined);
    updateFieldWithBaseline(untouched, bareServer, catalogField, '');
    assert.equal(untouched.hasIn(['models']), false);
    assert.equal(untouched.toString(), bareServer.toString());

    for (const value of spec.values) {
      const edited = bareServer.clone();
      updateFieldWithBaseline(edited, bareServer, catalogField, value);
      assert.deepEqual(computeConfigChanges(bareServer, edited), [
        { path: ['models'], value: { [spec.key]: value } },
      ]);
      assert.equal(getFieldSemanticValue(parseDocument(edited.toString()), catalogField), value);

      updateFieldWithBaseline(edited, bareServer, catalogField, '');
      assert.deepEqual(computeConfigChanges(bareServer, edited), []);
      assert.equal(edited.toString(), bareServer.toString());
    }
  }

  // Existing models section updates only the edited key, preserves sibling keys and comments,
  // and emits DELETE when a configured source is cleared.
  const configuredYaml = `${SERVER_YAML}models:
    catalog: https://custom.example.test/models.json # custom general catalog
    codex-catalog: /etc/cpa/codex_client_models.json
    devin-catalog: ""
`;
  const configured = parseDocument(configuredYaml);
  const generalField = field('modelsCatalog');
  const codexField = field('modelsCodexCatalog');
  const devinField = field('modelsDevinCatalog');
  assert.equal(getFieldSemanticValue(configured, generalField), 'https://custom.example.test/models.json');
  assert.equal(getFieldSemanticValue(configured, codexField), '/etc/cpa/codex_client_models.json');
  assert.equal(getFieldSemanticValue(configured, devinField), '');

  const updatedDraft = configured.clone();
  updateFieldWithBaseline(updatedDraft, configured, generalField, '/etc/cpa/custom-models.json');
  assert.deepEqual(computeConfigChanges(configured, updatedDraft), [
    { path: ['models', 'catalog'], value: '/etc/cpa/custom-models.json' },
  ]);
  updateFieldWithBaseline(updatedDraft, configured, generalField, 'https://custom.example.test/models.json');
  assert.equal(updatedDraft.toString(), configured.toString());

  const clearedDraft = configured.clone();
  updateFieldWithBaseline(clearedDraft, configured, codexField, '');
  assert.deepEqual(computeConfigChanges(configured, clearedDraft), [
    { path: ['models', 'codex-catalog'], remove: true },
  ]);
  assert.equal(clearedDraft.getIn(['models', 'catalog']), 'https://custom.example.test/models.json');

  // Rebase carries a models.devin-catalog edit onto a newer baseline with concurrent sibling changes.
  const rebaseDraftDoc = configured.clone();
  updateFieldWithBaseline(rebaseDraftDoc, configured, devinField, 'https://custom.example.test/devin.json');
  const newerYaml = configuredYaml.replace('/etc/cpa/codex_client_models.json', 'https://custom.example.test/codex.json');
  const rebased = parseDocument(rebaseDraft(configured, rebaseDraftDoc, newerYaml) ?? '');
  assert.equal(rebased.getIn(['models', 'codex-catalog']), 'https://custom.example.test/codex.json');
  assert.equal(getFieldSemanticValue(rebased, devinField), 'https://custom.example.test/devin.json');
  assert.deepEqual(computeConfigChanges(parseDocument(newerYaml), rebased), [
    { path: ['models', 'devin-catalog'], value: 'https://custom.example.test/devin.json' },
  ]);
});

test('server.server-id validates nonzero hyphenated UUIDs, generates valid v4 IDs, and stays omitted when untouched', () => {
  const serviceGroup = CONFIG_GROUPS.find((group) => group.id === 'grp_service');
  assert.ok(serviceGroup?.fieldIds.includes('serverId'));

  const serverIdField = field('serverId');
  assert.deepEqual(serverIdField.yamlPath, ['server', 'server-id']);
  assert.equal(serverIdField.type, 'server_id');
  assert.equal(serverIdField.defaultValue, undefined);

  // Validation matches CPA's nonzero hyphenated 36-char UUID rule.
  assert.equal(isValidServerId('20fb88e4-73ab-44db-b5b5-4e7120ba3368'), true);
  assert.equal(isValidServerId('  20FB88E4-73AB-44DB-B5B5-4E7120BA3368  '), true);
  assert.equal(isValidServerId('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(isValidServerId('20fb88e473ab44dbb5b54e7120ba3368'), false);
  assert.equal(isValidServerId('not-a-uuid'), false);
  assert.equal(isValidServerId(''), false);
  assert.deepEqual(validateServerIdInput('   '), { kind: 'empty' });
  assert.deepEqual(validateServerIdInput('00000000-0000-0000-0000-000000000000'), { kind: 'invalid_uuid' });
  assert.equal(validateServerIdInput('20fb88e4-73ab-44db-b5b5-4e7120ba3368'), null);

  // Generated UUIDs are always lowercase, valid, and nonzero (including getRandomValues fallback).
  const generated = generateServerId();
  assert.equal(isValidServerId(generated), true);
  assert.equal(generated, generated.toLowerCase());

  const originalRandomUUID = globalThis.crypto?.randomUUID;
  if (globalThis.crypto) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const fallback = generateServerId();
      assert.equal(isValidServerId(fallback), true);
      assert.equal(fallback, fallback.toLowerCase());
      assert.equal(fallback[14], '4');
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: originalRandomUUID, configurable: true });
    }
  }

  // Omitted server.server-id stays omitted during unrelated edits.
  const bareServer = parseDocument(SERVER_YAML);
  const editedPort = bareServer.clone();
  updateFieldWithBaseline(editedPort, bareServer, field('port'), 8318);
  assert.equal(getFieldSemanticValue(bareServer, serverIdField), undefined);
  assert.deepEqual(computeConfigChanges(bareServer, editedPort), [
    { path: ['server', 'port'], value: 8318 },
  ]);

  // Explicit server.server-id edit emits only server.server-id and rebases cleanly across concurrent sibling edits.
  const withIdYaml = 'server:\n  server-id: 11111111-1111-4111-8111-111111111111\n  port: 8317\n';
  const baseDoc = parseDocument(withIdYaml);
  const draftDoc = baseDoc.clone();
  updateFieldWithBaseline(draftDoc, baseDoc, serverIdField, '20FB88E4-73AB-44DB-B5B5-4E7120BA3368');
  assert.deepEqual(computeConfigChanges(baseDoc, draftDoc), [
    { path: ['server', 'server-id'], value: '20FB88E4-73AB-44DB-B5B5-4E7120BA3368' },
  ]);

  const concurrentYaml = 'server:\n  server-id: 11111111-1111-4111-8111-111111111111\n  port: 9000\n';
  const rebased = parseDocument(rebaseDraft(baseDoc, draftDoc, concurrentYaml) ?? '');
  assert.equal(rebased.getIn(['server', 'port']), 9000);
  assert.equal(getFieldSemanticValue(rebased, serverIdField), '20FB88E4-73AB-44DB-B5B5-4E7120BA3368');

  // Reconciling a draft advances rollback when it tracked the old baseline, while keeping pre-edit unsaved values.
  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';
  const idC = '33333333-3333-4333-8333-333333333333';
  assert.deepEqual(
    reconcileServerIdDraft({ isEditing: true, inputValue: 'bad', previousValue: idA }, idA, idB),
    { isEditing: true, inputValue: 'bad', previousValue: idB },
  );
  assert.deepEqual(
    reconcileServerIdDraft({ isEditing: true, inputValue: 'bad', previousValue: idC }, idA, idB),
    { isEditing: true, inputValue: 'bad', previousValue: idC },
  );
});
