import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from '../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/browser/index.js';
import {
  updateFieldWithBaseline,
  isConfigSemanticallyEqual,
  areValuesSemanticallyEqual,
  getFieldSemanticValue,
} from '../web/src/components/config/configDirty.ts';
import { ALL_CONFIG_FIELDS, type ConfigFieldDefinition } from '../web/src/types/configSchema.ts';

function schemaField(id: string): ConfigFieldDefinition {
  const found = ALL_CONFIG_FIELDS.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

const testFields = [
  { id: 'host', yamlPath: ['host'], type: 'string', defaultValue: '' },
  { id: 'port', yamlPath: ['port'], type: 'number', defaultValue: 8317 },
  { id: 'debug', yamlPath: ['debug'], type: 'switch', defaultValue: false },
  { id: 'tlsEnable', yamlPath: ['tls', 'enable'], type: 'switch', defaultValue: false },
  { id: 'tlsCert', yamlPath: ['tls', 'cert'], type: 'string', defaultValue: '' },
];

// A mixed setting's word states are not booleans. `Boolean('chat')` is true, so comparing
// truthiness alone would read "disabled everywhere" and "disabled in chat only" as the same
// state and never save the switch between them.
test('A mixed setting distinguishes its word states from its boolean ones', () => {
  assert.equal(areValuesSemanticallyEqual(true, 'chat'), false, 'a disabled-everywhere switch is not the chat-only mode');
  assert.equal(areValuesSemanticallyEqual(false, 'passthrough'), false);
  assert.equal(areValuesSemanticallyEqual('chat', 'chat'), true);
  assert.equal(areValuesSemanticallyEqual(false, undefined), true, 'an absent switch is off');
  assert.equal(areValuesSemanticallyEqual('true', true), true);
});

test('The image-generation picker reads all four modes as the states CPA stores', () => {
  const imageGeneration = schemaField('disableImageGeneration');
  for (const [optionKey, stored] of [['false', false], ['true', true], ['chat', 'chat'], ['passthrough', 'passthrough']] as const) {
    const doc = parseDocument(`multimedia:\n    disable-image-generation: ${JSON.stringify(stored)}\n`);
    const value = getFieldSemanticValue(doc, imageGeneration);
    assert.equal(value, stored, optionKey);
    const option = imageGeneration.options?.find((item) => item.value === optionKey);
    assert.equal(option?.yamlValue ?? option?.value, stored, `${optionKey} writes ${String(stored)}`);
  }
});

// The editor owns several lists (trusted proxies, sensitive words). Clearing one has to leave
// the document byte-identical to the server's, not merely semantically equal.
test('An emptied list is the same fact as an absent one', () => {
  assert.equal(areValuesSemanticallyEqual([], undefined), true);
  assert.equal(areValuesSemanticallyEqual([], []), true);
  assert.equal(areValuesSemanticallyEqual(['a'], []), false);
});

test('Clearing a list the server did not have returns the editor to the server bytes', () => {
  const originalYaml = 'server:\n    port: 8317\n';
  const serverDoc = parseDocument(originalYaml);
  const currentDoc = parseDocument(originalYaml);
  const trustedProxies = schemaField('trustedProxies');

  updateFieldWithBaseline(currentDoc, serverDoc, trustedProxies, ['127.0.0.1']);
  assert.equal(currentDoc.hasIn(['server', 'trusted-proxies']), true);
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, ALL_CONFIG_FIELDS), false);

  updateFieldWithBaseline(currentDoc, serverDoc, trustedProxies, []);
  assert.equal(currentDoc.hasIn(['server', 'trusted-proxies']), false);
  // The editor drops the whole draft and reloads the server document once nothing differs, so
  // semantic equality here is what makes the cleared list byte-identical for the operator.
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, ALL_CONFIG_FIELDS), true);
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, ALL_CONFIG_FIELDS) ? originalYaml : currentDoc.toString(), originalYaml);
});

test('Omitted switch toggle ON then OFF restores exact clean YAML', () => {
  const originalYaml = `host: "127.0.0.1"\nport: 8317\n`;
  const serverDoc = parseDocument(originalYaml);
  const currentDoc = parseDocument(originalYaml);

  // Turn debug ON
  updateFieldWithBaseline(currentDoc, serverDoc, testFields[2], true);
  assert.equal(currentDoc.get('debug'), true);
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, testFields), false);

  // Turn debug OFF
  updateFieldWithBaseline(currentDoc, serverDoc, testFields[2], false);
  assert.equal(currentDoc.has('debug'), false);
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, testFields), true);
  assert.equal(currentDoc.toString().trim(), originalYaml.trim());
});

test('Omitted nested field toggle ON then OFF cleans up empty parent and restores clean YAML', () => {
  const originalYaml = `host: "127.0.0.1"\nport: 8317\n`;
  const serverDoc = parseDocument(originalYaml);
  const currentDoc = parseDocument(originalYaml);

  // Turn tls.enable ON
  updateFieldWithBaseline(currentDoc, serverDoc, testFields[3], true);
  assert.equal(currentDoc.hasIn(['tls', 'enable']), true);
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, testFields), false);

  // Turn tls.enable OFF
  updateFieldWithBaseline(currentDoc, serverDoc, testFields[3], false);
  assert.equal(currentDoc.has('tls'), false);
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, testFields), true);
  assert.equal(currentDoc.toString().trim(), originalYaml.trim());
});

test('Number change 8317 -> 9000 -> 8317 restores clean YAML', () => {
  const originalYaml = `host: "127.0.0.1"\nport: 8317\n`;
  const serverDoc = parseDocument(originalYaml);
  const currentDoc = parseDocument(originalYaml);

  // Change port to 9000
  updateFieldWithBaseline(currentDoc, serverDoc, testFields[1], 9000);
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, testFields), false);

  // Revert port to 8317
  updateFieldWithBaseline(currentDoc, serverDoc, testFields[1], 8317);
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, testFields), true);
  assert.equal(currentDoc.toString().trim(), originalYaml.trim());
});

test('Modifying field A and field B, then reverting field A preserves field B', () => {
  const originalYaml = `host: "127.0.0.1"\nport: 8317\n`;
  const serverDoc = parseDocument(originalYaml);
  const currentDoc = parseDocument(originalYaml);

  updateFieldWithBaseline(currentDoc, serverDoc, testFields[0], '0.0.0.0');
  updateFieldWithBaseline(currentDoc, serverDoc, testFields[1], 9000);

  // Revert host to 127.0.0.1
  updateFieldWithBaseline(currentDoc, serverDoc, testFields[0], '127.0.0.1');
  assert.equal(currentDoc.get('port'), 9000);
  assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, testFields), false);
});

const apiKeysField = {
  id: 'apiKeys',
  yamlPath: ['api-keys'],
  type: 'api_keys',
  defaultValue: [],
};

// A YAML sequence reaches the AST as a node whose items only appear through
// toJSON(). Reading the node directly yields an object, so a populated list is
// indistinguishable from an empty one and a populated config renders as "0 keys".
test('A populated sequence reads back as its items, not as an opaque node', () => {
  const doc = parseDocument(`api-keys:\n  - sk-one\n  - sk-two\n`);
  const value = getFieldSemanticValue(doc, apiKeysField);
  assert.equal(Array.isArray(value), true, `expected an array, got ${typeof value}`);
  assert.deepEqual(value, ['sk-one', 'sk-two']);
});

test('An absent sequence field falls back to the schema default', () => {
  const doc = parseDocument(`host: "127.0.0.1"\n`);
  assert.deepEqual(getFieldSemanticValue(doc, apiKeysField), []);
});

test('Editing the key list round-trips through the document unchanged', () => {
  const originalYaml = `host: "127.0.0.1"\napi-keys:\n  - sk-existing\n`;
  const serverDoc = parseDocument(originalYaml);
  const currentDoc = parseDocument(originalYaml);

  updateFieldWithBaseline(currentDoc, serverDoc, apiKeysField, ['sk-existing', 'sk-added']);
  assert.deepEqual(getFieldSemanticValue(currentDoc, apiKeysField), ['sk-existing', 'sk-added']);

  // Reverting to the server's list must restore the document byte for byte.
  updateFieldWithBaseline(currentDoc, serverDoc, apiKeysField, ['sk-existing']);
  assert.equal(currentDoc.toString().trim(), originalYaml.trim());
});

for (const [fieldId, exampleValue] of [['requestRetry', 3], ['maxRetryInterval', 30]] as const) {
  test(`${fieldId} reads an omitted CPA setting as zero and persists an explicit example value`, () => {
    const field = schemaField(fieldId);
    const originalYaml = '# Keep unrelated settings intact.\nserver:\n  port: 8317\n';
    const serverDoc = parseDocument(originalYaml);
    const currentDoc = parseDocument(originalYaml);

    assert.equal(getFieldSemanticValue(serverDoc, field), 0);
    updateFieldWithBaseline(currentDoc, serverDoc, field, exampleValue);
    assert.equal(getFieldSemanticValue(currentDoc, field), exampleValue);
    assert.equal(currentDoc.hasIn(field.yamlPath), true);
    assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, [field]), false);

    updateFieldWithBaseline(currentDoc, serverDoc, field, 0);
    assert.equal(currentDoc.hasIn(field.yamlPath), false);
    assert.equal(currentDoc.toString(), serverDoc.toString());
  });

  test(`${fieldId} keeps an explicit zero and restores an existing value with its comment`, () => {
    const field = schemaField(fieldId);
    const originalYaml = `routing:\n  retry:\n    ${field.yamlPath.at(-1)}: ${exampleValue} # Explicit policy.\n`;
    const serverDoc = parseDocument(originalYaml);
    const currentDoc = parseDocument(originalYaml);

    assert.equal(getFieldSemanticValue(serverDoc, field), exampleValue);
    updateFieldWithBaseline(currentDoc, serverDoc, field, 0);
    assert.equal(getFieldSemanticValue(currentDoc, field), 0);
    assert.equal(currentDoc.hasIn(field.yamlPath), true);
    assert.equal(isConfigSemanticallyEqual(currentDoc, serverDoc, [field]), false);

    updateFieldWithBaseline(currentDoc, serverDoc, field, exampleValue);
    assert.equal(currentDoc.toString(), serverDoc.toString());
  });
}
