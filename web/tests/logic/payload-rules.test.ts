import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseDocument } from 'yaml';
import {
  PAYLOAD_PROTOCOLS,
  PAYLOAD_REPLACE_ROLES,
  buildPayloadProtocolOptions,
  buildPayloadReplaceRoleOptions,
  isBlockingPayloadIssue,
  parseTypedRules,
  serializeTypedRules,
  parseRawRules,
  serializeRawRules,
  parseFilterRules,
  serializeFilterRules,
  parseReplaceRules,
  serializeReplaceRules,
  appendReplacePositionTokens,
  extractReplaceInactiveTargets,
  hydrateReplaceInactiveTargets,
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

  // Editing an unrelated field (replacement destination) preserves role: assistant rather than silently rewriting to user.
  assert.equal(parsedAssistant[0].replacements[0].kind, 'literal');
  if (parsedAssistant[0].replacements[0].kind === 'literal') {
    parsedAssistant[0].replacements[0].to = 'edited';
  }
  const serializedAssistant = serializeReplaceRules(parsedAssistant)[0] as Record<string, unknown>;
  assert.deepEqual(serializedAssistant.target, {
    role: 'assistant',
    positions: [1],
  });
  assert.deepEqual(serializedAssistant.replacements, [{ old: 'edited' }]);

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
  if (malformedEntries[0].replacements[3].kind === 'literal') {
    malformedEntries[0].replacements[3].to = 'edited';
  }
  assert.deepEqual((serializeReplaceRules(malformedEntries)[0] as Record<string, unknown>).replacements, [
    42,
    null,
    ['x'],
    { a: 'edited' },
  ]);
  // Malformed replacement entry with non-string null destination keeps raw value until edited.
  malformedEntries[0].replacements[0] = {
    id: malformedEntries[0].replacements[0].id,
    kind: 'literal',
    from: 'fixed',
    to: 'ok',
  };
  assert.deepEqual((serializeReplaceRules(malformedEntries)[0] as Record<string, unknown>).replacements, [
    { fixed: 'ok' },
    null,
    ['x'],
    { a: 'edited' },
  ]);

  // Malformed target.all (`"true"`) and non-array `replacements` (`{ old: "new" }`) remain intact across edits
  // and flag target/shape validation errors until explicitly corrected.
  const malformedAllAndMap = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', all: 'true', positions: [1] },
      replacements: { old: 'new' },
    },
    {
      models: [{ name: 'claude-*' }],
      target: { role: 'user', all: true },
      replacements: [{ foo: 'bar' }],
    },
  ]);
  assert.deepEqual(malformedAllAndMap[0].target.invalidAll, { value: 'true' });
  assert.deepEqual(malformedAllAndMap[0].invalidReplacements, { value: { old: 'new' } });
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], malformedAllAndMap).map((i) => i.messageKey),
    ['cfg.payload_replace_all_invalid', 'cfg.payload_replace_list_invalid'],
  );

  // Editing another rule leaves rule 0's malformed `all` and mapping `replacements` verbatim.
  if (malformedAllAndMap[1].replacements[0].kind === 'literal') {
    malformedAllAndMap[1].replacements[0].to = 'baz';
  }
  const serializedMalformed = serializeReplaceRules(malformedAllAndMap);
  assert.deepEqual((serializedMalformed[0] as Record<string, unknown>).target, {
    role: 'user',
    all: 'true',
    positions: [1],
  });
  assert.deepEqual((serializedMalformed[0] as Record<string, unknown>).replacements, { old: 'new' });
  assert.deepEqual((serializedMalformed[1] as Record<string, unknown>).replacements, [{ foo: 'baz' }]);
});

test('PAYLOAD_REPLACE_ROLES drives role options, system/developer targets, and path targets', () => {
  assert.deepEqual(PAYLOAD_REPLACE_ROLES, ['system', 'developer', 'user']);
  assert.deepEqual(
    buildPayloadReplaceRoleOptions({ system: 'System', developer: 'Developer', user: 'User' }),
    [
      { value: 'system', label: 'System' },
      { value: 'developer', label: 'Developer' },
      { value: 'user', label: 'User' },
    ],
  );

  const original = [
    {
      models: [{ name: 'claude-*', protocol: 'claude' }],
      target: { role: 'system', all: true, custom_target_flag: 'keep' },
      replacements: [{ 'old system': 'new system' }],
    },
    {
      models: [{ name: 'gpt-5*', protocol: 'codex' }],
      target: { role: 'developer', positions: [1, 3] },
      replacements: [{ pattern: 'foo-(\\d+)', replacement: 'bar-${1}' }],
    },
    {
      models: [{ name: '*', protocol: 'openai' }],
      target: { paths: ['system', 'messages.0.content'], extra_path_flag: true },
      replacements: [
        { pattern: '(?i)legacy', replacement: '' },
        { pattern: 'literal-key-word' }, // Wait: 1-key literal where the literal source happens to be "pattern"
      ].slice(0, 1).concat([{ pattern: 'literal-value' }]),
    },
  ];

  const parsed = parseReplaceRules(original, 'replace');
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].target.mode, 'role');
  if (parsed[0].target.mode === 'role') {
    assert.equal(parsed[0].target.role, 'system');
    assert.equal(parsed[0].target.all, true);
    assert.equal(parsed[0].target.invalidRole, undefined);
  }
  assert.equal(parsed[1].target.mode, 'role');
  if (parsed[1].target.mode === 'role') {
    assert.equal(parsed[1].target.role, 'developer');
    assert.deepEqual(parsed[1].target.positions, [1, 3]);
    assert.equal(parsed[1].target.invalidRole, undefined);
  }
  assert.deepEqual(parsed[1].replacements[0], {
    id: 'replace_r1_rep0',
    kind: 'regex',
    pattern: 'foo-(\\d+)',
    replacement: 'bar-${1}',
  });

  assert.equal(parsed[2].target.mode, 'paths');
  if (parsed[2].target.mode === 'paths') {
    assert.deepEqual(
      parsed[2].target.paths.map((item) => item.path),
      ['system', 'messages.0.content'],
    );
  }
  // A 1-key entry named `pattern` without `replacement` remains a 1-key literal mapping.
  assert.equal(parsed[2].replacements[1].kind, 'literal');
  if (parsed[2].replacements[1].kind === 'literal') {
    assert.equal(parsed[2].replacements[1].from, 'pattern');
    assert.equal(parsed[2].replacements[1].to, 'literal-value');
  }

  assert.deepEqual(validateAllPayloadRules([], [], [], [], [], parsed), []);

  const serialized = serializeReplaceRules(parsed);
  assert.deepEqual(serialized[0].target, { custom_target_flag: 'keep', role: 'system', all: true });
  assert.deepEqual(serialized[1].target, { role: 'developer', positions: [1, 3] });
  assert.deepEqual(serialized[1].replacements, [{ pattern: 'foo-(\\d+)', replacement: 'bar-${1}' }]);
  assert.deepEqual(serialized[2].target, { extra_path_flag: true, paths: ['system', 'messages.0.content'] });
  assert.equal(Object.prototype.hasOwnProperty.call(serialized[2].target as object, 'role'), false);
  assert.deepEqual(serialized[2].replacements, [
    { pattern: '(?i)legacy', replacement: '' },
    { pattern: 'literal-value' },
  ]);

  // Empty paths target preserves `paths: []` so paths mode survives reparsing, emits no `role`, and fails validation.
  const emptyPathsRule = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { paths: [] },
      replacements: [{ a: 'b' }],
    },
  ]);
  assert.equal(emptyPathsRule[0].target.mode, 'paths');
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], emptyPathsRule).map((i) => i.messageKey),
    ['cfg.payload_replace_paths_required'],
  );
  const serializedEmptyPaths = serializeReplaceRules(emptyPathsRule);
  assert.deepEqual(serializedEmptyPaths[0].target, { paths: [] });
  assert.equal(parseReplaceRules(serializedEmptyPaths)[0].target.mode, 'paths');

  // Blank path rows are retained in draft serialization so Add Path rows survive baseline sync,
  // while validation blocks saving until filled or removed.
  const blankPathRule = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { paths: ['   '] },
      replacements: [{ a: 'b' }],
    },
  ]);
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], blankPathRule).map((i) => i.messageKey),
    ['cfg.payload_replace_path_empty'],
  );
  assert.deepEqual(serializeReplaceRules(blankPathRule)[0].target, { paths: ['   '] });

  // Blank-path validation also matches Go strings.TrimSpace on U+0085 (NEL) without altering stored path text.
  const nelPathRule = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { paths: ['\u0085'] },
      replacements: [{ a: 'b' }],
    },
  ]);
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], nelPathRule).map((i) => i.messageKey),
    ['cfg.payload_replace_path_empty'],
  );
  assert.deepEqual(serializeReplaceRules(nelPathRule)[0].target, { paths: ['\u0085'] });

  // Neutral inactive role fields (`role: ''` / `null`, `all: false` / `null`, `positions: []` / `null`) alongside `paths` are valid in CPA v8.0.77 and round-trip.
  const neutralConflictTarget = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { paths: ['messages.0.content'], role: '', all: false, positions: [] },
      replacements: [{ a: 'b' }],
    },
    {
      models: [{ name: '*' }],
      target: { paths: ['messages.0.content'], positions: null },
      replacements: [{ a: 'b' }],
    },
    {
      models: [{ name: '*' }],
      target: { paths: ['system'], role: null, all: null },
      replacements: [{ a: 'b' }],
    },
  ]);
  assert.deepEqual(validateAllPayloadRules([], [], [], [], [], neutralConflictTarget), []);
  assert.deepEqual(serializeReplaceRules(neutralConflictTarget)[0].target, {
    paths: ['messages.0.content'],
    role: '',
    all: false,
    positions: [],
  });
  assert.deepEqual(serializeReplaceRules(neutralConflictTarget)[1].target, {
    paths: ['messages.0.content'],
    positions: null,
  });
  assert.deepEqual(serializeReplaceRules(neutralConflictTarget)[2].target, {
    paths: ['system'],
    role: null,
    all: null,
  });

  // `paths: null` on a role target is treated as unset (CPA decodes nil slice) and stays in role mode.
  const nullPathsRoleTarget = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', all: true, paths: null },
      replacements: [{ old: 'new' }],
    },
  ]);
  assert.equal(nullPathsRoleTarget[0].target.mode, 'role');
  assert.deepEqual(validateAllPayloadRules([], [], [], [], [], nullPathsRoleTarget), []);
  if (nullPathsRoleTarget[0].replacements[0].kind === 'literal') {
    nullPathsRoleTarget[0].replacements[0].to = 'updated';
  }
  const serializedNullPaths = serializeReplaceRules(nullPathsRoleTarget)[0];
  assert.deepEqual(serializedNullPaths.target, {
    role: 'user',
    all: true,
    paths: null,
  });
  assert.deepEqual(serializedNullPaths.replacements, [{ old: 'updated' }]);

  // Whitespace-only role alongside `paths` remains a conflict so it is flagged and repairable.
  const whitespaceRoleConflict = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { paths: ['prompt'], role: ' ' },
      replacements: [{ a: 'b' }],
    },
  ]);
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], whitespaceRoleConflict).map((i) => i.messageKey),
    ['cfg.payload_replace_paths_conflict'],
  );

  // Exact match reconciliation carries over draft-only inactive targets across server refreshes.
  const prevWithInactive = parseReplaceRules([
    { models: [{ name: '*' }], target: { paths: ['system'] }, replacements: [{ a: 'b' }] },
  ]);
  if (prevWithInactive[0].target.mode === 'paths') {
    prevWithInactive[0].target._savedRoleTarget = { mode: 'role', role: 'system', positions: [2], all: false };
  }
  const incomingSame = parseReplaceRules([
    { models: [{ name: '*' }], target: { paths: ['system'] }, replacements: [{ a: 'b' }] },
  ]);
  const reconciledWithInactive = reconcileReplaceRules(incomingSame, prevWithInactive);
  assert.equal(reconciledWithInactive[0].target.mode, 'paths');
  if (reconciledWithInactive[0].target.mode === 'paths') {
    assert.deepEqual(reconciledWithInactive[0].target._savedRoleTarget, {
      mode: 'role',
      role: 'system',
      positions: [2],
      all: false,
    });
  }

  // Duplicate active-path rules must not copy or hydrate ambiguous inactive role targets after one is deleted.
  const duplicatePrevWithInactive = parseReplaceRules([
    { models: [{ name: '*' }], target: { paths: ['system'] }, replacements: [{ a: 'b' }] },
    { models: [{ name: '*' }], target: { paths: ['system'] }, replacements: [{ a: 'b' }] },
  ]);
  if (duplicatePrevWithInactive[0].target.mode === 'paths') {
    duplicatePrevWithInactive[0].target._savedRoleTarget = { mode: 'role', role: 'user', positions: [1], all: false };
  }
  if (duplicatePrevWithInactive[1].target.mode === 'paths') {
    duplicatePrevWithInactive[1].target._savedRoleTarget = { mode: 'role', role: 'user', positions: [2], all: false };
  }
  const survivingSingle = parseReplaceRules([
    { models: [{ name: '*' }], target: { paths: ['system'] }, replacements: [{ a: 'b' }] },
  ]);
  const reconciledAmbiguous = reconcileReplaceRules(survivingSingle, duplicatePrevWithInactive);
  assert.equal(reconciledAmbiguous[0].target.mode, 'paths');
  if (reconciledAmbiguous[0].target.mode === 'paths') {
    assert.equal(reconciledAmbiguous[0].target._savedRoleTarget, undefined);
  }
  const extractedDuplicates = extractReplaceInactiveTargets(duplicatePrevWithInactive);
  const hydratedAmbiguous = hydrateReplaceInactiveTargets(survivingSingle, extractedDuplicates);
  if (hydratedAmbiguous[0].target.mode === 'paths') {
    assert.equal(hydratedAmbiguous[0].target._savedRoleTarget, undefined);
  }

  // Malformed structured objects with a non-callable toString in path/pattern/replacement must not throw during parse.
  const hostileToStringRule = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { paths: [{ toString: 'not-a-function' }] },
      replacements: [
        { pattern: { toString: 'not-a-function' }, replacement: { toString: 'nope' } },
        { literalKey: { toString: 'bad' } },
      ],
    },
  ]);
  assert.equal(hostileToStringRule[0].target.mode, 'paths');
  if (hostileToStringRule[0].target.mode === 'paths') {
    assert.equal(hostileToStringRule[0].target.paths[0].path, '[object]');
    assert.deepEqual(hostileToStringRule[0].target.paths[0]._rawValue, { toString: 'not-a-function' });
  }
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], hostileToStringRule).map((i) => i.messageKey),
    [
      'cfg.payload_replace_path_invalid',
      'cfg.payload_replace_pattern_invalid_type',
      'cfg.payload_replace_dest_invalid',
    ],
  );
  assert.deepEqual(serializeReplaceRules(hostileToStringRule)[0].target, {
    paths: [{ toString: 'not-a-function' }],
  });

  // Conflicting `paths` + active `role`/`all: true`/`positions` and non-array/non-string paths preserve verbatim and flag errors.
  const conflictingTarget = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', all: true, paths: ['system', 123] },
      replacements: [{ a: 'b' }],
    },
    {
      models: [{ name: '*' }],
      target: { paths: 'system' },
      replacements: [{ a: 'b' }],
    },
  ]);
  assert.deepEqual(
    validateAllPayloadRules([], [], [], [], [], conflictingTarget).map((i) => i.messageKey),
    [
      'cfg.payload_replace_paths_conflict',
      'cfg.payload_replace_path_invalid',
      'cfg.payload_replace_paths_invalid',
    ],
  );
  const serializedConflict = serializeReplaceRules(conflictingTarget);
  assert.deepEqual(serializedConflict[0].target, { role: 'user', all: true, paths: ['system', 123] });
  assert.deepEqual(serializedConflict[1].target, { paths: 'system' });

  // reconcileReplaceRules preserves path item IDs when concurrent baseline edits shift rules.
  const prevPaths = parseReplaceRules([
    { models: [{ name: '*' }], target: { paths: ['system'] }, replacements: [{ a: 'b' }] },
  ]);
  if (prevPaths[0].target.mode === 'paths') {
    prevPaths[0].target.paths[0].id = 'custom_path_id';
  }
  const incomingPaths = parseReplaceRules([
    { models: [{ name: 'claude-*' }], target: { role: 'system', all: true }, replacements: [{ x: 'y' }] },
    { models: [{ name: '*' }], target: { paths: ['system'] }, replacements: [{ a: 'b' }] },
  ]);
  const reconciledPaths = reconcileReplaceRules(incomingPaths, prevPaths);
  assert.equal(reconciledPaths[1].target.mode, 'paths');
  if (reconciledPaths[1].target.mode === 'paths') {
    assert.equal(reconciledPaths[1].target.paths[0].id, 'custom_path_id');
  }
});

test('regex replacement validation flags empty/non-string patterns as blocking and RE2 issues as non-blocking warnings preserved verbatim', () => {
  const mixedRules = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'system', all: true },
      replacements: [
        { pattern: '(?P<tag>[a-z]+)-(\\d+)', replacement: '$tag:$2' },
        { pattern: 'foo(?=bar)', replacement: 'baz' },
        { pattern: 'trailing\\', replacement: 'x' },
        { pattern: '[unclosed', replacement: 'x' },
      ],
    },
  ]);

  const warningIssues = validateAllPayloadRules([], [], [], [], [], mixedRules);
  assert.deepEqual(
    warningIssues.map((i) => ({ key: i.messageKey, severity: i.severity })),
    [
      { key: 'cfg.payload_replace_regex_unsupported', severity: 'warning' },
      { key: 'cfg.payload_replace_regex_trailing_backslash', severity: 'warning' },
      { key: 'cfg.payload_replace_regex_syntax', severity: 'warning' },
    ],
  );
  assert.equal(warningIssues.some(isBlockingPayloadIssue), false);

  // Invalid regex patterns round-trip verbatim through serialization and Document AST writes.
  const doc = parseDocument('host: 127.0.0.1\n');
  writePayloadCategory(doc, 'replace', serializeReplaceRules(mixedRules));
  const reparsed = parseReplaceRules(readPayloadCategory(parseDocument(doc.toString()), 'replace'), 'replace');
  assert.deepEqual(
    reparsed[0].replacements.map((r) => (r.kind === 'regex' ? { pattern: r.pattern, replacement: r.replacement } : null)),
    [
      { pattern: '(?P<tag>[a-z]+)-(\\d+)', replacement: '$tag:$2' },
      { pattern: 'foo(?=bar)', replacement: 'baz' },
      { pattern: 'trailing\\', replacement: 'x' },
      { pattern: '[unclosed', replacement: 'x' },
    ],
  );

  // Empty regex pattern and non-string regex pattern/replacement remain blocking errors.
  const invalidTypeRules = parseReplaceRules([
    {
      models: [{ name: '*' }],
      target: { role: 'user', all: true },
      replacements: [
        { pattern: '', replacement: 'x' },
        { pattern: 123, replacement: 'y' },
        { pattern: 'ok', replacement: null },
      ],
    },
  ]);
  const blockingIssues = validateAllPayloadRules([], [], [], [], [], invalidTypeRules);
  assert.deepEqual(
    blockingIssues.map((i) => i.messageKey),
    [
      'cfg.payload_replace_pattern_empty',
      'cfg.payload_replace_pattern_invalid_type',
      'cfg.payload_replace_dest_invalid',
    ],
  );
  assert.equal(blockingIssues.every(isBlockingPayloadIssue), true);
  assert.deepEqual(serializeReplaceRules(invalidTypeRules)[0].replacements, [
    { pattern: '', replacement: 'x' },
    { pattern: 123, replacement: 'y' },
    { pattern: 'ok', replacement: null },
  ]);
});
