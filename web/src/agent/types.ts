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

export interface Trace {
  id: string;
  name: string;
  /** The model's own argument text, kept so the operator can audit what was requested. */
  arguments?: string;
  result: CapabilityReceipt;
  started_at_ms?: number;
  ended_at_ms?: number;
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
  prompt_version?: string;
  /** The presentation a composer command asked this turn's answer to take; stored turns may carry
   *  the retired `ui` and `canvas`, which no longer change anything. */
  present?: string;
  /** Images sent with the message, by reference: the bytes are read from the image endpoint. */
  images?: TurnImage[];
}

export interface TurnImage {
  id: string;
  media_type: string;
  bytes: number;
}

/** What `/text` asks of one answer: Markdown instead of the default OpenUI interface. */
export type Presentation = 'text';

export interface Conversation {
  active_run_id?: string;
  id: string;
  revision: number;
  model: string;
  client_key_fingerprint: string;
  reasoning_effort?: string;
  /** The inference endpoint the conversation's rounds are sent to; absent for Chat Completions. */
  endpoint?: string;
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

/**
 * The official OpenUI assistant-ui tools (ADR 0088): `present_openui` is the answer itself and
 * `prompt_openui` a form the turn waits on. The console declares `present_openui` on every run - it
 * renders OpenUI - and the server offers `prompt_openui` alongside it.
 */
export const PRESENT_OPENUI = 'present_openui';
export const PROMPT_OPENUI = 'prompt_openui';
export const DECLARED_TOOLS = [PRESENT_OPENUI] as const;

export function isOpenUITool(name: string): boolean {
  return name === PRESENT_OPENUI || name === PROMPT_OPENUI;
}

/**
 * The display tools of the generative UI OpenUI replaced. A stored conversation may still hold
 * their calls; they are read as calls that changed nothing and are no longer drawn.
 */
export const RETIRED_DISPLAY_TOOLS: readonly string[] = ['render_view', 'render_ui', 'render_canvas', 'render_chart', 'render_table'];

/** A call that drew rather than read or changed anything. */
export function isPresentationTool(name: string): boolean {
  return name === PRESENT_OPENUI || RETIRED_DISPLAY_TOOLS.includes(name);
}
