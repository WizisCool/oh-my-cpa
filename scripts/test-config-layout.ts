/**
 * Field placement for CPA v8 documents (web/src/components/config/configLayout.ts).
 *
 * The relocation rules are read from the Go table the server sends, so this suite
 * exercises the same data the console receives rather than a copy of it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isSeq, parseDocument } from '../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/browser/index.js';

import { getFieldSemanticValue, isConfigSemanticallyEqual, updateFieldWithBaseline } from '../web/src/components/config/configDirty.ts';
import {
  describeLayoutRefusal,
  layoutNoticeKey,
  payloadComparisonPaths,
  resolveConfigField,
  resolveConfigFields,
  resolvePayloadPlacement,
} from '../web/src/components/config/configLayout.ts';
import { readPayloadCategory, writePayloadCategory } from '../web/src/components/config/payloadRules.ts';
import { ALL_CONFIG_FIELDS, type ConfigFieldDefinition } from '../web/src/types/configSchema.ts';
import type { ConfigLayoutInfo, ConfigLayoutRule } from '../web/src/types/configManagement.ts';

const RULE_SOURCE = readFileSync(new URL('../internal/cpa/configyaml/layout_rules.go', import.meta.url), 'utf8');

function rulesFrom(tableName: string): ConfigLayoutRule[] {
  const start = RULE_SOURCE.indexOf(`var ${tableName} = []LayoutRule{`);
  assert.ok(start >= 0, `${tableName} not found`);
  const body = RULE_SOURCE.slice(start, RULE_SOURCE.indexOf('\n}', start));
  return [...body.matchAll(/\{Legacy: "([^"]+)", Current: "([^"]+)"(, LegacyKind: LegacyKindSequence)?\}/g)].map((match) => ({
    legacy: match[1],
    current: match[2],
    ...(match[3] ? { legacy_kind: 'sequence' } : {}),
  }));
}

// Same order as configyaml.LayoutRules(): leaves, then sections.
const LEAF_RULES = rulesFrom('CONFIG_LAYOUT_LEAF_RULES');
const RULES = [...LEAF_RULES, ...rulesFrom('CONFIG_LAYOUT_SECTION_RULES')];

function layoutOf(layout: ConfigLayoutInfo['layout'], managementAPI: ConfigLayoutInfo['management_api'] = 'v8'): ConfigLayoutInfo {
  return { management_api: managementAPI, layout, has_provider_groups: layout !== 'legacy', rules: RULES };
}

function field(id: string): ConfigFieldDefinition {
  const found = ALL_CONFIG_FIELDS.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

// Legacy leaves CPA v8 would drop from this document: both spellings present.
function shadowedLeaves(yaml: string): string[] {
  const doc = parseDocument(yaml);
  return LEAF_RULES.filter((rule) => {
    const legacy = doc.getIn(rule.legacy.split('.'));
    const legacyCounts = legacy !== undefined && (rule.legacy_kind !== 'sequence' || isSeq(legacy));
    return legacyCounts && doc.hasIn(rule.current.split('.'));
  }).map((rule) => rule.legacy);
}

// setIn stores plain values while parsed nodes are YAML collections.
function plain(value: unknown): unknown {
  return value && typeof (value as { toJSON?: unknown }).toJSON === 'function' ? (value as { toJSON: () => unknown }).toJSON() : value;
}

const V8_DOC = `config-version: 8
access:
  api-keys:
    - client-key
routing:
  strategy: round-robin
  retry:
    request-retry: 3
observability:
  logs:
    debug: false
api-keys:
  codex:
    - name: codex-1
      keys:
        - api-key: sk-upstream
`;

const LEGACY_DOC = `api-keys:
  - client-key
request-retry: 3
debug: false
`;

test('the rule table parsed from Go is the one the server sends', () => {
  assert.ok(RULES.length > 100, `only ${RULES.length} rules parsed`);
  assert.ok(RULES.some((rule) => rule.legacy === 'api-keys' && rule.current === 'access.api-keys' && rule.legacy_kind === 'sequence'));
});

test('a legacy document keeps every legacy path, on either gateway', () => {
  for (const layout of [layoutOf('legacy', 'v0'), layoutOf('legacy', 'v8'), undefined]) {
    for (const item of ALL_CONFIG_FIELDS) {
      assert.deepEqual(resolveConfigField(item, layout), item);
    }
    assert.deepEqual(resolvePayloadPlacement(layout), { path: ['payload'] });
  }
});

test('every schema field has a v8 location or is shared by both layouts', () => {
  // Settings CPA v8 keeps at the same path; the quota switches have no v8
  // counterpart at all and stay legacy-only.
  const SHARED = new Set([
    'routing.strategy',
    'routing.session-affinity',
    'routing.session-affinity-ttl',
    'plugins.enabled',
    'plugins.store-sources',
    'plugins.store-auth',
    'quota-exceeded.switch-project',
    'quota-exceeded.switch-preview-model',
  ]);
  for (const resolved of resolveConfigFields(ALL_CONFIG_FIELDS, layoutOf('v8'))) {
    const legacy = (resolved.legacyYamlPath ?? resolved.yamlPath).join('.');
    if (resolved.legacyYamlPath) {
      assert.ok(
        LEAF_RULES.some((rule) => rule.legacy === legacy),
        `${resolved.id} (${legacy}) is not a CPA leaf; CPA would not read it`,
      );
    } else {
      assert.ok(SHARED.has(legacy), `${resolved.id} (${legacy}) has no v8 location and is not a shared path`);
    }
  }
});

test('an edit in a v8 document lands at the v8 path and round-trips byte for byte', () => {
  const retry = resolveConfigField(field('requestRetry'), layoutOf('v8'));
  assert.deepEqual(retry.yamlPath, ['routing', 'retry', 'request-retry']);
  const serverDoc = parseDocument(V8_DOC);
  const doc = parseDocument(V8_DOC);
  updateFieldWithBaseline(doc, serverDoc, retry, 9);
  assert.equal(doc.getIn(['routing', 'retry', 'request-retry']), 9);
  assert.equal(doc.has('request-retry'), false);

  const commercial = resolveConfigField(field('commercialMode'), layoutOf('v8'));
  updateFieldWithBaseline(doc, serverDoc, commercial, true);
  assert.equal(doc.getIn(['server', 'commercial-mode']), true);

  updateFieldWithBaseline(doc, serverDoc, retry, 3);
  updateFieldWithBaseline(doc, serverDoc, commercial, false);
  assert.equal(doc.toString(), serverDoc.toString(), 'an edit and its undo must leave no server: {} behind');
});

test('every field written into a v8 document leaves nothing for CPA to drop', () => {
  const fields = resolveConfigFields(ALL_CONFIG_FIELDS, layoutOf('v8'));
  const serverDoc = parseDocument(V8_DOC);
  const doc = parseDocument(V8_DOC);
  for (const item of fields) {
    if (item.id === 'apiKeys') continue;
    const value = item.type === 'switch' ? !getFieldSemanticValue(serverDoc, item)
      : item.type === 'number' ? 7
      : item.type === 'json_editor' ? [{ match: 'https://example.com/' }]
      : item.type === 'select' ? 'fill-first'
      : 'edited';
    updateFieldWithBaseline(doc, serverDoc, item, value);
  }
  assert.deepEqual(shadowedLeaves(doc.toString()), []);
  for (const rule of LEAF_RULES) {
    if (rule.legacy === 'api-keys') continue;
    assert.equal(doc.hasIn(rule.legacy.split('.')), false, `legacy ${rule.legacy} written into a v8 document`);
  }
});

test('a legacy spelling left in a v8 document is read, then replaced on write', () => {
  // A v0 setter writes a legacy key when the v8 document has no value there yet;
  // CPA v8 runs with it, so the editor has to show it.
  const yaml = `${V8_DOC}request-log: true\n`;
  const requestLog = resolveConfigField(field('requestLog'), layoutOf('v8'));
  const serverDoc = parseDocument(yaml);
  const doc = parseDocument(yaml);
  assert.equal(getFieldSemanticValue(doc, requestLog), true);
  updateFieldWithBaseline(doc, serverDoc, requestLog, false);
  assert.equal(doc.getIn(['observability', 'logs', 'request-log']), false);
  assert.equal(doc.has('request-log'), false);
  assert.deepEqual(shadowedLeaves(doc.toString()), []);
  updateFieldWithBaseline(doc, serverDoc, requestLog, true);
  assert.equal(doc.toString(), serverDoc.toString());
});

test('client keys in a v8 document are access.api-keys, never the provider groups', () => {
  const apiKeys = resolveConfigField(field('apiKeys'), layoutOf('v8'));
  assert.deepEqual(apiKeys.yamlPath, ['access', 'api-keys']);
  const serverDoc = parseDocument(V8_DOC);
  const doc = parseDocument(V8_DOC);
  assert.deepEqual(getFieldSemanticValue(doc, apiKeys), ['client-key']);
  updateFieldWithBaseline(doc, serverDoc, apiKeys, ['client-key', 'client-key-2']);
  assert.deepEqual(plain(doc.getIn(['access', 'api-keys'])), ['client-key', 'client-key-2']);
  assert.deepEqual(plain(doc.getIn(['api-keys'])), plain(serverDoc.getIn(['api-keys'])), 'provider groups must be untouched');

  // Without access.api-keys the provider mapping is still not a client-key list.
  const noAccess = parseDocument(V8_DOC.replace('access:\n  api-keys:\n    - client-key\n', ''));
  assert.deepEqual(getFieldSemanticValue(noAccess, apiKeys), []);
});

test('the v7 editing path is unchanged', () => {
  const serverDoc = parseDocument(LEGACY_DOC);
  const doc = parseDocument(LEGACY_DOC);
  const fields = resolveConfigFields(ALL_CONFIG_FIELDS, layoutOf('legacy', 'v0'));
  const retry = fields.find((item) => item.id === 'requestRetry')!;
  updateFieldWithBaseline(doc, serverDoc, retry, 9);
  assert.equal(doc.get('request-retry'), 9);
  assert.equal(doc.has('routing'), false);
  assert.equal(isConfigSemanticallyEqual(doc, serverDoc, fields), false);
  updateFieldWithBaseline(doc, serverDoc, retry, 3);
  assert.equal(doc.toString(), serverDoc.toString());
});

test('payload rules move to requests.payload and read the legacy section until written', () => {
  const placement = resolvePayloadPlacement(layoutOf('mixed'));
  assert.deepEqual(placement, { path: ['requests', 'payload'], legacyPath: ['payload'] });
  const yaml = `${V8_DOC}payload:\n  default:\n    - models: [{name: a}]\n      params: {x: 1}\n  filter:\n    - models: [{name: b}]\n      params: [y]\n`;
  const serverDoc = parseDocument(yaml);
  const doc = parseDocument(yaml);
  assert.deepEqual(readPayloadCategory(doc, 'filter', placement), [{ models: [{ name: 'b' }], params: ['y'] }]);

  writePayloadCategory(doc, 'filter', [{ models: [{ name: 'c' }], params: ['z'] }], placement);
  assert.deepEqual(plain(doc.getIn(['requests', 'payload', 'filter'])), [{ models: [{ name: 'c' }], params: ['z'] }]);
  assert.equal(doc.hasIn(['payload', 'filter']), false);
  assert.deepEqual(readPayloadCategory(doc, 'default', placement), [{ models: [{ name: 'a' }], params: { x: 1 } }], 'an untouched legacy category is still what CPA runs');
  assert.equal(isConfigSemanticallyEqual(doc, serverDoc, [], payloadComparisonPaths(placement)), false);

  writePayloadCategory(doc, 'default', [], placement);
  writePayloadCategory(doc, 'filter', [], placement);
  assert.equal(doc.has('payload'), false);
  assert.equal(doc.has('requests'), false, 'emptied maps are pruned up to the root');
});

test('layout notices and refusal messages', () => {
  assert.equal(layoutNoticeKey(undefined), null);
  assert.equal(layoutNoticeKey(layoutOf('legacy', 'v0')), null);
  assert.equal(layoutNoticeKey(layoutOf('legacy', 'v8')), 'cfg.layout_legacy_on_v8');
  assert.equal(layoutNoticeKey(layoutOf('v8')), 'cfg.layout_v8');
  assert.equal(layoutNoticeKey(layoutOf('mixed')), 'cfg.layout_mixed');

  const t = (key: string, vars?: Record<string, string | number>) => `${key}:${vars?.keys ?? ''}`;
  assert.equal(
    describeLayoutRefusal('config_legacy_keys_shadowed', { shadowed: [{ legacy: 'debug', current: 'observability.logs.debug' }] }, t),
    'cfg.layout_shadowed:debug → observability.logs.debug',
  );
  assert.equal(describeLayoutRefusal('config_provider_groups_replaced', null, t), 'cfg.layout_provider_groups_replaced:');
  assert.equal(describeLayoutRefusal('config_conflict', null, t), null);
});
