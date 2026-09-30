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
  isAwaitingAnswer,
  EMPTY_DRAFT,
  chooseOption,
  chooseOther,
  draftReply,
  isQuestionAnswered,
  operationQuestions,
  pendingOperationID,
  formatDuration,
  groupCapabilities,
  hasRawResult,
  parseAgentTarget,
  turnParts,
  previewEntries,
  rawResultText,
  statusTone,
  summarizeResult,
  turnDuration,
  turnLabelKey,
  argumentSummary,
  callStatusKey,
  callDuration,
  chartSeries,
} from '../web/src/pages/agent/state.ts';
import { completedDisplayViews } from '../web/src/agent/types.ts';
import { agentChartAxis } from '../web/src/pages/agent/tools/chartAxis.ts';
import type { Capability, Conversation, Operation, Trace, Turn } from '../web/src/pages/agent/state.ts';

import { applyAgentEvent, EMPTY_FRAME, invalidatedKeys, parseReceipt } from '../web/src/agent/runReducer.ts';
import type { RunFrame } from '../web/src/agent/runReducer.ts';
import { buildRunInput, parseAgentEvent } from '../web/src/agent/protocol.ts';
import type { AgentEvent } from '../web/src/agent/protocol.ts';
import { readSSE } from '../web/src/agent/sse.ts';
import { conversationMarkdown, csvCell, exportFileName, playgroundMarkdown, rowsToMarkdown, turnAnswerMarkdown, viewToCSV } from '../web/src/agent/export.ts';
import type { ExportLabels } from '../web/src/agent/export.ts';
import { agentThreadMessages, appendMessageText, mergeLiveTurn, storedMessages, toolCallPart, turnMessageStatus } from '../web/src/pages/agent/thread.ts';

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

check('a directory query can match the text the operator reads', () => {
  const items = [capability('providers_list', 'read', 'List providers'), capability('keys_list', 'read', 'List keys')];
  const localized: Record<string, string> = { providers_list: '列出提供方', keys_list: '列出客户端密钥' };
  const groups = groupCapabilities(items, '密钥', item => `${item.name} ${localized[item.name]}`);
  assert.deepEqual(groups.flatMap(group => group.items.map(item => item.name)), ['keys_list']);
});

check('the operation a conversation waits on is the pending call of its last turn', () => {
  const conversation = (turns: Turn[]): Conversation => ({ id: 'c', revision: 1, model: 'm', client_key_fingerprint: 'k', turns, omitted: 0 });
  const waiting = turn({ id: 'b', status: 'pending', traces: [
    { id: 't2', name: 'providers_list', result: { status: 'success', data: {} } },
    { id: 't3', name: 'keys_create', result: { status: 'pending', operation_id: 'op-2' } },
  ] });
  assert.equal(pendingOperationID(conversation([turn({ id: 'a' }), waiting])), 'op-2');
  // A finished turn is not waiting, whatever an old trace in it still says.
  assert.equal(pendingOperationID(conversation([waiting, turn({ id: 'c' })])), '');
  assert.equal(pendingOperationID(undefined), '');
});

check('a turn stopped on a question is told apart from one awaiting approval', () => {
  const asking = turn({ status: 'pending', traces: [{ id: 'q', name: 'ask_question', result: { status: 'pending', operation_id: 'op-q' } }] });
  const approving = turn({ status: 'pending', traces: [{ id: 'w', name: 'keys_create', result: { status: 'pending', operation_id: 'op-w' } }] });
  assert.equal(isAwaitingAnswer(asking), true);
  assert.equal(isAwaitingAnswer(approving), false);
  assert.equal(isAwaitingAnswer({ ...asking, status: 'success' }), false);
});

check('something else replaces a single choice and joins a multiple one', () => {
  const single = { question: 'Window?', options: [{ label: '1h' }, { label: '24h' }] };
  const multiple = { ...single, multi_select: true };
  let draft = chooseOption(EMPTY_DRAFT, single, '1h');
  draft = chooseOption(draft, single, '24h');
  assert.deepEqual(draft.selected, ['24h']);
  draft = { ...chooseOther(draft, single), text: ' later ' };
  assert.deepEqual(draftReply(draft, single), { selected: [], text: 'later' });
  // Typed text that is no longer chosen is kept for switching back, but never sent.
  assert.deepEqual(draftReply(chooseOption(draft, single, '1h'), single), { selected: ['1h'], text: '' });
  let many = chooseOption(chooseOption(EMPTY_DRAFT, multiple, '1h'), multiple, '24h');
  many = { ...chooseOther(many, multiple), text: 'both' };
  assert.deepEqual(draftReply(many, multiple), { selected: ['1h', '24h'], text: 'both' });
  assert.deepEqual(chooseOption(many, multiple, '1h').selected, ['24h']);
  assert.deepEqual(draftReply({ ...EMPTY_DRAFT, text: 'free' }, { question: 'Anything?' }), { selected: [], text: 'free' });
});

check('a question is sendable only when every question has a choice or typed text', () => {
  const operation: Operation = { id: 'op', capability: 'ask_question', status: 'pending', human_input: 'answer', result: { status: 'pending' }, preview: { target: 'Which window?', changes: { questions: [
    { question: 'Which window?', options: [{ label: '1h' }, { label: '24h' }] },
    { question: 'Anything else?' },
    { header: 'not a question' },
  ] } } };
  const questions = operationQuestions(operation);
  assert.equal(questions.length, 2);
  assert.equal(isQuestionAnswered([{ selected: ['1h'], text: '' }, { selected: [], text: '  ' }], questions.length), false);
  assert.equal(isQuestionAnswered([{ selected: ['1h'], text: '' }, { selected: [], text: 'no' }], questions.length), true);
  assert.equal(isQuestionAnswered([{ selected: ['1h'], text: '' }], questions.length), false);
  assert.deepEqual(operationQuestions({ ...operation, preview: { target: 'x', changes: { name: 'provider' } } }), []);
});

check('a trace carries its capability name for the transcript to name', () => {
  const trace: Trace = { id: 't', name: 'providers_list', result: { status: 'success', data: { providers: [] } } };
  assert.equal(trace.name, 'providers_list');
  assert.equal(summarizeResult(trace.result.data).counts[0].value, '×0');
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

check('the remembered selector keeps only its three fields, trimmed', () => {
  assert.deepEqual(parseAgentTarget({ client_key_fingerprint: ' hmac:k ', model: 'm', reasoning_effort: 'high', key: 'sk-secret' }), {
    client_key_fingerprint: 'hmac:k', model: 'm', reasoning_effort: 'high',
  });
  assert.deepEqual(parseAgentTarget({ model: '  ', reasoning_effort: 3 }), {});
  assert.equal(parseAgentTarget(null), undefined);
  assert.equal(parseAgentTarget(['m']), undefined);
});

check('a turn stored without parts reads as its calls followed by its answer', () => {
  const stored = turn({ reply: 'done', traces: [{ id: 't1', name: 'providers_list', result: { status: 'success' } }] });
  assert.deepEqual(turnParts(stored), [{ type: 'tool', trace_id: 't1' }, { type: 'text', content: 'done' }]);
  const ordered = turn({ reply: 'x', parts: [{ type: 'text', content: 'x' }] });
  assert.deepEqual(turnParts(ordered), [{ type: 'text', content: 'x' }]);
});

// ── AG-UI run protocol ─────────────────────────────────────────────────────────

const fold = (events: object[], start: RunFrame = EMPTY_FRAME): RunFrame => events.reduce<RunFrame>((frame, event) => {
  const parsed = parseAgentEvent(JSON.stringify(event));
  assert.ok(parsed, `unparsed ${JSON.stringify(event)}`);
  return applyAgentEvent(frame, parsed as AgentEvent);
}, start);

check('an event this build cannot render, or one missing what the reducer reads, is refused', () => {
  assert.equal(parseAgentEvent(JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'a' }))?.type, 'TEXT_MESSAGE_CONTENT');
  assert.equal(parseAgentEvent(JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm' })), undefined);
  assert.equal(parseAgentEvent(JSON.stringify({ type: 'TELEMETRY' })), undefined);
  assert.equal(parseAgentEvent(JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: null })), undefined);
  assert.equal(parseAgentEvent('not json'), undefined);
  assert.equal(parseAgentEvent('[1]'), undefined);
});

check('the stream is rebuilt into the parts the server stores, in order', () => {
  const frame = fold([
    { type: 'RUN_STARTED', threadId: 'c', runId: 'r', metadata: { turn_id: 't1' } },
    { type: 'STEP_STARTED', stepName: 'round:1', metadata: { round: 1 } },
    { type: 'REASONING_START', messageId: 'r:1' },
    { type: 'REASONING_MESSAGE_START', messageId: 'r:1', role: 'reasoning' },
    { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r:1', delta: 'plan ' },
    { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r:1', delta: 'one' },
    { type: 'REASONING_MESSAGE_END', messageId: 'r:1' },
    { type: 'REASONING_END', messageId: 'r:1' },
    { type: 'TEXT_MESSAGE_START', messageId: 'r:2', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r:2', delta: 'checking' },
    { type: 'TEXT_MESSAGE_END', messageId: 'r:2' },
    { type: 'TOOL_CALL_START', toolCallId: 'call', toolCallName: 'usage_aggregate', metadata: { started_at_ms: 10 } },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call', delta: '{"window":"24h"}' },
    { type: 'TOOL_CALL_END', toolCallId: 'call' },
  ]);
  assert.equal(frame.isAccepted, true);
  assert.equal(frame.turnId, 't1');
  assert.equal(frame.round, 1);
  assert.deepEqual(frame.parts, [
    { type: 'thought', content: 'plan one' },
    { type: 'text', content: 'checking' },
    { type: 'tool', trace_id: 'call' },
  ]);
  // A call is visible, with its arguments, before it has a result.
  assert.deepEqual(frame.traces, [{ id: 'call', name: 'usage_aggregate', arguments: '{"window":"24h"}', result: { status: 'running' }, started_at_ms: 10 }]);
  const settled = fold([
    { type: 'TOOL_CALL_RESULT', messageId: 'result:call', toolCallId: 'call', content: '{"status":"success","invalidates":["keys"]}', metadata: { ended_at_ms: 25, view: { kind: 'table', title: 'T', columns: ['a'], rows: [{ a: 1 }] } } },
    { type: 'STEP_FINISHED', stepName: 'round:1' },
    { type: 'STEP_STARTED', stepName: 'round:2', metadata: { round: 2 } },
    { type: 'TEXT_MESSAGE_START', messageId: 'r:3', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r:3', delta: 'answer' },
    { type: 'TEXT_MESSAGE_END', messageId: 'r:3' },
    { type: 'STATE_SNAPSHOT', snapshot: { id: 'c', revision: 2, model: 'm', client_key_fingerprint: 'k', turns: [], omitted: 0 } },
    { type: 'RUN_FINISHED', threadId: 'c', runId: 'r', outcome: { type: 'success' }, usage: [{ model: 'm', inputTokens: 10, outputTokens: 4, totalTokens: 14 }] },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r:3', delta: 'late' },
  ], frame);
  assert.equal(settled.parts.length, 4);
  assert.equal(settled.parts[3].content, 'answer', 'nothing after the finish is folded in');
  assert.equal(settled.traces[0].result.status, 'success');
  assert.equal(settled.traces[0].ended_at_ms, 25);
  assert.equal(settled.traces[0].view?.title, 'T');
  assert.equal(settled.round, 2);
  assert.deepEqual(settled.usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });
  assert.equal(settled.snapshot?.revision, 2);
  assert.equal(settled.isFinished, true);
});

check('a run refused before it started is not accepted, so the message can go back', () => {
  const refused = fold([{ type: 'RUN_ERROR', message: 'agent_busy', code: 'agent_busy' }]);
  assert.equal(refused.isAccepted, false);
  assert.equal(refused.errorCode, 'agent_busy');
  const failed = fold([{ type: 'RUN_STARTED', threadId: 'c', runId: 'r' }, { type: 'RUN_ERROR', message: 'budget_exceeded', code: 'budget_exceeded' }]);
  assert.equal(failed.isAccepted, true);
});

check('a resumed run reports its earlier call with a result alone, and ends on an interrupt', () => {
  const frame = fold([
    { type: 'RUN_STARTED', threadId: 'c', runId: 'r' },
    { type: 'TOOL_CALL_RESULT', messageId: 'result:earlier', toolCallId: 'earlier', content: '{"status":"success"}' },
    { type: 'RUN_FINISHED', threadId: 'c', runId: 'r', outcome: { type: 'interrupt', interrupts: [
      { id: 'op', reason: 'secret', toolCallId: 'next', expiresAt: '2026-09-29T00:10:00Z', metadata: { capability: 'providers_create', permission: 'write' } },
      { id: 'bad', reason: 'unknown-kind' },
    ] } },
  ]);
  assert.deepEqual(frame.parts, [], 'a resumed call already has its place in the stored turn');
  assert.equal(frame.traces[0].result.status, 'success');
  assert.deepEqual(frame.interrupts, [{ id: 'op', reason: 'secret', toolCallId: 'next', expiresAt: '2026-09-29T00:10:00Z', capability: 'providers_create', permission: 'write' }]);
});

check('a tool result names the views it invalidated, and an unreadable receipt is reported', () => {
  const event = parseAgentEvent(JSON.stringify({ type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 'c', content: '{"status":"success","invalidates":["management-providers"]}' })) as AgentEvent;
  assert.deepEqual(invalidatedKeys(event), ['management-providers']);
  assert.deepEqual(parseReceipt('nope'), { status: 'error', code: 'invalid_stream' });
});

check('a run request carries one message or a resume, and never history, state or tool results', () => {
  const input = buildRunInput({ threadId: 'c', runId: 'r', message: { id: 'm', content: 'hi' }, tools: [{ name: 'render_chart', description: 'chart' }], language: 'zh', forwardedProps: { revision: 3, model: 'm', client_key_fingerprint: 'k' } });
  assert.deepEqual(Object.keys(input).sort(), ['context', 'forwardedProps', 'messages', 'protocolVersion', 'runId', 'threadId', 'tools']);
  assert.equal(input.protocolVersion, '1.0');
  assert.deepEqual(input.messages, [{ id: 'm', role: 'user', content: 'hi' }]);
  assert.deepEqual(input.context, [{ description: 'console_language', value: 'zh' }]);
  const resume = buildRunInput({ threadId: 'c', runId: 'r2', tools: [], forwardedProps: { revision: 4, model: 'm', client_key_fingerprint: 'k' }, resume: [{ interruptId: 'op', status: 'resolved' }] });
  assert.deepEqual(resume.messages, []);
  assert.deepEqual(resume.resume, [{ interruptId: 'op', status: 'resolved' }]);
  assert.equal('state' in resume, false);
});

async function checkAsync(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

await checkAsync('the SSE reader survives chunks split inside characters, lines and frames', async () => {
  const bytes = new TextEncoder().encode(': keepalive\n\ndata: {"a":"中文"}\r\n\r\nevent: delta\ndata: one\ndata: two\n\ndata: tail-without-blank');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // One byte at a time: every possible split point.
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of readSSE(stream)) frames.push(frame);
  assert.deepEqual(frames, [{ data: '{"a":"中文"}' }, { event: 'delta', data: 'one\ntwo' }]);
});

// ── the transcript as assistant-ui messages ────────────────────────────────────

const pendingTurn = turn({ id: 't', status: 'pending', user: 'delete it', parts: [{ type: 'text', content: '<think>hmm</think>Checking.' }, { type: 'tool', trace_id: 'w' }], traces: [
  { id: 'w', name: 'providers_delete', arguments: '{"id":"p1"}', result: { status: 'pending', operation_id: 'op-1' }, started_at_ms: 5 },
] });

check('a stored turn becomes a user and an assistant message with the turn\'s own ids', () => {
  const messages = storedMessages([pendingTurn]);
  assert.deepEqual(messages.map(message => message.id), ['t:user', 't:assistant']);
  const content = messages[1].content as { type: string }[];
  assert.deepEqual(content.map(part => part.type), ['reasoning', 'text', 'tool-call'], 'inline <think> reads as reasoning');
  assert.deepEqual(messages[1].status, { type: 'requires-action', reason: 'interrupt' });
});

check('a call waiting on the operator carries an approval, or an interrupt for a question, and no result', () => {
  const approval = toolCallPart(pendingTurn.traces[0], true);
  assert.deepEqual(approval.approval, { id: 'op-1' });
  assert.equal(approval.result, undefined);
  assert.equal(approval.interrupt, undefined);
  assert.deepEqual(approval.args, { id: 'p1' });
  const question = toolCallPart({ id: 'q', name: 'ask_question', result: { status: 'pending', operation_id: 'op-q' } }, true);
  assert.deepEqual(question.interrupt, { type: 'human', payload: { operation_id: 'op-q' } });
  assert.equal(question.approval, undefined);
  assert.equal(toolCallPart(pendingTurn.traces[0], false).approval, undefined, 'only the open turn asks');
  const done = toolCallPart({ id: 'd', name: 'render_chart', result: { status: 'success', data: { rendered: true } }, view: { kind: 'table', title: 'T', columns: [], rows: [] }, started_at_ms: 1, ended_at_ms: 3 }, false);
  assert.deepEqual(done.timing, { startedAt: 1, completedAt: 3 });
  assert.equal((done.artifact as { title: string }).title, 'T');
  assert.equal(done.modelContent?.[0].type, 'text');
});

check('a stopped turn is incomplete rather than failed, and a failure carries its code', () => {
  assert.deepEqual(turnMessageStatus(turn({ status: 'error', code: 'cancelled' })), { type: 'incomplete', reason: 'cancelled' });
  assert.deepEqual(turnMessageStatus(turn({ status: 'error', code: 'budget_exceeded' })), { type: 'incomplete', reason: 'error', error: 'budget_exceeded' });
  assert.deepEqual(turnMessageStatus(turn({ status: 'success' })), { type: 'complete', reason: 'stop' });
});

check('a resumed run continues the stored turn in place, updating the call it stopped on', () => {
  const frame = fold([
    { type: 'RUN_STARTED', threadId: 'c', runId: 'r' },
    { type: 'TOOL_CALL_RESULT', messageId: 'result:w', toolCallId: 'w', content: '{"status":"success"}' },
    { type: 'TEXT_MESSAGE_START', messageId: 'r:1', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r:1', delta: 'Deleted.' },
  ]);
  const merged = mergeLiveTurn(pendingTurn, frame);
  assert.deepEqual(merged.parts.map(part => part.type), ['text', 'tool', 'text']);
  assert.equal(merged.traces[0].name, 'providers_delete', 'the stored name survives a result-only event');
  assert.equal(merged.traces[0].result.status, 'success');
  const conversation: Conversation = { id: 'c', revision: 1, model: 'm', client_key_fingerprint: 'k', turns: [pendingTurn], omitted: 0 };
  const stored = storedMessages(conversation.turns);
  const messages = agentThreadMessages(conversation, stored, { frame, pendingMessage: '', isResuming: true });
  assert.deepEqual(messages.map(message => message.id), ['t:user', 't:assistant']);
  const fresh = agentThreadMessages(conversation, stored, { frame: { ...frame, turnId: 'n' }, pendingMessage: 'next', isResuming: false });
  assert.deepEqual(fresh.map(message => message.id), ['t:user', 't:assistant', 'n:user', 'n:assistant'], 'the live turn takes the id the stored one will have');
});

check('a quoted passage travels as a Markdown quote ahead of the question', () => {
  const message = { role: 'user', content: [{ type: 'text', text: 'Why?' }], metadata: { custom: { quote: { text: 'line one\nline two', messageId: 'm' } } } } as unknown as Parameters<typeof appendMessageText>[0];
  assert.equal(appendMessageText(message), '> line one\n> line two\n\nWhy?');
});

// ── call rows ──────────────────────────────────────────────────────────────────

check('a call row states its arguments in brief', () => {
  assert.equal(argumentSummary('{"window":"24h","group_by":"model"}'), 'window=24h · group_by=model');
  assert.equal(argumentSummary('{"a":1,"b":2,"c":3,"d":4,"e":""}'), 'a=1 · b=2 · c=3 · +1');
  assert.equal(argumentSummary(`{"sql":"${'x'.repeat(50)}"}`), `sql=${'x'.repeat(32)}…`);
  assert.equal(argumentSummary('{}'), '');
  assert.equal(argumentSummary('not json'), '');
});

check('a call row names what the call needs: running, you, an answer, or nothing', () => {
  assert.equal(callStatusKey({ name: 'x', result: { status: 'running' } }), 'agent.call.running');
  assert.equal(callStatusKey({ name: 'x', result: { status: 'pending' } }), 'agent.call.needs_you');
  assert.equal(callStatusKey({ name: 'ask_question', result: { status: 'pending' } }), 'agent.status.question');
  assert.equal(callStatusKey({ name: 'x', result: { status: 'uncertain' } }), 'agent.status.uncertain');
  assert.equal(callStatusKey({ name: 'x', result: { status: 'teleported' } }), 'agent.status.unknown');
  assert.equal(callDuration({ started_at_ms: 100, ended_at_ms: 350 }), 250);
  assert.equal(callDuration({ started_at_ms: 100 }, 400), 300);
  assert.equal(callDuration({ started_at_ms: 100 }), undefined);
});

check('a chart is read in long form, a time-bucketed axis as time, and gaps are left out', () => {
  const series = chartSeries({ chart: { type: 'line', x: 'bucket', y: ['ok', 'failed'] }, rows: [
    { bucket: '1727600000000', ok: 3, failed: 1 },
    { bucket: '1727603600000', ok: 5, failed: null },
  ] });
  assert.equal(series.isTime, true);
  assert.deepEqual(series.points, [
    { x: '1727600000000', series: 'ok', value: 3 },
    { x: '1727600000000', series: 'failed', value: 1 },
    { x: '1727603600000', series: 'ok', value: 5 },
  ]);
  const split = chartSeries({ chart: { type: 'column', x: 'day', y: ['n'], series: 'model' }, rows: [{ day: 'mon', n: 2, model: 'a' }] });
  assert.deepEqual(split, { points: [{ x: 'mon', series: 'a', value: 2 }], isTime: false });
});

// ── exports ────────────────────────────────────────────────────────────────────

const labels: ExportLabels = {
  title: 'Agent', model: 'Model', exportedAt: 'Exported', operator: 'Operator', answer: 'Answer', calls: 'Calls',
  status: status => status, capability: name => (name === 'usage_aggregate' ? 'Usage' : ''), duration: ms => `${ms}ms`, failure: code => `failed ${code}`,
};

check('a CSV cell is quoted when it must be, and a formula is never executable', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(-3), '-3', 'a negative number is a number');
  assert.equal(csvCell(null), '');
  assert.equal(viewToCSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 'x\ny' }] }), 'a,b\r\n1,"x\ny"\r\n');
});

check('a Markdown table neutralises pipes and line breaks inside cells', () => {
  assert.equal(rowsToMarkdown(['k'], [{ k: 'a|b\nc' }]), '| k |\n| --- |\n| a\\|b c |');
});

check('an answer exports its text, its charts as data and its calls in brief, without reasoning', () => {
  const answer = turnAnswerMarkdown({
    status: 'error',
    code: 'budget_exceeded',
    reply: '',
    parts: [
      { type: 'thought', content: 'private working' },
      { type: 'tool', trace_id: 'u' },
      { type: 'tool', trace_id: 'c' },
      { type: 'text', content: 'Traffic is flat.' },
    ],
    traces: [
      { id: 'u', name: 'usage_aggregate', arguments: '{"is_trend":true}', result: { status: 'success' }, started_at_ms: 1, ended_at_ms: 41 },
      { id: 'c', name: 'render_chart', result: { status: 'success' }, view: { kind: 'chart', title: 'Requests', columns: ['day', 'n'], rows: [{ day: 'mon', n: 2 }] } },
    ],
  }, labels);
  assert.equal(answer.includes('private working'), false);
  assert.equal(answer, [
    'Calls\n\n- `usage_aggregate` · Usage · success · 40ms\n  `{"is_trend":true}`\n- `render_chart` · success',
    'Traffic is flat.',
    '> failed budget_exceeded (`budget_exceeded`)',
  ].join('\n\n'));
  const report = conversationMarkdown({ id: 'c', revision: 1, model: 'm1', client_key_fingerprint: 'private-export-fingerprint-7e219c', omitted: 0, turns: [turn({ user: 'How?', reply: 'Fine.', status: 'success' })] }, labels, new Date(Date.UTC(2026, 8, 29)));
  assert.equal(report.startsWith('# Agent\n\n- Model: `m1`\n- Exported: 2026-09-29T00:00:00.000Z\n\n---\n\n## Operator\n\nHow?\n\n## Answer · success\n\nFine.'), true, report);
  assert.equal(report.includes('private-export-fingerprint-7e219c'), false, 'the key fingerprint is not part of the report');
  assert.equal(report.includes('client_key'), false);
});

check('a Playground export names the model and parameters each answer ran with', () => {
  const report = playgroundMarkdown([{ user: 'Hi', imageCount: 1, reply: 'Hello', model: 'm', status: 'success', parameters: { temperature: 0.2, system_prompt: undefined } }], {
    title: 'Playground', exportedAt: 'Exported', operator: 'Operator', answer: 'Answer', model: 'Model', parameters: 'Parameters', images: count => `${count} image`, status: status => status,
  }, new Date(0));
  assert.equal(report.includes('- Parameters: `temperature=0.2`'), true, report);
  assert.equal(report.includes('_1 image_'), true);
});

check('an export file name is sortable and safe on every file system', () => {
  assert.equal(exportFileName('Requests / 24h', 'csv', new Date(2026, 8, 29, 7, 5, 9)), 'requests-24h-20260929-070509.csv');
  assert.equal(exportFileName('', 'md', new Date(2026, 0, 1)), 'export-20260101-000000.md');
});

check('only a successful turn publishes display figures, and their export follows the calls', () => {
  const view = { kind: 'chart', title: 'Requests', chart: { type: 'column', x: 'day', y: ['n'] }, columns: ['day', 'n'], rows: [{ day: 'mon', n: 2 }], source: { call_id: 'q', path: 'rows' } } as const;
  const display: Trace = { id: 'd', name: 'render_chart', arguments: '{}', result: { status: 'success', data: { rendered: true } }, view };
  const plain: Trace = { id: 'r', name: 'usage_aggregate', arguments: '{}', result: { status: 'success', data: {} } };
  const base = { id: 't', user: 'Q', reply: 'Done.', status: 'success', parts: [], traces: [display, plain] } as const;
  assert.deepEqual(completedDisplayViews(base).map(trace => trace.id), ['d']);
  for (const status of ['running', 'pending', 'error', 'cancelled']) {
    assert.deepEqual(completedDisplayViews({ ...base, status, code: status === 'error' ? 'failed' : status }), []);
  }
  assert.deepEqual(completedDisplayViews(undefined), []);
  const markdown = turnAnswerMarkdown({ ...base, parts: [{ type: 'tool', trace_id: 'd' }, { type: 'text', content: 'Done.' }] }, labels);
  assert.equal(markdown, ['Calls\n\n- `render_chart` · success', 'Done.', '**Requests**\n\n| day | n |\n| --- | --- |\n| mon | 2 |'].join('\n\n'));
});

check('an agent category axis keeps model names horizontal and ellipsises them', () => {
  const axis = agentChartAxis(value => value.toUpperCase());
  assert.equal(axis.x.labelAutoRotate, false);
  assert.equal(axis.x.labelAutoEllipsis, true);
  assert.equal(axis.x.labelAutoHide, true);
  assert.equal(axis.x.labelFormatter('gpt-4'), 'GPT-4');
  assert.equal(axis.y.labelFormatter(1200), '1,200');
});


check('an unavailable recovery journal names the recovery boundary rather than an upstream outage', () => {
  for (const code of ['run_not_found', 'run_expired']) assert.equal(failureKey(code), 'workspace.error.run_missing');
  assert.equal(failureKey('authentication_required'), 'agent.error.session');
  assert.equal(failureKey('response_too_large'), 'agent.error.budget');
});

console.log(`\n${passed} assertions passed`);
