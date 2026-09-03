import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from '../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/browser/index.js';
import {
  updateFieldWithBaseline,
  isConfigSemanticallyEqual,
  areValuesSemanticallyEqual,
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
