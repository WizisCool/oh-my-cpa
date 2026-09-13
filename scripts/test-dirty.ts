import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from '../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/browser/index.js';
import {
  updateFieldWithBaseline,
  isConfigSemanticallyEqual,
  areValuesSemanticallyEqual,
  getFieldSemanticValue,
} from '../web/src/components/config/configDirty.ts';

const testFields = [
  { id: 'host', yamlPath: ['host'], type: 'string', defaultValue: '' },
  { id: 'port', yamlPath: ['port'], type: 'number', defaultValue: 8317 },
  { id: 'debug', yamlPath: ['debug'], type: 'switch', defaultValue: false },
  { id: 'tlsEnable', yamlPath: ['tls', 'enable'], type: 'switch', defaultValue: false },
  { id: 'tlsCert', yamlPath: ['tls', 'cert'], type: 'string', defaultValue: '' },
];

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
