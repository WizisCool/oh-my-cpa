import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseDocument } from 'yaml';
import {
  PAYLOAD_PROTOCOLS,
  buildPayloadProtocolOptions,
  parseTypedRules,
  serializeTypedRules,
  parseRawRules,
  serializeRawRules,
  parseFilterRules,
  serializeFilterRules,
  parseReplaceRules,
  serializeReplaceRules,
  appendReplacePositionTokens,
  reconcileReplaceRules,
  readPayloadCategory,
  writePayloadCategory,
  isValidJson,
  validateAllPayloadRules,
  validatePayloadDocument,
} from '../../src/components/config/payloadRules.ts';

// CPA's payload-rule engine matches `models[].protocol` against each executor's protocol identifier
// (`openai`, `gemini`, `claude`, `codex`, `antigravity`, `meta`), while an omitted `protocol` leaves
// the rule unrestricted. Omitting a documented value from the selector leaves operators unable to
// author or re-select it in the visual editor.
test('Every payload-rule protocol CPA documents is offered after the unrestricted default', () => {
  assert.deepEqual(PAYLOAD_PROTOCOLS, [
    'openai',
    'gemini',
    'claude',
    'codex',
    'antigravity',
    'meta',
  ]);
  assert.deepEqual(buildPayloadProtocolOptions('Default'), [
    { value: '', label: 'Default' },
    { value: 'openai', label: 'openai' },
    { value: 'gemini', label: 'gemini' },
    { value: 'claude', label: 'claude' },
    { value: 'codex', label: 'codex' },
    { value: 'antigravity', label: 'antigravity' },
    { value: 'meta', label: 'meta' },
  ]);
});

test('Meta protocol target round-trips across typed, raw, and filter payload rules', () => {
  const typed = parseTypedRules(
    [{ models: [{ name: 'muse-*', protocol: 'meta' }], params: { prompt_cache_retention: '24h' } }],
    'default',
  );
  assert.equal(typed[0].models[0].protocol, 'meta');
  assert.deepEqual(serializeTypedRules(typed), [
    { models: [{ name: 'muse-*', protocol: 'meta' }], params: { prompt_cache_retention: '24h' } },
  ]);

  const raw = parseRawRules(
    [{ models: [{ name: 'muse-*', protocol: 'meta' }], params: { metadata: '{"tier":"pro"}' } }],
    'override-raw',
  );
  assert.equal(raw[0].models[0].protocol, 'meta');
  assert.deepEqual(serializeRawRules(raw), [
    { models: [{ name: 'muse-*', protocol: 'meta' }], params: { metadata: '{"tier":"pro"}' } },
  ]);

  const filter = parseFilterRules(
    [{ models: [{ name: 'muse-*', protocol: 'meta' }], params: ['prompt_cache_retention'] }],
    'filter',
  );
  assert.equal(filter[0].models[0].protocol, 'meta');
  assert.deepEqual(serializeFilterRules(filter), [
    { models: [{ name: 'muse-*', protocol: 'meta' }], params: ['prompt_cache_retention'] },
  ]);

  typed[0].models[0].protocol = '';
  assert.deepEqual(serializeTypedRules(typed), [
    { models: [{ name: 'muse-*' }], params: { prompt_cache_retention: '24h' } },
  ]);

  typed[0].models[0].protocol = 'meta';
  assert.deepEqual(serializeTypedRules(typed), [
    { models: [{ name: 'muse-*', protocol: 'meta' }], params: { prompt_cache_retention: '24h' } },
  ]);
});

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

requests:
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
  assert.equal(isValidJson(undefined), false);
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

/**
 * Writing a category into a document that has no usable `requests.payload` map yet.
 *
 * This is the ordinary case, not an edge: a fresh CPA config has no `requests.payload` at
 * all, and `payload:` left empty is just as common. Both used to make the rule editor
 * throw out of its own React event handler, which meant the document was never
 * updated, nothing read as dirty, the save bar never appeared, and payload rules
 * could not be saved at all.
 */
test('a document with no payload key takes payload rules', () => {
  const doc = parseDocument('host: 127.0.0.1\n');
  writePayloadCategory(doc, 'override-raw', [
    { models: [{ name: 'gpt-4o' }], params: { temperature: '0.7' } },
  ]);
  assert.deepEqual(readPayloadCategory(doc, 'override-raw'), [
    { models: [{ name: 'gpt-4o' }], params: { temperature: '0.7' } },
  ]);
});

test('an empty payload key takes payload rules', () => {
  const doc = parseDocument('host: 127.0.0.1\nrequests:\n  payload:\n');
  writePayloadCategory(doc, 'override-raw', [
    { models: [{ name: 'gpt-4o' }], params: { temperature: '0.7' } },
  ]);
  assert.deepEqual(readPayloadCategory(doc, 'override-raw'), [
    { models: [{ name: 'gpt-4o' }], params: { temperature: '0.7' } },
  ]);
});

test('a payload key holding something other than a map takes payload rules', () => {
  // Not a shape this console produces, but hand-edited config reaches it, and
  // refusing to write would leave the operator with no way to save at all.
  const doc = parseDocument('host: 127.0.0.1\nrequests:\n  payload: legacy-scalar\n');
  writePayloadCategory(doc, 'filter', [{ models: [{ name: 'gpt-4o' }], params: ['temperature'] }]);
  assert.ok(Array.isArray(readPayloadCategory(doc, 'filter')));
});

test('clearing the last category takes the empty payload map with it', () => {
  // Otherwise the editor writes `requests: {payload: {}}` into a document the operator never
  // configured, and the next save pushes that noise upstream.
  const doc = parseDocument('host: 127.0.0.1\n');
  writePayloadCategory(doc, 'override-raw', [{ models: [{ name: 'gpt-4o' }], params: {} }]);
  assert.equal(doc.hasIn(['requests', 'payload']), true);
  writePayloadCategory(doc, 'override-raw', []);
  assert.equal(doc.has('requests'), false);
  assert.equal(doc.toString(), 'host: 127.0.0.1\n');
});

test('clearing a category on a document with no payload is a no-op', () => {
  const doc = parseDocument('host: 127.0.0.1\n');
  writePayloadCategory(doc, 'override-raw', []);
  assert.equal(doc.toString(), 'host: 127.0.0.1\n');
});

test('two categories coexist in a payload map created by the first write', () => {
  const doc = parseDocument('host: 127.0.0.1\n');
  writePayloadCategory(doc, 'default', [{ models: [{ name: 'a' }], params: {} }]);
  writePayloadCategory(doc, 'override-raw', [{ models: [{ name: 'b' }], params: {} }]);
  assert.ok(Array.isArray(readPayloadCategory(doc, 'default')));
  assert.ok(Array.isArray(readPayloadCategory(doc, 'override-raw')));
});

test('Payload Replace Rules preserve order, duplicates, empty deletions, pinned user role, and extra fields', () => {
  const original = [
    {
      models: [
        {
          name: '*',
          protocol: 'claude',
          'from-protocol': 'openai',
          headers: { 'X-Client': 'web' },
          match: [{ 'metadata.env': 'prod' }],
        },
      ],
      target: {
        role: 'user',
        positions: [2, 1],
        extra_target_flag: 'keep',
      },
      replacements: [
        { 'you are hero': 'you are fool' },
        { 'remove this phrase': '' },
        { 'you are hero': 'override again' },
        { ' spaced ': ' kept ' },
      ],
      extra_rule_flag: 42,
    },
    {
      models: [{ name: 'muse-*', protocol: 'meta' }],
      target: {
        role: 'user',
        all: true,
      },
      replacements: [JSON.parse('{"__proto__":"safe"}') as Record<string, unknown>],
    },
  ];

  const parsed = parseReplaceRules(original, 'replace');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].models[0].protocol, 'claude');
  assert.equal(parsed[0].models[0].fromProtocol, 'openai');
  assert.deepEqual(parsed[0].target.positions, [2, 1]);
  assert.equal(parsed[0].target.all, false);
  assert.equal(parsed[0].replacements.length, 4);
  assert.equal(parsed[0].replacements[1].from, 'remove this phrase');
  assert.equal(parsed[0].replacements[1].to, '');

  assert.equal(parsed[1].models[0].protocol, 'meta');
  assert.equal(parsed[1].target.all, true);
  assert.deepEqual(parsed[1].target.positions, []);

  const serialized = serializeReplaceRules(parsed);
  assert.equal((serialized[0] as Record<string, unknown>).extra_rule_flag, 42);
  assert.deepEqual((serialized[0] as Record<string, unknown>).target, {
    extra_target_flag: 'keep',
    role: 'user',
    positions: [2, 1],
  });
  assert.deepEqual((serialized[0] as Record<string, unknown>).replacements, [
    { 'you are hero': 'you are fool' },
    { 'remove this phrase': '' },
    { 'you are hero': 'override again' },
    { ' spaced ': ' kept ' },
  ]);
  assert.deepEqual((serialized[1] as Record<string, unknown>).target, {
    role: 'user',
    all: true,
  });
  const protoReplacement = ((serialized[1] as Record<string, unknown>).replacements as Record<string, string>[])[0];
  assert.equal(Object.prototype.hasOwnProperty.call(protoReplacement, '__proto__'), true);
  assert.equal(protoReplacement['__proto__'], 'safe');

  // Empty destination "" is emitted verbatim in YAML and survives readback.
  const doc = parseDocument('host: 127.0.0.1\n');
  writePayloadCategory(doc, 'replace', serialized);
  const yamlText = doc.toString();
  assert.ok(yamlText.includes('remove this phrase: ""'), `expected verbatim empty string in YAML:\n${yamlText}`);
  const roundTripped = parseReplaceRules(readPayloadCategory(parseDocument(yamlText), 'replace'), 'replace');
  assert.equal(roundTripped[0].replacements[1].to, '');
  assert.deepEqual(roundTripped[0].target.positions, [2, 1]);
});

test('validateAllPayloadRules validates replace target mutual exclusivity, positions >= 1, and replacement pairs', () => {
  // Valid positions-targeted rule with duplicate source keys and empty deletion destination: 0 issues.
  const validPosRule = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', positions: [1, 2] },
      replacements: [{ a: 'b' }, { a: '' }],
    },
  ]);
  assert.deepEqual(validateAllPayloadRules([], [], [], [], [], validPosRule), []);

  // Valid all-targeted rule: 0 issues.
  const validAllRule = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', all: true },
      replacements: [{ a: '' }],
    },
  ]);
  assert.deepEqual(validateAllPayloadRules([], [], [], [], [], validAllRule), []);

  // Both all and positions set -> conflict.
  const conflictRule = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', all: true, positions: [1] },
      replacements: [{ a: 'b' }],
    },
  ]);
  const conflictIssues = validateAllPayloadRules([], [], [], [], [], conflictRule);
  assert.equal(conflictIssues.length, 1);
  assert.equal(conflictIssues[0].category, 'replace');
  assert.equal(conflictIssues[0].field, 'target');
  assert.equal(conflictIssues[0].messageKey, 'cfg.payload_replace_target_conflict');

  // Neither all nor positions -> required.
  const emptyTargetRule = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', positions: [] },
      replacements: [{ a: 'b' }],
    },
  ]);
  assert.equal(
    validateAllPayloadRules([], [], [], [], [], emptyTargetRule)[0]?.messageKey,
    'cfg.payload_replace_positions_required',
  );

  // Non-positive, fractional, or non-numeric positions -> invalid.
  for (const badPositions of [[0], [-1], [1.5], ['abc']]) {
    const badPosRule = parseReplaceRules([
      {
        models: [{ name: '*' }],
        target: { role: 'user', positions: badPositions },
        replacements: [{ a: 'b' }],
      },
    ]);
    assert.equal(
      validateAllPayloadRules([], [], [], [], [], badPosRule)[0]?.messageKey,
      'cfg.payload_replace_positions_invalid',
    );
  }

  // Missing models, blank model name, empty replacements, empty source, multi-key or non-string replacement entries.
  const missingParts = parseReplaceRules([
    {
      models: [],
      target: { role: 'user', all: true },
      replacements: [],
    },
  ]);
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], missingParts).map((i) => i.messageKey),
    ['cfg.payload_rule_need_model', 'cfg.payload_replace_need_replacement'],
  );

  const badEntries = parseReplaceRules([
    {
      models: [{ name: '   ' }],
      target: { role: 'user', all: true },
      replacements: [{ '': 'x' }, { a: '1', b: '2' }, { c: null }],
    },
  ]);
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], badEntries).map((i) => i.messageKey),
    [
      'cfg.payload_model_name_empty',
      'cfg.payload_replace_source_empty',
      'cfg.payload_replace_entry_invalid',
      'cfg.payload_replace_dest_invalid',
    ],
  );

  // Non-empty whitespace-only literal sources (`" "`, `"\t"`) are valid in CPA v8.0.75.
  const whitespaceSourceRule = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', all: true },
      replacements: [{ ' ': '' }, { '\t': '_' }],
    },
  ]);
  assert.deepEqual(validateAllPayloadRules([], [], [], [], [], whitespaceSourceRule), []);
});

test('reconcileReplaceRules preserves rule identity when concurrent baseline changes shift indices', () => {
  const previous = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', positions: [1] },
      replacements: [{ hero: 'fool' }],
    },
  ]);
  previous[0].id = 'custom_rule_id';

  const incoming = parseReplaceRules([
    {
      models: [{ name: 'claude-*' }],
      target: { role: 'user', all: true },
      replacements: [{ a: 'b' }],
    },
    {
      models: [{ name: '*' }],
      target: { role: 'user', positions: [1] },
      replacements: [{ hero: 'fool' }],
    },
  ]);

  const reconciled = reconcileReplaceRules(incoming, previous);
  assert.equal(reconciled.length, 2);
  assert.equal(reconciled[1].id, 'custom_rule_id');
  assert.notEqual(reconciled[0].id, reconciled[1].id);

  // Replacing a rule with a different rule that shares the same `models: [*]` list must NOT reuse
  // the removed rule's ID, so pending position text cannot transplant onto the replacement rule.
  const prevSameModels = parseReplaceRules([
    { models: [{ name: '*' }], target: { role: 'user', positions: [1] }, replacements: [{ A: 'B' }] },
  ]);
  const nextSameModels = parseReplaceRules([
    { models: [{ name: '*' }], target: { role: 'user', positions: [5] }, replacements: [{ X: 'Y' }] },
  ]);
  const reconciledSameModels = reconcileReplaceRules(nextSameModels, prevSameModels);
  assert.notEqual(reconciledSameModels[0].id, prevSameModels[0].id);
  assert.notEqual(reconciledSameModels[0].models[0].id, prevSameModels[0].models[0].id);
  assert.notEqual(reconciledSameModels[0].replacements[0].id, prevSameModels[0].replacements[0].id);

  // Ambiguous duplicate models lists remain isolated from removed rules too.
  const prevAmbiguous = parseReplaceRules([
    { models: [{ name: '*' }], target: { role: 'user', positions: [1] }, replacements: [{ a: '1' }] },
  ]);
  const nextAmbiguous = parseReplaceRules([
    { models: [{ name: '*' }], target: { role: 'user', all: true }, replacements: [{ c: '3' }] },
    { models: [{ name: '*' }], target: { role: 'user', positions: [1] }, replacements: [{ a: 'updated' }] },
  ]);
  const reconciledAmbiguous = reconcileReplaceRules(nextAmbiguous, prevAmbiguous);
  assert.notEqual(reconciledAmbiguous[0].id, prevAmbiguous[0].id);
  assert.notEqual(reconciledAmbiguous[1].id, prevAmbiguous[0].id);

  // Map key order (e.g. headers) is order-independent, while replacement array order remains significant.
  const prevHeaderOrder = parseReplaceRules([
    {
      models: [{ name: '*', headers: { A: '1', B: '2' } }],
      target: { role: 'user', positions: [1] },
      replacements: [{ first: 'one' }, { second: 'two' }],
    },
  ]);
  prevHeaderOrder[0].id = 'header_order_rule';
  const nextReorderedHeaders = parseReplaceRules([
    {
      models: [{ name: '*', headers: { B: '2', A: '1' } }],
      target: { role: 'user', positions: [1] },
      replacements: [{ first: 'one' }, { second: 'two' }],
    },
  ]);
  assert.equal(reconcileReplaceRules(nextReorderedHeaders, prevHeaderOrder)[0].id, 'header_order_rule');

  const nextReorderedReplacements = parseReplaceRules([
    {
      models: [{ name: '*', headers: { B: '2', A: '1' } }],
      target: { role: 'user', positions: [1] },
      replacements: [{ second: 'two' }, { first: 'one' }],
    },
  ]);
  assert.notEqual(reconcileReplaceRules(nextReorderedReplacements, prevHeaderOrder)[0].id, 'header_order_rule');
});

test('serializeReplaceRules and appendReplacePositionTokens preserve invalid position tokens in serialized drafts', () => {
  const initial = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', positions: [1] },
      replacements: [{ hello: 'world' }],
    },
  ]);

  const parsed = appendReplacePositionTokens('bad, 2', initial[0].target.positions, initial[0].target.invalidPositions);
  assert.equal(parsed.changed, true);
  assert.deepEqual(parsed.positions, [1, 2]);
  assert.deepEqual(parsed.invalidPositions, ['bad']);

  initial[0].target.positions = [1];
  initial[0].target.invalidPositions = ['bad'];

  const serialized = serializeReplaceRules(initial);
  assert.deepEqual((serialized[0] as Record<string, unknown>).target, {
    role: 'user',
    positions: [1, 'bad'],
  });
  const reparsed = parseReplaceRules(serialized);
  assert.deepEqual(reparsed[0].target.positions, [1]);
  assert.deepEqual(reparsed[0].target.invalidPositions, ['bad']);
});

test('replace target preserves unsupported or missing YAML roles instead of silently retargeting to user', () => {
  const parsedAssistant = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'assistant', positions: [1] },
      replacements: [{ old: 'new' }],
    },
  ]);
  assert.deepEqual(parsedAssistant[0].target.invalidRole, { present: true, value: 'assistant' });
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], parsedAssistant).map((i) => i.messageKey),
    ['cfg.payload_replace_role_invalid'],
  );

  // Editing an unrelated field (replacement destination) preserves role: assistant rather than rewriting to user.
  parsedAssistant[0].replacements[0].to = 'edited';
  assert.deepEqual((serializeReplaceRules(parsedAssistant)[0] as Record<string, unknown>).target, {
    role: 'assistant',
    positions: [1],
  });

  // Missing target.role is also flagged and never invented on serialization.
  const parsedMissingRole = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { positions: [1] },
      replacements: [{ old: 'new' }],
    },
  ]);
  assert.deepEqual(parsedMissingRole[0].target.invalidRole, { present: false });
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], parsedMissingRole).map((i) => i.messageKey),
    ['cfg.payload_replace_role_invalid'],
  );
  assert.deepEqual((serializeReplaceRules(parsedMissingRole)[0] as Record<string, unknown>).target, {
    positions: [1],
  });

  // Non-object target preserves raw value and fails validation.
  const parsedScalarTarget = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: 'assistant',
      replacements: [{ old: 'new' }],
    },
  ]);
  assert.equal((serializeReplaceRules(parsedScalarTarget)[0] as Record<string, unknown>).target, 'assistant');
  assert.equal(
    validateAllPayloadRules([], [], [], [], [], parsedScalarTarget).some((i) => i.messageKey === 'cfg.payload_replace_role_invalid'),
    true,
  );

  // validatePayloadDocument inspects the YAML document and unresolved pending entries directly.
  const invalidDoc = parseDocument(`requests:
  payload:
    replace:
      - models: [{ name: "*" }]
        target: { role: assistant, positions: [1] }
        replacements: [{ a: b }]
`);
  assert.deepEqual(
    validatePayloadDocument(invalidDoc, [{ id: 'u1', ruleNumber: 1, text: '2' }]).map((i) => i.messageKey),
    ['cfg.payload_replace_role_invalid', 'cfg.payload_replace_pending_unresolved'],
  );

  // Scalar, null, and array malformed replacement entries keep their original raw values until edited.
  const malformedEntries = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', all: true },
      replacements: [42, null, ['x'], { a: 'b' }],
    },
  ]);
  malformedEntries[0].replacements[3].to = 'edited';
  assert.deepEqual((serializeReplaceRules(malformedEntries)[0] as Record<string, unknown>).replacements, [
    42,
    null,
    ['x'],
    { a: 'edited' },
  ]);
  malformedEntries[0].replacements[0] = {
    id: malformedEntries[0].replacements[0].id,
    from: 'fixed',
    to: 'ok',
  };
  assert.deepEqual((serializeReplaceRules(malformedEntries)[0] as Record<string, unknown>).replacements, [
    { fixed: 'ok' },
    null,
    ['x'],
    { a: 'edited' },
  ]);
});
