/**
 * The demonstration's replays, asserted without a browser (ADR 0092).
 *
 * A replay stands where a model request does, so what it has to get right is the contract the
 * console reads: the events fold into exactly the turn the run then stores, a message with no
 * recording is refused before it is accepted, and nothing in a recording is a fixed date. A
 * browser probe shows the page drawing a replay; this suite proves what it is drawing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAgentEvent, EMPTY_FRAME } from '../web/src/agent/runReducer.ts';
import type { AgentRunRequest } from '../web/src/agent/protocol.ts';
import { DEMO_REPLAY_ONLY, replayAgentRun } from '../web/src/demo/agentReplay.ts';
import agentRecording from '../web/src/demo/agentRecording.json' with { type: 'json' };
import { chunkText, recordingLanguage } from '../web/src/demo/pacing.ts';
import { replayPlaygroundChat } from '../web/src/demo/playgroundReplay.ts';
import playgroundRecording from '../web/src/demo/playgroundRecording.json' with { type: 'json' };
import { resolveRecording } from '../web/src/demo/recordingTemplate.ts';
import { readDemoConversation, resetDemoConversation, writeDemoQuestion } from '../web/src/demo/session.ts';
import { applyEvent } from '../web/src/pages/playground/state.ts';
import type { ChatRequest, StreamEvent, Turn } from '../web/src/pages/playground/state.ts';

const instant = async () => {};
const QUESTION = agentRecording.turn.user;

function runRequest(content: string, language = 'zh'): AgentRunRequest {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    message: { id: 'message-1', content },
    tools: [],
    language,
    forwardedProps: { revision: 0, model: 'demo-model', client_key_fingerprint: 'hmac:demo' },
  };
}

async function fold(request: AgentRunRequest) {
  let frame = EMPTY_FRAME;
  const types: string[] = [];
  for await (const event of replayAgentRun(request, new AbortController().signal, instant)) {
    types.push(event.type);
    frame = applyAgentEvent(frame, event);
  }
  return { frame, types };
}

test('a replayed run folds into the turn it then stores', async () => {
  const { frame, types } = await fold(runRequest(QUESTION.zh));
  assert.equal(frame.isAccepted, true);
  assert.equal(frame.isFinished, true);
  assert.equal(frame.errorCode, '');
  const stored = frame.snapshot?.turns.at(-1);
  assert.ok(stored, 'the run reports the conversation it ended with');
  // The live transcript is replaced by the stored turn when the run ends; equal parts are
  // what keeps anything on screen from moving at that moment.
  assert.deepEqual(frame.parts, stored.parts);
  assert.deepEqual(frame.traces, stored.traces);
  assert.equal(frame.turnId, stored.id);
  assert.equal(stored.user, QUESTION.zh);
  assert.equal(stored.traces.length, stored.calls);
  assert.equal(types.filter(type => type === 'STEP_STARTED').length, stored.rounds);
  assert.equal(types.at(-1), 'RUN_FINISHED');
  assert.deepEqual(readDemoConversation(), frame.snapshot);
});

test('a generated interface arrives as a draft before it settles', async () => {
  const drafts: string[] = [];
  let frame = EMPTY_FRAME;
  for await (const event of replayAgentRun(runRequest(QUESTION.en, 'en'), new AbortController().signal, instant)) {
    frame = applyAgentEvent(frame, event);
    const display = frame.traces.find(trace => trace.name === 'render_ui');
    if (display?.result.status === 'running') drafts.push(display.arguments ?? '');
  }
  assert.ok(drafts.length > 10, 'the markup is written over many frames');
  const view = frame.traces.find(trace => trace.name === 'render_ui')?.view;
  assert.equal(view?.kind, 'ui');
  assert.equal(view?.title, agentRecording.turn.traces.at(-1)?.view?.title.en);
});

test('a message with no recording is refused before it is accepted', async () => {
  const before = readDemoConversation();
  const { frame, types } = await fold(runRequest('What is my quota?'));
  assert.deepEqual(types, ['RUN_ERROR']);
  assert.equal(frame.isAccepted, false);
  assert.equal(frame.errorCode, DEMO_REPLAY_ONLY);
  assert.equal(readDemoConversation(), before);
});

test('the question is accepted as the page offers it in a third reading language', async () => {
  const offered = 'Kira permintaan dan kadar kegagalan setiap hari bagi 7 hari terakhir.';
  assert.equal((await fold(runRequest(offered, 'ms'))).frame.errorCode, DEMO_REPLAY_ONLY);
  writeDemoQuestion(offered);
  const { frame } = await fold(runRequest(offered, 'ms'));
  assert.equal(frame.errorCode, '');
  // A reader in a language the recording is not written in reads the English answer.
  assert.match(frame.snapshot?.turns.at(-1)?.reply ?? '', /failure rate/);
  writeDemoQuestion('');
});

test('a second replay continues the conversation and a reset empties it', async () => {
  const current = readDemoConversation();
  assert.ok(current);
  const { frame } = await fold(runRequest(QUESTION.zh));
  assert.equal(frame.snapshot?.turns.length, current.turns.length + 1);
  assert.equal(frame.snapshot?.revision, current.revision + 1);
  const reset = resetDemoConversation(frame.snapshot!);
  assert.deepEqual(reset.turns, []);
  assert.equal(reset.revision, frame.snapshot!.revision + 1);
  assert.equal(readDemoConversation(), reset);
});

test('a stopped replay ends as a cancelled request does', async () => {
  const controller = new AbortController();
  const abortingPace = async () => {
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  };
  await assert.rejects(async () => {
    for await (const _event of replayAgentRun(runRequest(QUESTION.zh), controller.signal, abortingPace)) { /* drained */ }
  }, { name: 'AbortError' });
});

test('a recording is measured from the moment it is replayed', () => {
  const anchorMS = Date.UTC(2031, 0, 3, 9, 5, 0);
  for (const language of ['zh', 'en'] as const) {
    const resolved = JSON.stringify(resolveRecording(agentRecording.turn, anchorMS, language));
    assert.doesNotMatch(resolved, /\{\{/, 'every placeholder resolves');
    assert.match(resolved, /2030-12-27/, 'the window opens seven days before the anchor');
    assert.match(resolved, /2031-01-03/);
    assert.match(resolved, /09:05/);
  }
  const zh = resolveRecording<{ parts: { content?: string }[] }>(agentRecording.turn, anchorMS, 'zh');
  assert.match(zh.parts.map(part => part.content ?? '').join(''), /12 月 27 日 09:05 至 1 月 3 日 09:05/);
  const en = resolveRecording<{ parts: { content?: string }[] }>(agentRecording.turn, anchorMS, 'en');
  assert.match(en.parts.map(part => part.content ?? '').join(''), /Dec 27 09:05 to Jan 3 09:05/);
  // Fields that hold instants are numbers on the wire, not digits in a string.
  const call = resolveRecording<{ traces: { arguments: { from_ms: unknown; to_ms: unknown } }[] }>(agentRecording.turn, anchorMS, 'en').traces[0];
  assert.equal(call.arguments.to_ms, anchorMS);
  assert.equal(call.arguments.from_ms, anchorMS - 7 * 24 * 3_600_000);
});

test('the recorded figures agree with each other', () => {
  const view = agentRecording.turn.traces.at(-1)?.view;
  assert.ok(view);
  const requests = view.rows.reduce((sum, row) => sum + row.requests, 0);
  const failures = view.rows.reduce((sum, row) => sum + row.failures, 0);
  for (const language of ['zh', 'en'] as const) {
    const answer = agentRecording.turn.parts.map(part => (typeof part.content === 'object' ? part.content[language] : '')).join('');
    assert.ok(answer.includes(requests.toLocaleString('en-US')), `${language}: the answer states the table's total`);
    assert.ok(answer.includes(`${(100 * failures / requests).toFixed(1)}%`), `${language}: the answer states the table's rate`);
  }
  for (const row of view.rows) assert.equal(row.failure_rate, Math.round(1e4 * row.failures / row.requests) / 1e4);
});

test('text is cut on whole characters', () => {
  assert.deepEqual(chunkText('a😀b中', 2), ['a😀', 'b中']);
  assert.equal(recordingLanguage('zh-Hant'), 'zh');
  assert.equal(recordingLanguage('ms'), 'en');
  assert.equal(recordingLanguage(undefined), 'en');
});

test('a replayed Playground answer folds into a finished turn', async () => {
  const request = { model: 'demo-model', client_key_fingerprint: 'hmac:demo', messages: [] } as unknown as ChatRequest;
  for (const language of ['zh', 'en'] as const) {
    let turn = { id: 'turn-1', request, keyLabel: '', user: { role: 'user', content: [] }, reply: '', status: 'running', startedAt: Date.now(), events: [], eventBytes: 0, isTruncated: false } as unknown as Turn;
    const events: StreamEvent[] = [];
    await replayPlaygroundChat(request, new AbortController().signal, event => {
      events.push(event);
      turn = applyEvent(turn, event);
    }, language, instant);
    assert.equal(turn.status, 'success');
    assert.equal(turn.reply, playgroundRecording.reply[language]);
    assert.equal(turn.thought, playgroundRecording.thought);
    assert.deepEqual(turn.usage, playgroundRecording.usage);
    assert.equal(events[0].type, 'meta');
    assert.equal(events[0].model, 'demo-model');
    assert.equal(events.at(-1)?.type, 'done');
  }
});
