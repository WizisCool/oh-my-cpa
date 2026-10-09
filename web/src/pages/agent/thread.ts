import { splitAttachedFiles } from './attachments';
import type { AttachedFile } from './attachments';
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react';
import type { RunFrame } from '../../agent/runReducer';
import type { Conversation, Presentation, Trace, Turn, TurnPart } from '../../agent/types';
import { getAppConfig } from '../../types/config';
import { extractThinking } from '../playground/state';
import { ASK_QUESTION, turnParts } from './state';

/**
 * The Agent transcript as assistant-ui messages.
 *
 * This is the one place the stored turns and the live run become the chat framework's shape, and
 * it is pure: the page's state stays OMC's own (ADR 0041), and swapping the framework rewrites this
 * module and the views, never the state or the protocol.
 *
 * Message ids are the turn's own, so the live turn - once `RUN_STARTED` names it - and the stored
 * turn that replaces it are the same message and nothing remounts when the run ends.
 */

type MessagePart = Exclude<ThreadMessageLike['content'], string>[number];
type ToolCallPart = Extract<MessagePart, { type: 'tool-call' }>;

/** What the page knows about the run in flight. */
export interface LiveRun {
  frame: RunFrame;
  pendingMessage: string;
  pendingImages: readonly string[];
  /** The stored turn the run's message replaces. */
  replacedTurnID: string;
  isResuming: boolean;
}

/** The fields of a stored turn the message's own views read, carried in its metadata. */
export interface AgentMessageCustom {
  turn?: Turn;
  /** Files that came with a user message. */
  files?: AttachedFile[];
  /** The presentation a command asked this message's answer to take. */
  present?: Presentation;
  /** Where each image sent with a user message is read from. */
  images?: string[];
  isLive?: boolean;
  [key: string]: unknown;
}

/**
 * A stored turn with the live run's output folded in. A resumed run reports the call it stopped on
 * again with its outcome; that call is already a step of the stored turn, so its result updates the
 * step rather than adding a second one.
 */
export function mergeLiveTurn(turn: Turn | undefined, frame: RunFrame): { parts: TurnPart[]; traces: Trace[] } {
  const stored = turn && !frame.hasAuthoritativeParts ? turnParts(turn) : [];
  const storedCalls = new Set(stored.flatMap(part => (part.type === 'tool' && part.trace_id ? [part.trace_id] : [])));
  const parts = [...stored, ...frame.parts.filter(part => part.type !== 'tool' || !storedCalls.has(part.trace_id ?? ''))];
  const traces = new Map<string, Trace>();
  for (const trace of turn?.traces ?? []) traces.set(trace.id, trace);
  for (const trace of frame.traces) {
    const earlier = traces.get(trace.id);
    traces.set(trace.id, earlier
      ? { ...earlier, ...trace, name: trace.name || earlier.name, arguments: trace.arguments || earlier.arguments, started_at_ms: trace.started_at_ms ?? earlier.started_at_ms }
      : trace);
  }
  return { parts, traces: [...traces.values()] };
}

function parseArguments(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const FAILED_STATUSES = new Set(['error', 'rejected', 'expired']);

/**
 * One call as a tool-call part. A call waiting on the operator carries the framework's own
 * human-in-the-loop marker: `approval` for a change to allow or deny (with private input when the
 * operation asks for it), `interrupt` for the agent's question.
 */
export function toolCallPart(trace: Trace, isOpen: boolean): ToolCallPart {
  const isRunning = trace.result.status === 'running';
  const isPending = trace.result.status === 'pending' && !!trace.result.operation_id;
  const isQuestion = trace.name === ASK_QUESTION;
  return {
    type: 'tool-call',
    toolCallId: trace.id,
    toolName: trace.name,
    argsText: trace.arguments ?? '',
    args: parseArguments(trace.arguments) as ToolCallPart['args'],
    // A call waiting on the operator has no result yet: it stays `requires-action` until decided.
    ...(isRunning || isPending ? {} : { result: trace.result, isError: FAILED_STATUSES.has(trace.result.status) }),
    ...(trace.view ? { artifact: trace.view } : {}),
    ...(trace.started_at_ms ? { timing: { startedAt: trace.started_at_ms, ...(trace.ended_at_ms ? { completedAt: trace.ended_at_ms } : {}) } } : {}),
    ...(isRunning || isPending ? {} : { modelContent: [{ type: 'text' as const, text: JSON.stringify(trace.result) }] }),
    ...(isPending && isOpen && !isQuestion ? { approval: { id: trace.result.operation_id as string } } : {}),
    ...(isPending && isOpen && isQuestion ? { interrupt: { type: 'human' as const, payload: { operation_id: trace.result.operation_id } } } : {}),
  };
}

/** A turn's parts as message parts, in the order the model produced them. */
export function assistantContent(parts: TurnPart[], traces: Trace[], isOpen: boolean): MessagePart[] {
  const byID = new Map(traces.map(trace => [trace.id, trace]));
  return parts.flatMap((part): MessagePart[] => {
    if (part.type === 'tool') {
      const trace = part.trace_id ? byID.get(part.trace_id) : undefined;
      return trace ? [toolCallPart(trace, isOpen)] : [];
    }
    if (!part.content) return [];
    if (part.type === 'thought') return [{ type: 'reasoning', text: part.content }];
    // A provider that reasons inline in `<think>` tags has that part shown as reasoning.
    const inline = extractThinking(part.content);
    return [
      ...(inline.thought ? [{ type: 'reasoning' as const, text: inline.thought }] : []),
      ...(inline.reply ? [{ type: 'text' as const, text: inline.reply }] : []),
    ];
  });
}

/** How a stored turn ended, in the framework's terms; a stopped run is incomplete, not failed. */
export function turnMessageStatus(turn: Turn): NonNullable<ThreadMessageLike['status']> {
  switch (turn.status) {
    case 'success':
      return { type: 'complete', reason: 'stop' };
    case 'pending':
      return { type: 'requires-action', reason: 'interrupt' };
    case 'error':
      return turn.code === 'cancelled'
        ? { type: 'incomplete', reason: 'cancelled' }
        : { type: 'incomplete', reason: 'error', error: turn.code ?? 'operation_failed' };
    case 'running':
      return { type: 'running' };
    default:
      return { type: 'incomplete', reason: 'other', error: turn.code ?? turn.status };
  }
}

/** The operator's message: their words as its text, the files sent with them named beside it. */
function userMessage(id: string, sent: string, present?: Presentation, images: readonly string[] = []): ThreadMessageLike {
  const { text, files } = splitAttachedFiles(sent);
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    ...(files.length || present || images.length ? { metadata: { custom: { files, present, images: [...images] } satisfies AgentMessageCustom } } : {}),
  };
}

/** Where a stored image is read from; it is served only while the conversation references it. */
export function agentImageURL(id: string): string {
  return `${getAppConfig().apiBaseUrl}/agent/images/${encodeURIComponent(id)}`;
}

/** The stored turns, one user and one assistant message each. */
export function storedMessages(turns: Turn[]): ThreadMessageLike[] {
  return turns.flatMap((turn, index) => {
    const isLast = index === turns.length - 1;
    return [
      userMessage(`${turn.id}:user`, turn.user, turn.present, turn.images?.map(image => agentImageURL(image.id))),
      {
        id: `${turn.id}:assistant`,
        role: 'assistant' as const,
        content: assistantContent(turnParts(turn), turn.traces, isLast && turn.status === 'pending'),
        status: turnMessageStatus(turn),
        metadata: { custom: { turn } satisfies AgentMessageCustom },
      },
    ];
  });
}

/**
 * The transcript with the run in flight appended: a new message's turn after the stored ones, or a
 * resumed turn continued in place.
 */
export function agentThreadMessages(conversation: Conversation | undefined, stored: ThreadMessageLike[], live: LiveRun | undefined): ThreadMessageLike[] {
  if (!live) return stored;
  const turns = conversation?.turns ?? [];
  const lastTurn = turns.at(-1);
  if (live.isResuming && lastTurn) {
    const merged = mergeLiveTurn(lastTurn, live.frame);
    return [
      ...stored.slice(0, -1),
      {
        id: `${lastTurn.id}:assistant`,
        role: 'assistant',
        content: assistantContent(merged.parts, merged.traces, false),
        status: { type: 'running' },
        metadata: { custom: { turn: lastTurn, isLive: true } satisfies AgentMessageCustom },
      },
    ];
  }
  // A retry or an edit keeps the replaced turn's images, which the server already holds.
  const replaced = live.replacedTurnID ? turns.find(turn => turn.id === live.replacedTurnID) : undefined;
  const images = live.pendingImages.length ? live.pendingImages : replaced?.images?.map(image => agentImageURL(image.id)) ?? [];
  const turnID = live.frame.turnId || 'live';
  const merged = mergeLiveTurn(undefined, live.frame);
  return [
    ...stored,
    ...(live.pendingMessage || images.length ? [userMessage(`${turnID}:user`, live.pendingMessage, undefined, images)] : []),
    {
      id: `${turnID}:assistant`,
      role: 'assistant',
      content: assistantContent(merged.parts, merged.traces, false),
      status: { type: 'running' },
      metadata: { custom: { isLive: true } satisfies AgentMessageCustom },
    },
  ];
}

/**
 * The text a message sends. A quoted passage - "ask about this" on a selection of an answer -
 * travels as a Markdown quote ahead of the question, which is how the model reads it.
 */
export function appendMessageText(message: AppendMessage): string {
  const typed = message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n').trim();
  // Attached files follow the operator's words, each already a `<file>` block (ADR 0074).
  const files = (message.attachments ?? []).flatMap(attachment => attachment.content.flatMap(part => (part.type === 'text' ? [part.text] : [])));
  const text = [typed, ...files].filter(Boolean).join('\n\n');
  return quotedText(message, text);
}

/** The images a message sends, as the data URLs the attachment adapter read them into. */
export function appendMessageImages(message: AppendMessage): string[] {
  return (message.attachments ?? []).flatMap(attachment => attachment.content.flatMap(part => (part.type === 'image' ? [part.image] : [])));
}

function quotedText(message: AppendMessage, text: string): string {
  const quote = (message.metadata?.custom as { quote?: { text?: string } } | undefined)?.quote?.text?.trim();
  if (!quote) return text;
  return `${quote.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\n${text}`;
}
