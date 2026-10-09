import { answerLayout } from './answerLayout';
import { argumentSummary, callDuration, statusTone } from './callFacts';
import type { Conversation, DisplayView, Presentation, Trace, TurnPart } from './types';
import type { Turn as PlaygroundTurn } from '../pages/playground/state';
import { effectiveModel } from '../types/requestModel';
import { extractThinking } from '../utils/thinking';

/** One capability call as its row states it, and what opening the row shows. */
export interface SnapshotCall {
  name: string;
  status: string;
  code?: string;
  detail?: string;
  tone: ReturnType<typeof statusTone>;
  /** The arguments in brief, as the row carries them. */
  summary: string;
  duration?: number;
  startedAt?: number;
  arguments: string;
  result?: string;
}
export type SnapshotStep = { kind: 'thought'; text: string } | ({ kind: 'call' } & SnapshotCall);
/** A block of an answer in reading order: the same blocks the conversation draws (`answerLayout`). */
export type SnapshotSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'chain'; steps: SnapshotStep[] }
  | { kind: 'figure'; view: DisplayView }
  | ({ kind: 'call' } & SnapshotCall);
export interface SnapshotTurn {
  user: string;
  images: string[];
  segments: SnapshotSegment[];
  status: string;
  code?: string;
  model: string;
  startedAt?: number;
  duration?: number;
  usage?: Record<string, number | undefined>;
  parameters?: Record<string, unknown>;
  /** The presentation a composer command asked of the answer, named above the message. */
  present?: Presentation;
  rounds?: number;
  calls?: number;
}
export interface ConversationSnapshot {
  /** Which workspace's turn anatomy the copy follows: the Playground names the model above each answer. */
  layout: 'agent' | 'playground';
  turns: SnapshotTurn[];
  omitted: number;
}

// These are execution identities, not transcript facts. Custom bodies and receipts can nest them.
const PRIVATE_FIELDS = /^(?:client_key_fingerprint|api_key|api_keys|access_token|refresh_token|id_token|authorization|password|secret|management_key|operation_id|active_run_id)$/i;
export function snapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshotValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_FIELDS.test(key)).map(([key, item]) => [key, snapshotValue(item)]));
  return value;
}
function snapshotJSON(value: unknown): string {
  return JSON.stringify(snapshotValue(value), null, 2) ?? '';
}

function snapshotCall(trace: Trace): SnapshotCall {
  let argumentsText = trace.arguments ?? '';
  try { argumentsText = snapshotJSON(JSON.parse(argumentsText)); } catch { /* Incomplete argument text remains evidence. */ }
  return {
    name: trace.name, status: trace.result.status, code: trace.result.code, detail: trace.result.detail,
    tone: statusTone(trace.result.status, trace.result.code),
    // Read from the filtered arguments, so the row cannot name a field the detail leaves out.
    summary: argumentSummary(argumentsText), duration: callDuration(trace), startedAt: trace.started_at_ms,
    arguments: argumentsText || '{}',
    // SQL rows and pending-operation internals are not offered by the call's own disclosure either.
    result: trace.name === 'database_query' || ['running', 'pending'].includes(trace.result.status) ? undefined :
      snapshotJSON({ status: trace.result.status, code: trace.result.code, detail: trace.result.detail, data: trace.result.data }),
  };
}

/**
 * Project the displayed contract, never the persisted session or a live operation handle. A stored
 * image is a reference; `imageData` carries the bytes of those the caller read, as data URLs, so an
 * exported file shows them without the console behind it.
 */
export function agentSnapshot(conversation: Conversation, imageData: ReadonlyMap<string, string> = new Map()): ConversationSnapshot {
  return {
    layout: 'agent',
    omitted: conversation.omitted,
    turns: conversation.turns.map(turn => {
      const parts: TurnPart[] = turn.parts?.length ? turn.parts : [
        ...turn.traces.map(trace => ({ type: 'tool' as const, trace_id: trace.id })),
        ...(turn.reply ? [{ type: 'text' as const, content: turn.reply }] : []),
      ];
      return {
        // One entry per stored image: bytes the caller could read, otherwise a placeholder the
        // export draws as "image omitted" rather than silently dropping what the operator sent.
        user: turn.user, images: (turn.images ?? []).map(image => imageData.get(image.id) ?? ''), status: turn.status, code: turn.code,
        model: conversation.model, startedAt: turn.started_at_ms,
        duration: turn.ended_at_ms !== undefined && turn.started_at_ms !== undefined ? turn.ended_at_ms - turn.started_at_ms : undefined,
        usage: turn.usage ? { ...turn.usage } : undefined,
        present: turn.present, rounds: turn.rounds, calls: turn.traces.length,
        segments: answerLayout(parts, turn.traces).map<SnapshotSegment>(segment => {
          switch (segment.kind) {
            case 'chain':
              return { kind: 'chain', steps: segment.steps.map(step => step.kind === 'call' ? { kind: 'call', ...snapshotCall(step.trace) } : step) };
            case 'figure':
              return { kind: 'figure', view: snapshotValue(segment.trace.view) as DisplayView };
            case 'call':
              return { kind: 'call', ...snapshotCall(segment.trace) };
            default:
              return segment;
          }
        }),
      };
    }),
  };
}

/** The figures a snapshot draws, in reading order. */
export function snapshotViews(snapshot: ConversationSnapshot): DisplayView[] {
  return snapshot.turns.flatMap(turn => turn.segments.flatMap(segment => segment.kind === 'figure' ? [segment.view] : []));
}

/** Keep each turn's original parameters; the current composer can name a different request. */
export function playgroundSnapshot(turns: readonly PlaygroundTurn[]): ConversationSnapshot {
  return { layout: 'playground', omitted: 0, turns: turns.map(turn => {
    // The same rule PlaygroundTurn draws by: a reasoning channel, even an empty one, means the reply carries no inline thinking.
    const inline = extractThinking(turn.reply);
    const thought = turn.thought ?? inline.thought;
    return {
      user: turn.user.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'),
      images: turn.user.content.flatMap(part => part.type === 'image_url' ? [part.image_url.url] : []),
      segments: [...(thought ? [{ kind: 'thought' as const, text: thought }] : []), { kind: 'text' as const, text: turn.thought !== undefined ? turn.reply : inline.reply }],
      status: turn.status, code: turn.error?.code, model: effectiveModel(turn.request),
      startedAt: turn.serverStartedAt ?? turn.startedAt, duration: turn.durationMS,
      usage: turn.usage ? { ...turn.usage } : undefined,
      parameters: snapshotValue({ system_prompt: turn.request.system_prompt, temperature: turn.request.temperature,
        top_p: turn.request.top_p, max_tokens: turn.request.max_tokens, reasoning_effort: turn.request.reasoning_effort,
        user_agent: turn.request.user_agent, custom_body: turn.request.custom_body }) as Record<string, unknown>,
    };
  }) };
}

export interface ImageSlice { top: number; height: number }
// The console's own reading column plus a share card's margins: text stays legible when the image is scaled to a phone.
export const SNAPSHOT_IMAGE_WIDTH = 840;
export const SNAPSHOT_IMAGE_PAGE_HEIGHT = 4096;
export const SNAPSHOT_IMAGE_SCALE = 2;

/**
 * Bounded canvases, without dropping the tail of a long transcript. A page ends at the last block
 * boundary that fits, so a cut falls between paragraphs instead of through a line of text; a block
 * taller than half a page is cut where the page ends, which keeps every page worth its download.
 */
export function snapshotImageSlices(height: number, boundaries: readonly number[] = []): ImageSlice[] {
  if (!Number.isFinite(height) || height <= 0) throw new Error('Invalid snapshot height');
  const total = Math.ceil(height);
  const candidates = [...new Set(boundaries.map(Math.floor))].filter(boundary => boundary > 0 && boundary < total).sort((left, right) => left - right);
  const slices: ImageSlice[] = [];
  for (let top = 0; top < total;) {
    const limit = top + SNAPSHOT_IMAGE_PAGE_HEIGHT;
    let end = Math.min(limit, total);
    if (limit < total) end = candidates.filter(boundary => boundary <= limit && boundary >= top + SNAPSHOT_IMAGE_PAGE_HEIGHT / 2).at(-1) ?? limit;
    slices.push({ top, height: end - top });
    top = end;
  }
  return slices;
}
