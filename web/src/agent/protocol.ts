import { EventType } from '@ag-ui/core';
import type {
  ReasoningEndEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningStartEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from '@ag-ui/core';

/**
 * The AG-UI events OMC's Agent emits (ADR 0041). Types come from `@ag-ui/core`; only its type
 * declarations and the `EventType` enum are used, so the protocol's runtime validators never reach
 * the bundle. Validation here is the narrower check this console needs: a known type carrying the
 * fields the reducer reads.
 */
export type AgentEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent;

export const AGENT_PROTOCOL_VERSION = '1.0';

/** The fields each event must carry as strings for the reducer to read it. */
const REQUIRED_STRINGS: Partial<Record<EventType, readonly string[]>> = {
  [EventType.RUN_STARTED]: ['threadId', 'runId'],
  [EventType.RUN_FINISHED]: ['threadId', 'runId'],
  [EventType.RUN_ERROR]: ['message'],
  [EventType.STEP_STARTED]: ['stepName'],
  [EventType.STEP_FINISHED]: ['stepName'],
  [EventType.TEXT_MESSAGE_START]: ['messageId'],
  [EventType.TEXT_MESSAGE_CONTENT]: ['messageId', 'delta'],
  [EventType.TEXT_MESSAGE_END]: ['messageId'],
  [EventType.REASONING_START]: ['messageId'],
  [EventType.REASONING_MESSAGE_START]: ['messageId'],
  [EventType.REASONING_MESSAGE_CONTENT]: ['messageId', 'delta'],
  [EventType.REASONING_MESSAGE_END]: ['messageId'],
  [EventType.REASONING_END]: ['messageId'],
  [EventType.TOOL_CALL_START]: ['toolCallId', 'toolCallName'],
  [EventType.TOOL_CALL_ARGS]: ['toolCallId', 'delta'],
  [EventType.TOOL_CALL_END]: ['toolCallId'],
  [EventType.TOOL_CALL_RESULT]: ['toolCallId', 'content'],
  [EventType.STATE_SNAPSHOT]: [],
};

/** Parses one frame, refusing an event this build does not render rather than guessing at it. */
export function parseAgentEvent(raw: string): AgentEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const required = REQUIRED_STRINGS[record.type as EventType];
  if (!required || !required.every(field => typeof record[field] === 'string')) return undefined;
  if (record.type === EventType.STATE_SNAPSHOT && (typeof record.snapshot !== 'object' || record.snapshot === null)) return undefined;
  return value as AgentEvent;
}

/**
 * The OMC part of a run request: the stored revision the page last saw, and the key, model and
 * effort to run with. Everything else a run needs the server already holds.
 */
export interface AgentForwardedProps {
  revision: number;
  model: string;
  client_key_fingerprint: string;
  reasoning_effort?: string;
  /** The newest turn this message takes the place of: a retry or an edit. */
  replace_turn?: string;
}

export interface AgentRunRequest {
  threadId: string;
  runId: string;
  /** The new message; absent when the run resumes interrupts. */
  message?: { id: string; content: string };
  /** The display tools this console can draw. */
  tools: readonly { name: string; description: string }[];
  /** The console's reading language. */
  language?: string;
  /** Where the operator is, as allowlisted context entries (ADR 0073). */
  page?: readonly { description: string; value: string }[];
  forwardedProps: AgentForwardedProps;
  /** The interrupts this run continues from, each already decided through the decision endpoint. */
  resume?: readonly { interruptId: string; status: 'resolved' | 'cancelled' }[];
}

/**
 * Builds the `RunAgentInput` a run posts. At most one user message and never any history, state
 * or tool result: the server owns the conversation and refuses a request that tries to supply it.
 */
export function buildRunInput(request: AgentRunRequest): RunAgentInput & { protocolVersion: string } {
  return {
    threadId: request.threadId,
    runId: request.runId,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    messages: request.message ? [{ id: request.message.id, role: 'user', content: request.message.content }] : [],
    tools: request.tools.map(tool => ({ name: tool.name, description: tool.description })),
    context: [...(request.language ? [{ description: 'console_language', value: request.language }] : []), ...(request.page ?? [])],
    forwardedProps: request.forwardedProps,
    ...(request.resume?.length ? { resume: request.resume.map(entry => ({ ...entry })) } : {}),
  };
}

