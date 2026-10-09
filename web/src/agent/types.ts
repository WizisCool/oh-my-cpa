/**
 * The Agent's console document, projected from the server's stored conversation.
 *
 * These types belong to OMC rather than to any UI framework or wire protocol: the server's
 * API projects the stored `internal/agent` conversation, AG-UI carries it as a `STATE_SNAPSHOT`,
 * and the page renders it. A change of chat framework or transport leaves this module alone.
 */

/** The console's capability receipt; raw database query data remains server-side. */
export interface CapabilityReceipt {
  status: string;
  code?: string;
  /** What to change, for a refusal its author can act on - a query naming an unreadable column. */
  detail?: string;
  data?: unknown;
  operation_id?: string;
  invalidates?: string[];
}

export const BLOCK_TYPES = ['stats', 'fields', 'callout', 'steps', 'meters', 'links'] as const;
export type ViewTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** One entry of a panel block; which fields are present follows the block's type. */
export interface ViewItem {
  label: string;
  value?: string;
  delta?: string;
  tone?: ViewTone;
  /** A Lucide icon name, or `brand:<maker>`; resolved by the console, unknown names draw a neutral mark. */
  icon?: string;
  text?: string;
  status?: 'done' | 'active' | 'pending' | 'failed';
  share?: number;
  /** A console page from the server's closed set, relative to the console's base path. */
  route?: string;
}

export interface ViewBlock {
  type: typeof BLOCK_TYPES[number];
  title?: string;
  tone?: ViewTone;
  text?: string;
  items?: ViewItem[];
}

/**
 * A frozen display (ADR 0042, 0072, 0079), stored on the call that drew it. A stored conversation
 * may still hold a kind this console no longer draws (ADR 0073); `completedDisplayViews` leaves
 * those out.
 */
export interface DisplayView {
  kind: 'panel' | 'canvas' | 'ui';
  title: string;
  columns: string[];
  rows: Record<string, string | number | boolean | null>[];
  source?: { call_id: string; path?: string; data_ref?: string };
  /** A panel's blocks: the model's own statements, laid out by the console. */
  blocks?: ViewBlock[];
  /** A canvas's markup, only ever drawn inside a sandboxed frame. */
  html?: string;
  icons?: string[];
  /** `none` draws the view straight on the conversation, without the figure's frame and title. */
  frame?: 'card' | 'none';
}

export interface Trace {
  id: string;
  name: string;
  /** The model's own argument text, kept so the operator can audit what was requested. */
  arguments?: string;
  result: CapabilityReceipt;
  started_at_ms?: number;
  ended_at_ms?: number;
  view?: DisplayView;
}

/**
 * One step of a turn in the order the model produced it: reasoning, answer text, or a capability
 * call named by its trace. A model may reason, answer, call tools and answer again in one turn.
 */
export interface TurnPart {
  type: 'thought' | 'text' | 'tool';
  content?: string;
  trace_id?: string;
}

export interface TurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** The last round's input: what the conversation occupied of the context window. */
  context_tokens?: number;
}

export interface RunFailure {
  code: string;
  upstream_status?: number;
  parameter?: string;
  attempts?: number;
  retry_exhausted?: boolean;
}

export interface Turn {
  id: string;
  user: string;
  /** Every round's answer text as one document, which is what copying the answer takes. */
  reply: string;
  parts?: TurnPart[];
  status: string;
  code?: string;
  failure?: RunFailure;
  traces: Trace[];
  rounds?: number;
  calls?: number;
  started_at_ms?: number;
  ended_at_ms?: number;
  usage?: TurnUsage;
  /** Follow-up questions the model offered with a finished answer. */
  suggestions?: string[];
  prompt_version?: string;
  /** The presentation a composer command asked this turn's answer to take. */
  present?: Presentation;
  /** Images sent with the message, by reference: the bytes are read from the image endpoint. */
  images?: TurnImage[];
}

export interface TurnImage {
  id: string;
  media_type: string;
  bytes: number;
}

/** What `/ui` and `/text` ask of one answer; stored turns may carry `canvas`. */
export type Presentation = 'ui' | 'canvas' | 'text';

export interface Conversation {
  active_run_id?: string;
  id: string;
  revision: number;
  model: string;
  client_key_fingerprint: string;
  reasoning_effort?: string;
  turns: Turn[];
  omitted: number;
  anchor_ms?: number;
}

/** Why a run stopped for the operator, as the interrupt names it. */
export type InterruptReason = 'approval' | 'question' | 'secret' | 'oauth';

/** A pending operation the run stopped on: one AG-UI interrupt. */
export interface AgentInterrupt {
  /** The operation id; the decision endpoint takes it. */
  id: string;
  reason: InterruptReason;
  /** The call that raised it. */
  toolCallId?: string;
  expiresAt?: string;
  capability?: string;
  permission?: string;
}

/** The display tools this console can draw; declared on every run (ADR 0042). */
export const DISPLAY_TOOLS = ['render_view', 'render_ui', 'render_canvas'] as const;
export type DisplayToolName = typeof DISPLAY_TOOLS[number];
/**
 * Everything a run declares: the tools that draw, plus `suggest_next`, which draws nothing in the
 * transcript - the server keeps its questions on the turn instead of making it a call.
 */
export const DECLARED_TOOLS = ['render_ui', 'suggest_next'] as const;

export function isDisplayTool(name: string): name is DisplayToolName {
  return (DISPLAY_TOOLS as readonly string[]).includes(name);
}

function isDrawableView(view: DisplayView | undefined): view is DisplayView {
  return view?.kind === 'panel' || view?.kind === 'canvas' || view?.kind === 'ui';
}

/**
 * How a display call is drawn where the model made it: the figure once it has settled, a draft
 * while its arguments are still arriving, and an ordinary call row when it failed or holds a kind
 * this console no longer draws, so a refusal is never an invisible gap in the answer.
 */
export function displayCallStage(trace: Trace): 'figure' | 'draft' | 'row' {
  if (trace.result.status === 'success' && isDrawableView(trace.view)) return 'figure';
  return trace.result.status === 'running' && !trace.view ? 'draft' : 'row';
}

/**
 * The title of a display call whose arguments are still arriving. The text is a JSON prefix, so
 * it cannot be parsed as a document; the title is read once its own string has closed.
 */
export function draftViewTitle(argumentsText: string | undefined): string {
  const match = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(argumentsText ?? '');
  if (!match) return '';
  try {
    const title: unknown = JSON.parse(match[1]);
    return typeof title === 'string' ? title.trim() : '';
  } catch {
    return '';
  }
}

/**
 * The markup of a display call whose arguments are still arriving: the `html` string as far as it
 * has been written. The text is a JSON prefix, so the string is cut back to its last whole
 * character - an escape may have been split by the stream - and decoded on its own.
 */
export function draftViewHTML(argumentsText: string | undefined): string {
  const match = /"html"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argumentsText ?? '');
  if (!match) return '';
  // A `\uXXXX` escape is six characters, so at most five have to go before the rest decodes.
  for (let cut = 0; cut <= 5 && cut <= match[1].length; cut++) {
    try {
      const html: unknown = JSON.parse(`"${match[1].slice(0, match[1].length - cut)}"`);
      if (typeof html === 'string') return html;
    } catch {
      // Still inside an escape: drop one more character.
    }
  }
  return '';
}

/** New UI drafts use the inline default; older display-tool drafts keep their own card geometry. */
export function isDraftViewFrameless(argumentsText: string | undefined, toolName = 'render_ui'): boolean {
  const frame = /"frame"\s*:\s*"(none|card)"/.exec(argumentsText ?? '');
  return frame ? frame[1] === 'none' : toolName === 'render_ui';
}

/** A successful display is usable immediately, independently of the enclosing turn's status. */
export function completedDisplayViews(turn: Pick<Turn, 'status' | 'traces'> | undefined): Trace[] {
  if (!turn) return [];
  return turn.traces.filter(trace => isDisplayTool(trace.name) && displayCallStage(trace) === 'figure');
}
