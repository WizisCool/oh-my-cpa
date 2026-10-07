import { completedDisplayViews } from './types';
import type { Conversation, DisplayView, TurnPart } from './types';
import type { Turn as PlaygroundTurn } from '../pages/playground/state';
import { effectiveModel, extractThinking } from '../pages/playground/state';

export interface SnapshotBlock {
  kind: 'text' | 'thought' | 'call';
  text: string;
  name?: string;
  status?: string;
  arguments?: string;
  result?: string;
}
export interface SnapshotTurn {
  user: string;
  images: string[];
  blocks: SnapshotBlock[];
  status: string;
  code?: string;
  model: string;
  startedAt?: number;
  duration?: number;
  usage?: Record<string, number | undefined>;
  parameters?: Record<string, unknown>;
  views: DisplayView[];
}
export interface ConversationSnapshot {
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

/** Project the displayed contract, never the persisted session or a live operation handle. */
export function agentSnapshot(conversation: Conversation): ConversationSnapshot {
  return {
    omitted: conversation.omitted,
    turns: conversation.turns.map(turn => {
      const traces = new Map(turn.traces.map(trace => [trace.id, trace]));
      const parts: TurnPart[] = turn.parts?.length ? turn.parts : [
        ...turn.traces.map(trace => ({ type: 'tool' as const, trace_id: trace.id })),
        ...(turn.reply ? [{ type: 'text' as const, content: turn.reply }] : []),
      ];
      return {
        user: turn.user, images: [], status: turn.status, code: turn.code,
        model: conversation.model, startedAt: turn.started_at_ms,
        duration: turn.ended_at_ms !== undefined && turn.started_at_ms !== undefined ? turn.ended_at_ms - turn.started_at_ms : undefined,
        usage: turn.usage ? { ...turn.usage } : undefined,
        blocks: parts.flatMap<SnapshotBlock>(part => {
          if (part.type !== 'tool') return [{ kind: part.type === 'thought' ? 'thought' as const : 'text' as const, text: part.content ?? '' }];
          const trace = traces.get(part.trace_id ?? '');
          if (!trace) return [];
          let argumentsText = trace.arguments ?? '';
          try { argumentsText = snapshotJSON(JSON.parse(argumentsText)); } catch { /* Incomplete argument text remains evidence. */ }
          return [{ kind: 'call' as const, text: trace.name, name: trace.name, status: trace.result.status,
            arguments: argumentsText,
            // SQL rows and pending-operation internals are not offered by CallDetails either.
            result: trace.name === 'database_query' || ['running', 'pending'].includes(trace.result.status) ? undefined :
              snapshotJSON({ status: trace.result.status, code: trace.result.code, detail: trace.result.detail, data: trace.result.data }),
          }];
        }),
        views: completedDisplayViews(turn).map(trace => snapshotValue(trace.view) as DisplayView),
      };
    }),
  };
}

/** Keep each turn's original parameters; the current composer can name a different request. */
export function playgroundSnapshot(turns: readonly PlaygroundTurn[]): ConversationSnapshot {
  return { omitted: 0, turns: turns.map(turn => ({
    user: turn.user.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'),
    images: turn.user.content.flatMap(part => part.type === 'image_url' ? [part.image_url.url] : []),
    blocks: [...((turn.thought ?? extractThinking(turn.reply).thought) ? [{ kind: 'thought' as const, text: turn.thought ?? extractThinking(turn.reply).thought! }] : []), { kind: 'text' as const, text: turn.thought !== undefined ? turn.reply : extractThinking(turn.reply).reply }],
    status: turn.status, code: turn.error?.code, model: effectiveModel(turn.request),
    startedAt: turn.serverStartedAt ?? turn.startedAt, duration: turn.durationMS,
    usage: turn.usage ? { ...turn.usage } : undefined,
    parameters: snapshotValue({ system_prompt: turn.request.system_prompt, temperature: turn.request.temperature,
      top_p: turn.request.top_p, max_tokens: turn.request.max_tokens, reasoning_effort: turn.request.reasoning_effort,
      user_agent: turn.request.user_agent, custom_body: turn.request.custom_body }) as Record<string, unknown>,
    views: [],
  })) };
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
