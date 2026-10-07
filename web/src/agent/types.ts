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

/** A frozen display (ADR 0042, 0071, 0072), stored on the call that drew it. */
export interface DisplayView {
  kind: 'chart' | 'table' | 'panel' | 'canvas';
  title: string;
  chart?: {
    type: 'line' | 'area' | 'column' | 'bar' | 'pie';
    x: string;
    y: string[];
    series?: string;
    unit?: string;
    stacked?: boolean;
  };
  columns: string[];
  rows: Record<string, string | number | boolean | null>[];
  source?: { call_id: string; path?: string };
  /** A panel's blocks: the model's own statements, laid out by the console. */
  blocks?: ViewBlock[];
  /** A canvas's markup, only ever drawn inside a sandboxed frame. */
  html?: string;
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

export interface Turn {
  id: string;
  user: string;
  /** Every round's answer text as one document, which is what copying the answer takes. */
  reply: string;
  parts?: TurnPart[];
  status: string;
  code?: string;
  traces: Trace[];
  rounds?: number;
  calls?: number;
  started_at_ms?: number;
  ended_at_ms?: number;
  usage?: TurnUsage;
  /** Follow-up questions the model offered with a finished answer. */
  suggestions?: string[];
  prompt_version?: string;
}

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
export const DISPLAY_TOOLS = ['render_chart', 'render_table', 'render_view', 'render_canvas'] as const;
export type DisplayToolName = typeof DISPLAY_TOOLS[number];
/**
 * Everything a run declares: the tools that draw, plus `suggest_next`, which draws nothing in the
 * transcript - the server keeps its questions on the turn instead of making it a call.
 */
export const DECLARED_TOOLS = [...DISPLAY_TOOLS, 'suggest_next'] as const;

export function isDisplayTool(name: string): name is DisplayToolName {
  return (DISPLAY_TOOLS as readonly string[]).includes(name);
}

/** Only a successful turn publishes figures; other traces remain inspectable as work in progress. */
export function completedDisplayViews(turn: Pick<Turn, 'status' | 'traces'> | undefined): Trace[] {
  if (turn?.status !== 'success') return [];
  return turn.traces.filter(trace => isDisplayTool(trace.name) && trace.result.status === 'success' && !!trace.view);
}
