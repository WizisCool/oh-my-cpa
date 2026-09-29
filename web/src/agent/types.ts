/**
 * The Agent's stored document, as the server persists and returns it.
 *
 * These types belong to OMC rather than to any UI framework or wire protocol: the server's
 * `internal/agent` package defines the shape, the AG-UI stream carries it as a `STATE_SNAPSHOT`,
 * and the page renders it. A change of chat framework or transport leaves this module alone.
 */

/** The executor envelope a capability returns, as the agent sees it. */
export interface CapabilityReceipt {
  status: string;
  code?: string;
  /** What to change, for a refusal its author can act on - a query naming an unreadable column. */
  detail?: string;
  data?: unknown;
  operation_id?: string;
  invalidates?: string[];
}

/** A frozen display dataset (ADR 0042), stored on the call that drew it. */
export interface DisplayView {
  kind: 'chart' | 'table';
  title: string;
  chart?: {
    type: 'line' | 'area' | 'column' | 'bar' | 'pie';
    x: string;
    y: string[];
    series?: string;
    unit?: string;
  };
  columns: string[];
  rows: Record<string, string | number | boolean | null>[];
  source?: { call_id: string; path?: string };
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
  prompt_version?: string;
}

export interface Conversation {
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
export const DISPLAY_TOOLS = ['render_chart', 'render_table'] as const;
export type DisplayToolName = typeof DISPLAY_TOOLS[number];

export function isDisplayTool(name: string): name is DisplayToolName {
  return (DISPLAY_TOOLS as readonly string[]).includes(name);
}

/** The run budget the server enforces, shown as "round n of 8". */
export const MAX_TURN_ROUNDS = 8;
