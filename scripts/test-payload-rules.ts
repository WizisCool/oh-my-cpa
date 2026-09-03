import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from '../web/node_modules/yaml/browser/index.js';
import {
  parseTypedRules,
  serializeTypedRules,
  parseRawRules,
  serializeRawRules,
  parseFilterRules,
  serializeFilterRules,
  readPayloadCategory,
  writePayloadCategory,
  isValidJson,
  validateAllPayloadRules,
} from '../web/src/components/config/payloadRules.ts';

test('Payload Typed Rules lossless round-trip with models, protocols, headers, match', () => {
  const original = [
    {
      models: [
        {
          name: 'gemini-2.5-pro',
          protocol: 'gemini',
          'from-protocol': 'responses',
          headers: {
            'X-Client-Tier': 'tenant-*-region-*',
          },
          match: [{ 'metadata.client': 'codex' }, { 'tier.id': 2 }, { 'is_vip': true }],
          'not-match': [{ 'metadata.mode': 'dev' }, { 'debug': false }],
          exist: ['tools.#(type=="web_search").type'],
          'not-exist': ['metadata.disable_payload'],
          unknown_model_flag: true,
        },
      ],
      params: {
        'generationConfig.thinkingConfig.thinkingBudget': 32768,
        'temperature': 0.7,
        'stream': false,
        'null_val': null,
        'complex': { nested: 'data' },
      },
      unknown_rule_flag: 'preserved',
    },
  ];

  const parsed = parseTypedRules(original, 'default');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].models[0].name, 'gemini-2.5-pro');
  assert.equal(parsed[0].models[0].protocol, 'gemini');
  assert.equal(parsed[0].models[0].fromProtocol, 'responses');
  assert.deepEqual(parsed[0].models[0].headers, [{ id: 'default_r0_m0_hdr_0_X-Client-Tier', key: 'X-Client-Tier', value: 'tenant-*-region-*' }]);
  assert.deepEqual(parsed[0].models[0].match, [
    { id: 'default_r0_m0_match_0_metadata.client', key: 'metadata.client', value: 'codex' },
    { id: 'default_r0_m0_match_1_tier.id', key: 'tier.id', value: 2 },
    { id: 'default_r0_m0_match_2_is_vip', key: 'is_vip', value: true },
  ]);
  assert.deepEqual(parsed[0].models[0].notMatch, [
    { id: 'default_r0_m0_notmatch_0_metadata.mode', key: 'metadata.mode', value: 'dev' },
    { id: 'default_r0_m0_notmatch_1_debug', key: 'debug', value: false },
  ]);
  assert.deepEqual(parsed[0].models[0].exist, ['tools.#(type=="web_search").type']);
  assert.deepEqual(parsed[0].models[0].notExist, ['metadata.disable_payload']);

  const serialized = serializeTypedRules(parsed);
  assert.equal(serialized.length, 1);
  assert.equal((serialized[0] as Record<string, unknown>).unknown_rule_flag, 'preserved');
  assert.equal((serialized[0].models as Record<string, unknown>[])[0].unknown_model_flag, true);
  assert.deepEqual((serialized[0].models as Record<string, unknown>[])[0].match, [
    { 'metadata.client': 'codex' },
    { 'tier.id': 2 },
    { 'is_vip': true },
  ]);
  assert.deepEqual((serialized[0].models as Record<string, unknown>[])[0]['not-match'], [
    { 'metadata.mode': 'dev' },
    { 'debug': false },
  ]);
  assert.deepEqual((serialized[0].models as Record<string, unknown>[])[0].headers, { 'X-Client-Tier': 'tenant-*-region-*' });
  assert.equal((serialized[0].params as Record<string, unknown>)['generationConfig.thinkingConfig.thinkingBudget'], 32768);
  assert.equal((serialized[0].params as Record<string, unknown>)['temperature'], 0.7);
  assert.equal((serialized[0].params as Record<string, unknown>)['stream'], false);
  assert.equal((serialized[0].params as Record<string, unknown>)['null_val'], null);
  assert.deepEqual((serialized[0].params as Record<string, unknown>)['complex'], { nested: 'data' });
});

test('Payload Raw Rules round-trip', () => {
  const original = [
    {
      models: [{ name: 'gpt-*', protocol: 'codex' }],
      params: {
        response_format: '{"type":"json_schema","schema":{"type":"object"}}',
        raw_number: '123',
        raw_bool: 'true',
        raw_null: 'null',
        raw_array: '["a", "b", 3]',
        raw_object: '{"key": "val"}',
      },
    },
  ];

  const parsed = parseRawRules(original, 'default-raw');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].params.length, 6);
  const serialized = serializeRawRules(parsed);
  const params = (serialized[0] as Record<string, any>).params;
  assert.equal(params.response_format, '{"type":"json_schema","schema":{"type":"object"}}');
  assert.equal(params.raw_number, '123');
  assert.equal(params.raw_bool, 'true');
  assert.equal(params.raw_null, 'null');
  assert.equal(params.raw_array, '["a", "b", 3]');
  assert.equal(params.raw_object, '{"key": "val"}');
});

test('Payload Filter Rules round-trip', () => {
  const original = [
    {
      models: [{ name: 'gemini-2.5-pro', protocol: 'gemini' }],
      params: [
        'generationConfig.thinkingConfig.thinkingBudget',
        'generationConfig.responseJsonSchema',
      ],
    },
  ];

  const parsed = parseFilterRules(original, 'filter');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].params.length, 2);
  const serialized = serializeFilterRules(parsed);
  assert.deepEqual((serialized[0] as Record<string, any>).params, [
    'generationConfig.thinkingConfig.thinkingBudget',
    'generationConfig.responseJsonSchema',
  ]);
});

test('Document AST write and read retains outside YAML content and comments', () => {
  const yaml = `
# Top level comment
host: "127.0.0.1"
port: 8317

payload:
  default:
    - models:
        - name: "gpt-4"
      params:
        temperature: 0.5
`;

  const doc = parseDocument(yaml);
  const existingDefault = readPayloadCategory(doc, 'default');
  assert.ok(Array.isArray(existingDefault));

  // Modify default category
  writePayloadCategory(doc, 'default', [
    {
      models: [{ name: 'gpt-4o' }],
      params: { temperature: 0.8 },
    },
  ]);

  const output = doc.toString();
  assert.ok(output.includes('# Top level comment'));
  assert.ok(output.includes('host: "127.0.0.1"'));
  assert.ok(output.includes('port: 8317'));
  assert.ok(output.includes('gpt-4o'));
  assert.ok(output.includes('0.8'));
});

test('isValidJson helper handles numbers, booleans, strings, objects, arrays', () => {
  assert.equal(isValidJson('true'), true);
  assert.equal(isValidJson('123'), true);
  assert.equal(isValidJson('"hello"'), true);
  assert.equal(isValidJson('{"a": 1}'), true);
  assert.equal(isValidJson('[1, 2]'), true);
  assert.equal(isValidJson('{not json'), false);
  assert.equal(isValidJson(''), false);
});

test('validateAllPayloadRules accurately detects issues without premature errors', () => {
  // Empty rules array: 0 issues
  const emptyIssues = validateAllPayloadRules([], [], [], [], []);
  assert.equal(emptyIssues.length, 0);

  // New rule with blank model and blank path
  const draftRule = [
    {
      id: 'r1',
      models: [{ id: 'm1', name: '' }],
      params: [{ id: 'p1', path: '', type: 'string' as const, value: '' }],
    },
  ];
  const draftIssues = validateAllPayloadRules(draftRule, [], [], [], []);
  assert.equal(draftIssues.length, 2);
  assert.equal(draftIssues[0].field, 'model');
  assert.equal(draftIssues[1].field, 'path');

  // Completed valid rule: 0 issues
  draftRule[0].models[0].name = 'gpt-4o';
  draftRule[0].params[0].path = 'temperature';
  draftRule[0].params[0].value = '0.7';
  const validIssues = validateAllPayloadRules(draftRule, [], [], [], []);
  assert.equal(validIssues.length, 0);

  // Duplicate param path: 2 issues (both duplicate rows flagged)
  draftRule[0].params.push({ id: 'p2', path: 'temperature', type: 'number' as const, value: 0.7 });
  const dupIssues = validateAllPayloadRules(draftRule, [], [], [], []);
  assert.equal(dupIssues.length, 2);
  assert.equal(dupIssues[0].field, 'duplicate');
  assert.equal(dupIssues[1].field, 'duplicate');
});
