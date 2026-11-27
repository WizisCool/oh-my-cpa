import { isKnownTurnStatus } from '../../components/workspace/conversationLabels';
import { messageKey, type MessageKey } from '../../i18n/catalog';
export { callStatusKey, failureKey, formatDuration, isKnownTurnStatus } from '../../components/workspace/conversationLabels';
export { argumentSummary, callDuration, statusTone } from '../../agent/callFacts';
import { getTimeZone } from '../../utils/time';
import { getDateTimeFormatter } from '../../utils/dateTimeFormat';
import type { Lang } from '../../i18n/language';
import { languageLocale } from '../../i18n/language';
import { DEFAULT_INFERENCE_ENDPOINT, parseInferenceEndpoint } from '../../types/inferenceEndpoints';
import type { InferenceEndpoint } from '../../types/inferenceEndpoints';

export type {
  AgentInterrupt, CapabilityReceipt, Conversation, InterruptReason, Trace, Turn, TurnPart, TurnUsage,
} from '../../agent/types';
import { isPresentationTool, PROMPT_OPENUI } from '../../agent/types';
import type { CapabilityReceipt, Conversation, Turn, TurnPart } from '../../agent/types';

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
 * "Something else" is a choice in its own right: in a single-choice question it replaces the
 * options rather than adding to one, so a reply never says two things at once. Its text is kept
 * while unchosen, so switching back does not lose typing.
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

/** Local demo recordings need no inference target, but never bypass an open decision. */
export function isAgentSendDisabled(isDemo: boolean, isFullyConfigured: boolean, isAwaiting: boolean): boolean {
  return (!isDemo && !isFullyConfigured) || isAwaiting;
}

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
  /** Private operator input the capability waits on: `secret`, `oauth` or `answer`. */
  human_input?: string;
}

/**
 * A stopped run is stored as an error carrying the `cancelled` code.
 *
 * The distinction is presentation, not state: the operator asked for the stop, so reporting it
 * as a failure would be the console mislabelling their own action. Nothing rewrites the stored
 * turn - the label is derived at render time from the code that is already on the wire.
 */
export function turnLabelKey(turn: Pick<Turn, 'status' | 'code'>): MessageKey {
  if (turn.status === 'error' && turn.code === 'cancelled') return 'agent.status.stopped';
  // A status the console has no sentence for reads as unknown, not as an id.
  return (isKnownTurnStatus(turn.status) ? messageKey(`agent.status.${turn.status}`) : undefined) ?? 'agent.status.unknown';
}

/**
 * A turn stopped on a `prompt_openui` form rather than on a change to approve. Both are stored as
 * `pending`; the footer says which, because "awaiting approval" under a form sends the operator
 * looking for a dialog that is not there.
 */
export function isAwaitingAnswer(turn: Pick<Turn, 'status' | 'traces'>): boolean {
  return turn.status === 'pending'
    && (turn.traces ?? []).some(trace => trace.name === PROMPT_OPENUI && trace.result.status === 'pending');
}

const PREVIEW_FIELDS_MAX = 8;

export interface PreviewParts {
  /** The change's top-level scalars and short scalar lists, as label/value rows. */
  rows: [string, string][];
  /** Whatever is nested, as a document; `undefined` when the rows say everything. */
  details: unknown;
}

/**
 * A prepared change split into what reads as a form and what does not: top-level scalars and
 * lists of scalars become label/value rows, and nested parts stay one JSON document, because
 * flattening them into rows would invent a reading of them.
 *
 * Revision fingerprints are left out of both. They bind the decision on the server and tell the
 * operator nothing, and a line of `hmac:` hex is the longest thing in most previews.
 */
export function previewParts(changes: unknown): PreviewParts {
  const shown = withoutRevisions(changes);
  if (typeof shown !== 'object' || shown === null || Array.isArray(shown)) {
    return { rows: [], details: shown };
  }
  const rows: [string, string][] = [];
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shown)) {
    const isScalarList = Array.isArray(value) && value.every(item => item === null || typeof item !== 'object');
    if (rows.length < PREVIEW_FIELDS_MAX && isScalarList) rows.push([key, value.map(String).join(', ')]);
    else if (rows.length < PREVIEW_FIELDS_MAX && (value === null || typeof value !== 'object')) rows.push([key, String(value)]);
    else nested[key] = value;
  }
  return { rows, details: Object.keys(nested).length > 0 ? nested : undefined };
}

function withoutRevisions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRevisions);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'revision').map(([key, item]) => [key, withoutRevisions(item)]));
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
 * it called only read or presented. The server applies the same rule (`isReplaceable`), so this decides
 * only whether the actions are offered. A call the directory does not list counts as a change.
 */
export function replaceableTurnID(conversation: Conversation | undefined, capabilities: readonly { name: string; permission: string }[]): string {
  const last = conversation?.turns.at(-1);
  if (!last || last.status === 'running' || last.status === 'pending') return '';
  const isHarmless = (name: string) => isPresentationTool(name) || capabilities.some(item => item.name === name && item.permission === 'read');
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
