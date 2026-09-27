/**
 * The Agent workspace's presentation rules, asserted without a browser.
 *
 * These are the decisions that are wrong silently: a stopped run labelled as a failure, an
 * unknown status rendered as a dictionary key, a result digest that drops the fields an
 * operator needs, or a failure sentence that is actually the machine code. The browser probes
 * prove the page renders; this suite proves the rules the page renders by.
 */
import assert from 'node:assert/strict';
import {
  failureKey,
  pendingOperationCount,
  formatDuration,
  groupCapabilities,
  hasRawResult,
  appendStreamPart,
  appendToolPart,
  parseAgentTarget,
  segmentParts,
  turnParts,
  parseRunEvent,
  previewEntries,
  rawResultText,
  statusTone,
  summarizeResult,
  traceChainStatus,
  turnDuration,
  turnLabelKey,
} from '../web/src/pages/agent/state.ts';
import type { Capability, Trace, Turn } from '../web/src/pages/agent/state.ts';

let passed = 0;
function check(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const capability = (name: string, permission: string, description = ''): Capability => ({ name, permission, description, risk: 'low', version: 1 });
const turn = (fields: Partial<Turn>): Turn => ({ id: 'turn', user: '', reply: '', status: 'success', traces: [], ...fields });

check('a stopped run reads as stopped, not as a failure', () => {
  assert.equal(turnLabelKey({ status: 'error', code: 'cancelled' }), 'agent.status.stopped');
  assert.equal(turnLabelKey({ status: 'error' }), 'agent.status.error');
});

check('a status this build does not know reads as unknown rather than as a key', () => {
  assert.equal(turnLabelKey({ status: 'teleported' }), 'agent.status.unknown');
  assert.equal(turnLabelKey({ status: 'pending' }), 'agent.status.pending');
});

check('a tone is semantic, and a stop is neutral', () => {
  assert.equal(statusTone('success'), 'success');
  assert.equal(statusTone('pending'), 'warning');
  assert.equal(statusTone('uncertain'), 'warning');
  assert.equal(statusTone('error', 'cancelled'), 'default');
  assert.equal(statusTone('error'), 'error');
});

check('an unverified write is reported as uncertain, not as a plain failure', () => {
  assert.equal(failureKey('operation_outcome_unknown'), 'agent.error.uncertain');
  assert.equal(failureKey('agent_busy'), 'agent.error.busy');
  assert.equal(failureKey('something_new_from_a_newer_server'), 'agent.error.gateway');
});

check('a duration is one number and one unit', () => {
  assert.equal(formatDuration(420), '420ms');
  assert.equal(formatDuration(4200), '4.2s');
  assert.equal(formatDuration(72_000), '1m 12s');
  assert.equal(formatDuration(Number.NaN), '-');
});

check('a stored turn reports its own elapsed time and nothing while it runs', () => {
  assert.equal(turnDuration(turn({ started_at_ms: 1000, ended_at_ms: 5200 })), 4200);
  assert.equal(turnDuration(turn({ started_at_ms: 1000 })), undefined);
});

check('a result digest keeps the scalars and counts the collections', () => {
  const { fields, counts } = summarizeResult({ model: 'gpt-x', total_tokens: 1200, requests: [1, 2, 3], nested: { a: 1 } });
  assert.deepEqual(fields, [{ label: 'model', value: 'gpt-x' }, { label: 'total_tokens', value: '1200' }]);
  assert.deepEqual(counts, [{ label: 'requests', value: '×3' }]);
});

check('a long field is clipped so it cannot push the rest out of the digest', () => {
  const { fields } = summarizeResult({ target: 'x'.repeat(400) });
  assert.equal(fields.length, 1);
  assert.ok(fields[0].value.length <= 121, fields[0].value);
});

check('the digest is bounded in count', () => {
  const wide: Record<string, number> = {};
  for (let index = 0; index < 40; index += 1) wide[`field_${index}`] = index;
  assert.equal(summarizeResult(wide).fields.length, 6);
});

check('a scalar result has nothing to expand', () => {
  assert.equal(hasRawResult({ status: 'success' }), false);
  assert.equal(hasRawResult({ status: 'success', data: { ok: true } }), true);
  assert.equal(hasRawResult({ status: 'error', code: 'resource_missing' }), true);
  assert.equal(rawResultText({ status: 'error', code: 'resource_missing' }), '"resource_missing"');
});

check('the directory groups read before write before destructive', () => {
  const groups = groupCapabilities([
    capability('zz_destroy', 'destructive'),
    capability('aa_read', 'read'),
    capability('mm_write', 'write'),
  ], '');
  assert.deepEqual(groups.map(group => group.permission), ['read', 'write', 'destructive']);
});

check('the directory sorts within a group so the list is stable between loads', () => {
  const groups = groupCapabilities([capability('zz_read', 'read'), capability('aa_read', 'read')], '');
  assert.deepEqual(groups[0].items.map(item => item.name), ['aa_read', 'zz_read']);
});

check('a directory query matches names and descriptions', () => {
  const items = [capability('providers_list', 'read', 'List providers'), capability('keys_list', 'read', 'List keys')];
  assert.deepEqual(groupCapabilities(items, 'PROVIDERS').map(group => group.items.length), [1]);
  assert.deepEqual(groupCapabilities(items, 'list providers').map(group => group.items.length), [1]);
  assert.deepEqual(groupCapabilities(items, 'nothing').length, 0);
});

check('a stream frame this build cannot render is refused rather than dispatched', () => {
  assert.equal(parseRunEvent(JSON.stringify({ type: 'delta', content: 'a' }))?.content, 'a');
  assert.equal(parseRunEvent(JSON.stringify({ type: 'telemetry' })), undefined);
  assert.equal(parseRunEvent('not json'), undefined);
  assert.equal(parseRunEvent(JSON.stringify([1, 2])), undefined);
});

check('the count of operations waiting on a decision spans the whole conversation', () => {
  const turns = [
    turn({ id: 'a', traces: [{ id: 't1', name: 'providers_set_status', result: { status: 'pending', operation_id: 'op-1' } }] }),
    turn({ id: 'b', traces: [{ id: 't2', name: 'providers_list', result: { status: 'success', data: {} } }] }),
    turn({ id: 'c', traces: [{ id: 't3', name: 'keys_create', result: { status: 'pending', operation_id: 'op-2' } }] }),
  ];
  assert.equal(pendingOperationCount(turns), 2);
  assert.equal(pendingOperationCount([]), 0);
});

check('a trace carries its capability name for the transcript to name', () => {
  const trace: Trace = { id: 't', name: 'providers_list', result: { status: 'success', data: { providers: [] } } };
  assert.equal(trace.name, 'providers_list');
  assert.equal(summarizeResult(trace.result.data).counts[0].value, '×0');
});

check('a call waiting on the operator is never drawn as loading or failed', () => {
  assert.equal(traceChainStatus('success'), 'success');
  assert.equal(traceChainStatus('executing'), 'loading');
  assert.equal(traceChainStatus('error'), 'error');
  assert.equal(traceChainStatus('rejected'), 'abort');
  for (const status of ['pending', 'partial', 'uncertain', 'expired', 'something-new']) {
    assert.equal(traceChainStatus(status), undefined, status);
  }
});

check('a prepared change is laid out as fields only when it is shaped like a form', () => {
  assert.deepEqual(previewEntries({ provider: 'p1', enabled: false, removes: ['credentials', 'mappings'] }), [
    ['provider', 'p1'], ['enabled', 'false'], ['removes', 'credentials, mappings'],
  ]);
  assert.equal(previewEntries({ nested: { a: 1 } }), undefined);
  assert.equal(previewEntries({ list: [{ a: 1 }] }), undefined);
  assert.equal(previewEntries([1, 2]), undefined);
  assert.equal(previewEntries({}), undefined);
  assert.equal(previewEntries(undefined), undefined);
});

check('streamed reasoning is a frame this build renders', () => {
  assert.equal(parseRunEvent(JSON.stringify({ type: 'thought', content: 'weigh' }))?.content, 'weigh');
});

check('the remembered selector keeps only its three fields, trimmed', () => {
  assert.deepEqual(parseAgentTarget({ client_key_fingerprint: ' hmac:k ', model: 'm', reasoning_effort: 'high', key: 'sk-secret' }), {
    client_key_fingerprint: 'hmac:k', model: 'm', reasoning_effort: 'high',
  });
  assert.deepEqual(parseAgentTarget({ model: '  ', reasoning_effort: 3 }), {});
  assert.equal(parseAgentTarget(null), undefined);
  assert.equal(parseAgentTarget(['m']), undefined);
});

check('streamed output is rebuilt into parts the way the server records them', () => {
  let parts = appendStreamPart([], 'thought', 'plan ', true);
  parts = appendStreamPart(parts, 'thought', 'one', false);
  parts = appendStreamPart(parts, 'text', 'checking', false);
  parts = appendToolPart(parts, 'call-1');
  parts = appendToolPart(parts, 'call-2');
  parts = appendToolPart(parts, 'call-1');
  parts = appendStreamPart(parts, 'text', 'answer', true);
  assert.deepEqual(parts, [
    { type: 'thought', content: 'plan one' },
    { type: 'text', content: 'checking' },
    { type: 'tool', trace_id: 'call-1' },
    { type: 'tool', trace_id: 'call-2' },
    { type: 'text', content: 'answer' },
  ]);
  // Text from a new model call is a new part even when the previous part was text as well.
  assert.equal(appendStreamPart([{ type: 'text', content: 'a' }], 'text', 'b', true).length, 2);
});

check('the transcript draws a turn in the order it happened, with calls made together as one chain', () => {
  const segments = segmentParts([
    { type: 'thought', content: 'plan' },
    { type: 'text', content: 'checking' },
    { type: 'tool', trace_id: 'a' },
    { type: 'tool', trace_id: 'b' },
    { type: 'thought', content: 'again' },
    { type: 'text', content: '' },
    { type: 'text', content: 'answer' },
  ]);
  assert.deepEqual(segments.map(segment => segment.kind), ['thought', 'text', 'tools', 'thought', 'text']);
  assert.deepEqual(segments[2].kind === 'tools' ? segments[2].traceIDs : [], ['a', 'b']);
});

check('a turn stored without parts reads as its calls followed by its answer', () => {
  const stored = turn({ reply: 'done', traces: [{ id: 't1', name: 'providers_list', result: { status: 'success' } }] });
  assert.deepEqual(turnParts(stored), [{ type: 'tool', trace_id: 't1' }, { type: 'text', content: 'done' }]);
  const ordered = turn({ reply: 'x', parts: [{ type: 'text', content: 'x' }] });
  assert.deepEqual(turnParts(ordered), [{ type: 'text', content: 'x' }]);
});

console.log(`\n${passed} assertions passed`);
