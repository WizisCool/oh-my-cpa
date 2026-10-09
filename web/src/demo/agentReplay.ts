import { EventType } from '@ag-ui/core';
import { parseAgentEvent } from '../agent/protocol';
import type { AgentEvent, AgentRunRequest } from '../agent/protocol';
import { isDisplayTool } from '../agent/types';
import type { CapabilityReceipt, Conversation, DisplayView, Trace, Turn, TurnPart } from '../agent/types';
import { createID } from '../utils/ids';
import recording from './agentRecording.json';
import {
  answerChunkSize, chunkText, recordingLanguage, REPLAY_CALL_FLOOR_MS, REPLAY_FRAME_MS, REPLAY_ROUND_PAUSE_MS, wallClockPace,
} from './pacing';
import type { Pace } from './pacing';
import { resolveRecording } from './recordingTemplate';
import { readDemoConversation, readDemoQuestion, writeDemoConversation } from './session';

/** The code a replay answers a message it has no recording for with. */
export const DEMO_REPLAY_ONLY = 'demo_replay_only';

/** A recorded call: its arguments as a document, and how long it ran. */
interface RecordedTrace {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: CapabilityReceipt;
  duration_ms: number;
  view?: DisplayView;
}

interface RecordedTurn extends Omit<Turn, 'id' | 'reply' | 'traces' | 'started_at_ms' | 'ended_at_ms'> {
  parts: TurnPart[];
  traces: RecordedTrace[];
}

const THOUGHT_CHUNK = 14;
/** A display's markup arrives fast enough to watch it being drawn without waiting on it. */
const DISPLAY_ARGUMENT_CHUNK = 72;

/**
 * Replays the recorded Agent run as the events a live run sends (ADR 0092).
 *
 * The demonstration calls no model, so this stands where the run request does and yields the
 * same AG-UI stream the server's translator would have: a round per model request, reasoning and
 * answer text as deltas, each call announced before its result, then the stored conversation and
 * the run's end. Everything downstream - the reducer, the transcript, the call timeline, a
 * generated interface drawn while its markup is still arriving - is the console's own code
 * reading it, which is the point: the demonstration shows the product working, not a picture of
 * it. Every event goes through the wire parser before it is yielded, so a replay cannot emit a
 * shape a real run could not.
 *
 * Only the recorded question is answered. Anything else is refused before the run is accepted,
 * which hands the message back to the composer exactly as a server refusal does.
 */
export async function* replayAgentRun(request: AgentRunRequest, signal: AbortSignal, pace: Pace = wallClockPace): AsyncGenerator<AgentEvent> {
  const emit = (event: Record<string, unknown>): AgentEvent => {
    const parsed = parseAgentEvent(JSON.stringify(event));
    if (!parsed) throw new Error('stream_incomplete');
    return parsed;
  };
  const language = recordingLanguage(request.language);
  const anchorMS = Math.floor(Date.now() / 1000) * 1000;
  const recorded = resolveRecording<RecordedTurn>(recording.turn, anchorMS, language);
  const asked = request.message?.content.trim() ?? '';
  if (!request.message || !isRecordedQuestion(asked)) {
    await pace(REPLAY_ROUND_PAUSE_MS, signal);
    yield emit({ type: EventType.RUN_ERROR, message: DEMO_REPLAY_ONLY, code: DEMO_REPLAY_ONLY });
    return;
  }

  const turnID = createID('turn');
  const startedAtMS = Date.now();
  const traces = new Map(recorded.traces.map(trace => [trace.id, trace]));
  const settled: Trace[] = [];
  yield emit({ type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId, protocolVersion: '1.0', metadata: { turn_id: turnID } });

  let round = 0;
  let sequence = 0;
  let isRoundOpen = false;
  const openRound = async function* (): AsyncGenerator<AgentEvent> {
    if (isRoundOpen) return;
    round += 1;
    isRoundOpen = true;
    yield emit({ type: EventType.STEP_STARTED, stepName: `round:${round}`, metadata: { round } });
    await pace(REPLAY_ROUND_PAUSE_MS, signal);
  };
  const closeRound = function* (): Generator<AgentEvent> {
    if (!isRoundOpen) return;
    isRoundOpen = false;
    yield emit({ type: EventType.STEP_FINISHED, stepName: `round:${round}` });
  };

  for (const part of recorded.parts) {
    yield* openRound();
    if (part.type === 'tool') {
      const trace = traces.get(part.trace_id ?? '');
      if (!trace) throw new Error('stream_incomplete');
      const argumentsText = JSON.stringify(trace.arguments);
      const callStartedAtMS = Date.now();
      yield emit({ type: EventType.TOOL_CALL_START, toolCallId: trace.id, toolCallName: trace.name, metadata: { started_at_ms: callStartedAtMS } });
      // A display's arguments are the model writing an interface, and the console draws it as it
      // is written; any other call's arguments arrive whole, as the server announces them.
      for (const delta of isDisplayTool(trace.name) ? chunkText(argumentsText, DISPLAY_ARGUMENT_CHUNK) : [argumentsText]) {
        yield emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: trace.id, delta });
        if (isDisplayTool(trace.name)) await pace(REPLAY_FRAME_MS, signal);
      }
      yield emit({ type: EventType.TOOL_CALL_END, toolCallId: trace.id });
      await pace(Math.max(trace.duration_ms, REPLAY_CALL_FLOOR_MS), signal);
      const callEndedAtMS = Date.now();
      settled.push({
        id: trace.id, name: trace.name, arguments: argumentsText, result: trace.result,
        started_at_ms: callStartedAtMS, ended_at_ms: callEndedAtMS, ...(trace.view ? { view: trace.view } : {}),
      });
      yield emit({
        type: EventType.TOOL_CALL_RESULT, messageId: `result:${trace.id}`, toolCallId: trace.id, content: JSON.stringify(trace.result), role: 'tool',
        metadata: { started_at_ms: callStartedAtMS, ended_at_ms: callEndedAtMS, ...(trace.view ? { view: trace.view } : {}) },
      });
      // A call ends its round: the next thing the model writes answers what the call returned.
      yield* closeRound();
      continue;
    }
    sequence += 1;
    const messageId = `${request.runId}:${sequence}`;
    const isThought = part.type === 'thought';
    if (isThought) {
      yield emit({ type: EventType.REASONING_START, messageId });
      yield emit({ type: EventType.REASONING_MESSAGE_START, messageId, role: 'reasoning' });
    } else {
      yield emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
    }
    for (const delta of chunkText(part.content ?? '', isThought ? THOUGHT_CHUNK : answerChunkSize(language))) {
      yield emit({ type: isThought ? EventType.REASONING_MESSAGE_CONTENT : EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
      await pace(REPLAY_FRAME_MS, signal);
    }
    if (isThought) {
      yield emit({ type: EventType.REASONING_MESSAGE_END, messageId });
      yield emit({ type: EventType.REASONING_END, messageId });
    } else {
      yield emit({ type: EventType.TEXT_MESSAGE_END, messageId });
    }
  }
  yield* closeRound();

  const turn: Turn = {
    id: turnID,
    user: asked,
    reply: recorded.parts.filter(part => part.type === 'text').map(part => part.content ?? '').join('\n\n'),
    parts: recorded.parts,
    status: recorded.status,
    traces: settled,
    rounds: recorded.rounds,
    calls: recorded.calls,
    started_at_ms: startedAtMS,
    ended_at_ms: Date.now(),
    usage: recorded.usage,
    prompt_version: recorded.prompt_version,
    present: recorded.present,
  };
  const conversation = nextConversation(request, turn, anchorMS);
  writeDemoConversation(conversation);
  yield emit({ type: EventType.STATE_SNAPSHOT, snapshot: conversation });
  yield emit({
    type: EventType.RUN_FINISHED, threadId: request.threadId, runId: request.runId, outcome: { type: 'success' },
    usage: [{ inputTokens: recorded.usage?.input_tokens, outputTokens: recorded.usage?.output_tokens, totalTokens: recorded.usage?.total_tokens }],
  });
}

/**
 * Whether a message is the question the recording answers: in either language the recording is
 * written in, or as the page offers it in the reading language (a reader in a third language
 * asks in theirs and reads the English answer).
 */
function isRecordedQuestion(text: string): boolean {
  return Object.values(recording.turn.user).includes(text) || text === readDemoQuestion();
}

function nextConversation(request: AgentRunRequest, turn: Turn, anchorMS: number): Conversation {
  const current = readDemoConversation();
  return {
    id: request.threadId,
    revision: (current?.revision ?? request.forwardedProps.revision) + 1,
    model: request.forwardedProps.model,
    client_key_fingerprint: request.forwardedProps.client_key_fingerprint,
    ...(request.forwardedProps.reasoning_effort ? { reasoning_effort: request.forwardedProps.reasoning_effort } : {}),
    ...(request.forwardedProps.endpoint ? { endpoint: request.forwardedProps.endpoint } : {}),
    turns: [...(current?.turns ?? []), turn],
    omitted: 0,
    anchor_ms: current?.anchor_ms || anchorMS,
  };
}
