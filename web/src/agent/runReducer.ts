import { EventType } from '@ag-ui/core';
import type { AgentEvent } from './protocol';
import { MAX_TURN_ROUNDS } from './types';
import type { AgentInterrupt, CapabilityReceipt, Conversation, DisplayView, InterruptReason, Trace, TurnPart, TurnUsage } from './types';

/**
 * What one run has produced so far, rebuilt from its AG-UI events.
 *
 * A pure fold over the stream, so the same events always give the same frame and the rules can be
 * asserted without a browser. The parts it builds follow the server's stored parts exactly - one
 * part per text or reasoning message, one per tool call in the order it started - so when the run
 * ends and the stored turn replaces the live one, nothing on screen moves.
 */
export interface RunFrame {
  /** The server persisted the turn; until then a new message has not been accepted. */
  isAccepted: boolean;
  threadId: string;
  turnId: string;
  parts: TurnPart[];
  /** Calls this run started or resolved; a call still executing has the `running` status. */
  traces: Trace[];
  round: number;
  maxRounds: number;
  snapshot?: Conversation;
  interrupts: AgentInterrupt[];
  errorCode: string;
  isFinished: boolean;
  usage?: TurnUsage;
  /** The part each open text or reasoning message writes into. */
  messageParts: Record<string, number>;
}

export const EMPTY_FRAME: RunFrame = {
  isAccepted: false,
  threadId: '',
  turnId: '',
  parts: [],
  traces: [],
  round: 0,
  maxRounds: MAX_TURN_ROUNDS,
  interrupts: [],
  errorCode: '',
  isFinished: false,
  messageParts: {},
};

const INTERRUPT_REASONS: readonly InterruptReason[] = ['approval', 'question', 'secret', 'oauth'];

function metadataOf(event: AgentEvent): Record<string, unknown> {
  const metadata = (event as { metadata?: unknown }).metadata;
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function upsertTrace(traces: Trace[], id: string, update: (trace: Trace) => Trace): Trace[] {
  const index = traces.findIndex(trace => trace.id === id);
  if (index < 0) return [...traces, update({ id, name: '', result: { status: 'running' } })];
  return traces.map((trace, position) => (position === index ? update(trace) : trace));
}

/** The receipt a tool result carries: the exact JSON the model received. */
export function parseReceipt(content: unknown): CapabilityReceipt {
  if (typeof content !== 'string') return { status: 'error', code: 'invalid_stream' };
  try {
    const value = JSON.parse(content) as unknown;
    if (typeof value === 'object' && value !== null && typeof (value as CapabilityReceipt).status === 'string') return value as CapabilityReceipt;
  } catch {
    // Fall through: an unreadable receipt is reported, not guessed at.
  }
  return { status: 'error', code: 'invalid_stream' };
}

function readInterrupts(outcome: unknown): AgentInterrupt[] {
  const interrupts = (outcome as { type?: string; interrupts?: unknown } | undefined)?.type === 'interrupt'
    ? (outcome as { interrupts?: unknown }).interrupts
    : undefined;
  if (!Array.isArray(interrupts)) return [];
  return interrupts.flatMap((item): AgentInterrupt[] => {
    if (typeof item !== 'object' || item === null) return [];
    const value = item as { id?: unknown; reason?: unknown; toolCallId?: unknown; expiresAt?: unknown; metadata?: Record<string, unknown> };
    if (typeof value.id !== 'string' || !INTERRUPT_REASONS.includes(value.reason as InterruptReason)) return [];
    return [{
      id: value.id,
      reason: value.reason as InterruptReason,
      ...(typeof value.toolCallId === 'string' ? { toolCallId: value.toolCallId } : {}),
      ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
      ...(typeof value.metadata?.capability === 'string' ? { capability: value.metadata.capability } : {}),
      ...(typeof value.metadata?.permission === 'string' ? { permission: value.metadata.permission } : {}),
    }];
  });
}

function readUsage(usage: unknown): TurnUsage | undefined {
  if (!Array.isArray(usage) || usage.length === 0) return undefined;
  const total: TurnUsage = {};
  for (const entry of usage as Record<string, unknown>[]) {
    const input = numberOf(entry.inputTokens);
    const output = numberOf(entry.outputTokens);
    const sum = numberOf(entry.totalTokens);
    if (input !== undefined) total.input_tokens = (total.input_tokens ?? 0) + input;
    if (output !== undefined) total.output_tokens = (total.output_tokens ?? 0) + output;
    if (sum !== undefined) total.total_tokens = (total.total_tokens ?? 0) + sum;
  }
  return total;
}

function openMessage(frame: RunFrame, messageId: string, type: 'thought' | 'text'): RunFrame {
  return {
    ...frame,
    parts: [...frame.parts, { type, content: '' }],
    messageParts: { ...frame.messageParts, [messageId]: frame.parts.length },
  };
}

function appendMessage(frame: RunFrame, messageId: string, type: 'thought' | 'text', delta: string): RunFrame {
  const opened = messageId in frame.messageParts ? frame : openMessage(frame, messageId, type);
  const index = opened.messageParts[messageId];
  const parts = opened.parts.map((part, position) => (position === index ? { ...part, content: (part.content ?? '') + delta } : part));
  return { ...opened, parts };
}

/** Folds one event into the frame. Events after the run finished are ignored. */
export function applyAgentEvent(frame: RunFrame, event: AgentEvent): RunFrame {
  if (frame.isFinished) return frame;
  const metadata = metadataOf(event);
  switch (event.type) {
    case EventType.RUN_STARTED:
      return { ...frame, isAccepted: true, threadId: event.threadId, turnId: typeof metadata.turn_id === 'string' ? metadata.turn_id : '' };
    case EventType.STEP_STARTED:
      return { ...frame, round: numberOf(metadata.round) ?? frame.round + 1, maxRounds: numberOf(metadata.max_rounds) ?? frame.maxRounds };
    case EventType.TEXT_MESSAGE_START:
      return openMessage(frame, event.messageId, 'text');
    case EventType.TEXT_MESSAGE_CONTENT:
      return appendMessage(frame, event.messageId, 'text', event.delta);
    case EventType.REASONING_MESSAGE_START:
      return event.messageId in frame.messageParts ? frame : openMessage(frame, event.messageId, 'thought');
    case EventType.REASONING_MESSAGE_CONTENT:
      return appendMessage(frame, event.messageId, 'thought', event.delta);
    case EventType.TOOL_CALL_START: {
      const startedAt = numberOf(metadata.started_at_ms);
      return {
        ...frame,
        parts: frame.parts.some(part => part.type === 'tool' && part.trace_id === event.toolCallId)
          ? frame.parts
          : [...frame.parts, { type: 'tool', trace_id: event.toolCallId }],
        traces: upsertTrace(frame.traces, event.toolCallId, trace => ({
          ...trace,
          name: event.toolCallName,
          arguments: '',
          result: { status: 'running' },
          ...(startedAt ? { started_at_ms: startedAt } : {}),
        })),
      };
    }
    case EventType.TOOL_CALL_ARGS:
      return { ...frame, traces: upsertTrace(frame.traces, event.toolCallId, trace => ({ ...trace, arguments: (trace.arguments ?? '') + event.delta })) };
    case EventType.TOOL_CALL_RESULT: {
      const startedAt = numberOf(metadata.started_at_ms);
      const endedAt = numberOf(metadata.ended_at_ms);
      const view = typeof metadata.view === 'object' && metadata.view !== null ? metadata.view as DisplayView : undefined;
      // A resumed run reports a call an earlier run started: the trace is created without a
      // part, because that call already has its place in the stored turn.
      return {
        ...frame,
        traces: upsertTrace(frame.traces, event.toolCallId, trace => ({
          ...trace,
          result: parseReceipt(event.content),
          ...(startedAt ? { started_at_ms: startedAt } : {}),
          ...(endedAt ? { ended_at_ms: endedAt } : {}),
          ...(view ? { view } : {}),
        })),
      };
    }
    case EventType.STATE_SNAPSHOT:
      return { ...frame, snapshot: event.snapshot as Conversation };
    case EventType.RUN_FINISHED:
      return { ...frame, isFinished: true, interrupts: readInterrupts(event.outcome), usage: readUsage(event.usage) };
    case EventType.RUN_ERROR:
      return { ...frame, isFinished: true, errorCode: event.code ?? event.message, usage: readUsage(event.usage) };
    default:
      return frame;
  }
}

/** The invalidation keys a tool result names, for the rest of the console to refresh. */
export function invalidatedKeys(event: AgentEvent): string[] {
  if (event.type !== EventType.TOOL_CALL_RESULT) return [];
  return parseReceipt(event.content).invalidates ?? [];
}
