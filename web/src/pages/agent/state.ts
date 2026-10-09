import { isKnownTurnStatus } from '../../components/workspace/conversationLabels';
export { failureKey, formatDuration, isKnownTurnStatus } from '../../components/workspace/conversationLabels';
import { getTimeZone } from '../../utils/time';
import { getDateTimeFormatter } from '../../utils/dateTimeFormat';
import type { Lang } from '../../i18n/language';
import { languageLocale } from '../../i18n/language';
import { DEFAULT_INFERENCE_ENDPOINT, parseInferenceEndpoint } from '../../types/inferenceEndpoints';
import type { InferenceEndpoint } from '../../types/inferenceEndpoints';

export type {
  AgentInterrupt, CapabilityReceipt, Conversation, DisplayView, InterruptReason, Trace, Turn, TurnPart, TurnUsage,
} from '../../agent/types';
import { isDisplayTool } from '../../agent/types';
import type { CapabilityReceipt, Conversation, Trace, Turn, TurnPart } from '../../agent/types';

export interface Operation {
  id: string;
  capability: string;
  /** Recorded when the operation was prepared; older records carry none. */
  permission?: string;
  status: string;
  /** Who prepared it: the built-in Agent (`agent`) or an external MCP client (`mcp`). */
  adapter?: string;
  expires_at_ms?: number;
  human_input?: string;
  preview: { target: string; changes?: unknown };
  result: CapabilityReceipt;
}

/** The capability the agent asks the operator through; registered by the server's agent runtime. */
export const ASK_QUESTION = 'ask_question';

/** One question the agent asks through `ask_question`, as its prepared operation carries it. */
export interface AgentQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multi_select?: boolean;
}

/** The operator's reply to one question: chosen option labels, typed text, or both. */
export interface QuestionReply {
  selected: string[];
  text: string;
}

/** The questions of an `ask_question` operation, or none when the preview is not shaped like one. */
export function operationQuestions(operation: Operation | undefined): AgentQuestion[] {
  const changes = operation?.preview.changes as { questions?: unknown } | undefined;
  if (!Array.isArray(changes?.questions)) return [];
  return changes.questions.filter((item): item is AgentQuestion =>
    typeof item === 'object' && item !== null && typeof (item as AgentQuestion).question === 'string');
}

/**
 * What the operator has chosen for one question while the panel is open.
 *
 * "Something else" is a choice in its own right, as in the coding agents this follows: in a
 * single-choice question it replaces the options rather than adding to one, so a reply never says
 * two things at once. Its text is kept while unchosen, so switching back does not lose typing.
 */
export interface QuestionDraft {
  selected: string[];
  isOther: boolean;
  text: string;
}

export const EMPTY_DRAFT: QuestionDraft = { selected: [], isOther: false, text: '' };

export function chooseOption(draft: QuestionDraft, question: AgentQuestion, label: string): QuestionDraft {
  if (!question.multi_select) return { ...draft, selected: [label], isOther: false };
  const selected = draft.selected.includes(label) ? draft.selected.filter(item => item !== label) : [...draft.selected, label];
  return { ...draft, selected };
}

export function chooseOther(draft: QuestionDraft, question: AgentQuestion): QuestionDraft {
  if (!question.multi_select) return { ...draft, selected: [], isOther: true };
  return { ...draft, isOther: !draft.isOther };
}

/** The reply a draft sends. A question without options is answered by its text alone. */
export function draftReply(draft: QuestionDraft, question: AgentQuestion): QuestionReply {
  const isTextChosen = draft.isOther || (question.options ?? []).length === 0;
  return { selected: draft.selected, text: isTextChosen ? draft.text.trim() : '' };
}

/** Every question has something to send: a chosen option or typed text. */
export function isQuestionAnswered(replies: QuestionReply[], count: number): boolean {
  return replies.length === count && replies.every(reply => reply.selected.length > 0 || reply.text.trim() !== '');
}

/** The operation the conversation is waiting on, if its last turn stopped for one. */
export function pendingOperationID(conversation: Conversation | undefined): string {
  const last = conversation?.turns.at(-1);
  if (last?.status !== 'pending') return '';
  return [...last.traces].reverse().find(trace => trace.result.status === 'pending' && trace.result.operation_id)?.result.operation_id ?? '';
}

/**
 * The Agent's selector as the operator last left it: key, call point, reasoning effort and
 * inference endpoint.
 *
 * A preference rather than a field of the conversation, because it is a choice made before a
 * message is sent - a reload between choosing a model and asking it something keeps the choice.
 * The conversation still records what each turn actually ran with.
 */
export interface AgentTarget {
  client_key_fingerprint?: string;
  model?: string;
  reasoning_effort?: string;
  /** Absent for Chat Completions. */
  endpoint?: InferenceEndpoint;
}

export const AGENT_TARGET_PREFERENCE = 'agent_target';
export const DEFAULT_AGENT_TARGET: AgentTarget = {};

/** Reads the stored selector, keeping only the fields it may hold. */
export function parseAgentTarget(raw: unknown): AgentTarget | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const field = (name: string) => (typeof value[name] === 'string' ? (value[name] as string).trim() : '');
  const target: AgentTarget = {};
  if (field('client_key_fingerprint')) target.client_key_fingerprint = field('client_key_fingerprint');
  if (field('model')) target.model = field('model');
  if (field('reasoning_effort')) target.reasoning_effort = field('reasoning_effort');
  const endpoint = parseInferenceEndpoint(field('endpoint'));
  if (endpoint && endpoint !== DEFAULT_INFERENCE_ENDPOINT) target.endpoint = endpoint;
  return target;
}

/** One registry entry, as `/capabilities` projects it. */
export interface Capability {
  name: string;
  description: string;
  permission: string;
  risk: string;
  version: number;
}

/**
 * A stopped run is stored as an error carrying the `cancelled` code.
 *
 * The distinction is presentation, not state: the operator asked for the stop, so reporting it
 * as a failure would be the console mislabelling their own action. Nothing rewrites the stored
 * turn - the label is derived at render time from the code that is already on the wire.
 */
export function turnLabelKey(turn: Pick<Turn, 'status' | 'code'>): string {
  if (turn.status === 'error' && turn.code === 'cancelled') return 'agent.status.stopped';
  return isKnownTurnStatus(turn.status) ? `agent.status.${turn.status}` : 'agent.status.unknown';
}

/**
 * A turn stopped on the agent's question rather than on a change to approve. Both are stored as
 * `pending`; the footer says which, because "awaiting approval" under a question sends the
 * operator looking for a dialog that is not there.
 */
export function isAwaitingAnswer(turn: Pick<Turn, 'status' | 'traces'>): boolean {
  return turn.status === 'pending'
    && (turn.traces ?? []).some(trace => trace.name === ASK_QUESTION && trace.result.status === 'pending');
}

/** The tone a status earns in the console's semantic palette. */
export function statusTone(status: string, code?: string): 'success' | 'processing' | 'warning' | 'error' | 'default' {
  if (status === 'error' && code === 'cancelled') return 'default';
  switch (status) {
    case 'success':
      return 'success';
    case 'running':
    case 'executing':
      return 'processing';
    case 'pending':
    case 'partial':
    case 'uncertain':
    case 'expired':
      return 'warning';
    case 'error':
    case 'rejected':
      return 'error';
    default:
      return 'default';
  }
}

const PREVIEW_FIELDS_MAX = 8;

/**
 * A prepared change as label/value rows, when it is shaped like a form: a flat object whose values
 * are scalars or short lists of scalars.
 *
 * Anything deeper stays JSON, because flattening a nested document into rows would invent a
 * reading of it. `undefined` means "show the document".
 */
export function previewEntries(changes: unknown): [string, string][] | undefined {
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) return undefined;
  const entries = Object.entries(changes);
  if (entries.length === 0 || entries.length > PREVIEW_FIELDS_MAX) return undefined;
  const rows: [string, string][] = [];
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      if (!value.every(item => item === null || typeof item !== 'object')) return undefined;
      rows.push([key, value.map(String).join(', ')]);
    } else if (value !== null && typeof value === 'object') {
      return undefined;
    } else {
      rows.push([key, String(value)]);
    }
  }
  return rows;
}

/**
 * A stored turn's parts. A turn saved without them - before the order was recorded - is read as
 * its calls followed by its answer, which is the order such a turn was always shown in.
 */
export function turnParts(turn: Turn): TurnPart[] {
  if (turn.parts?.length) return turn.parts;
  return [
    ...turn.traces.map(trace => ({ type: 'tool' as const, trace_id: trace.id })),
    ...(turn.reply ? [{ type: 'text' as const, content: turn.reply }] : []),
  ];
}

export function formatClock(milliseconds: number | undefined, lang: Lang): string {
  if (!milliseconds) return '';
  return getDateTimeFormatter(languageLocale(lang), { hour: '2-digit', minute: '2-digit', timeZone: getTimeZone() }).format(milliseconds);
}

/** How long a stored turn took, or undefined while it is still in flight. */
export function turnDuration(turn: Turn): number | undefined {
  if (!turn.started_at_ms || !turn.ended_at_ms) return undefined;
  return turn.ended_at_ms - turn.started_at_ms;
}

/**
 * The newest turn's id when a retry or an edit may take its place: it is settled, and everything
 * it called only read or drew. The server applies the same rule (`isReplaceable`), so this decides
 * only whether the actions are offered. A call the directory does not list counts as a change.
 */
export function replaceableTurnID(conversation: Conversation | undefined, capabilities: readonly { name: string; permission: string }[]): string {
  const last = conversation?.turns.at(-1);
  if (!last || last.status === 'running' || last.status === 'pending') return '';
  const isHarmless = (name: string) => isDisplayTool(name) || capabilities.some(item => item.name === name && item.permission === 'read');
  return last.traces.every(trace => isHarmless(trace.name)) ? last.id : '';
}

export function isAwaitingApproval(conversation: Conversation | undefined): boolean {
  const last = conversation?.turns.at(-1);
  return last?.status === 'pending';
}

const PERMISSION_ORDER = ['read', 'write', 'destructive'];

export interface CapabilityGroup {
  permission: string;
  items: Capability[];
}

/**
 * The registry, grouped the way an operator reasons about it: what the agent may look at, what
 * it may change, and what it may destroy.
 *
 * The order is fixed rather than alphabetical so the destructive set is always in the same
 * place - it is the one that needs reading before approving anything.
 */
export function groupCapabilities(
  capabilities: Capability[],
  query: string,
  searchText: (capability: Capability) => string = capability => `${capability.name} ${capability.description}`,
): CapabilityGroup[] {
  const needle = query.trim().toLowerCase();
  const matched = capabilities.filter(capability => !needle || searchText(capability).toLowerCase().includes(needle));
  return PERMISSION_ORDER
    .map(permission => ({ permission, items: matched.filter(item => item.permission === permission).sort((left, right) => left.name.localeCompare(right.name)) }))
    .filter(group => group.items.length > 0);
}

const ARGUMENT_SUMMARY_FIELDS = 3;
const ARGUMENT_SUMMARY_CHARS = 32;

/**
 * A call's arguments as one short line: the first few top-level fields as `name=value`, each value
 * clipped. The whole argument text is one click away in the details panel; the row only has to say
 * which window, which provider, which model.
 */
export function argumentSummary(argumentsText: string | undefined): string {
  if (!argumentsText) return '';
  let value: unknown;
  try {
    value = JSON.parse(argumentsText);
  } catch {
    return '';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '';
  const clip = (text: string) => (text.length > ARGUMENT_SUMMARY_CHARS ? `${text.slice(0, ARGUMENT_SUMMARY_CHARS)}…` : text);
  const fields = Object.entries(value)
    .filter(([, field]) => field !== null && field !== '' && !(Array.isArray(field) && field.length === 0))
    .map(([key, field]) => `${key}=${clip(typeof field === 'string' ? field : JSON.stringify(field))}`);
  const shown = fields.slice(0, ARGUMENT_SUMMARY_FIELDS).join(' · ');
  return fields.length > ARGUMENT_SUMMARY_FIELDS ? `${shown} · +${fields.length - ARGUMENT_SUMMARY_FIELDS}` : shown;
}

/**
 * The label a call row states: running, done, needs you, uncertain, failed. A call waiting on the
 * agent's question says so rather than "awaiting confirmation", which would send the operator
 * looking for an approval that is not there.
 */
export function callStatusKey(trace: Pick<Trace, 'name' | 'result'>): string {
  switch (trace.result.status) {
    case 'running':
      return 'agent.call.running';
    case 'pending':
      return trace.name === ASK_QUESTION ? 'agent.status.question' : 'agent.call.needs_you';
    case 'success':
      return 'agent.call.done';
    default:
      return isKnownTurnStatus(trace.result.status) ? `agent.status.${trace.result.status}` : 'agent.status.unknown';
  }
}

/** How long a call took, or how long it has been running when `nowMS` is given. */
export function callDuration(trace: Pick<Trace, 'started_at_ms' | 'ended_at_ms'>, nowMS?: number): number | undefined {
  if (!trace.started_at_ms) return undefined;
  const end = trace.ended_at_ms ?? nowMS;
  return end === undefined ? undefined : Math.max(0, end - trace.started_at_ms);
}
