import { getTimeZone } from '../../utils/time';
import { getDateTimeFormatter } from '../../utils/dateTimeFormat';
import type { Lang } from '../../i18n/language';
import { languageLocale } from '../../i18n/language';

export type {
  AgentInterrupt, CapabilityReceipt, Conversation, DisplayView, InterruptReason, Trace, Turn, TurnPart, TurnUsage,
} from '../../agent/types';
import type { CapabilityReceipt, Conversation, DisplayView, Trace, Turn, TurnPart } from '../../agent/types';

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
 * The Agent's selector as the operator last left it: key, call point and reasoning effort.
 *
 * A preference rather than a field of the conversation, because it is a choice made before a
 * message is sent - a reload between choosing a model and asking it something keeps the choice.
 * The conversation still records what each turn actually ran with.
 */
export interface AgentTarget {
  client_key_fingerprint?: string;
  model?: string;
  reasoning_effort?: string;
}

export const AGENT_TARGET_PREFERENCE = 'agent_target';
export const DEFAULT_AGENT_TARGET: AgentTarget = {};

/** Reads the stored selector, keeping only the three string fields it may hold. */
export function parseAgentTarget(raw: unknown): AgentTarget | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const field = (name: string) => (typeof value[name] === 'string' ? (value[name] as string).trim() : '');
  const target: AgentTarget = {};
  if (field('client_key_fingerprint')) target.client_key_fingerprint = field('client_key_fingerprint');
  if (field('model')) target.model = field('model');
  if (field('reasoning_effort')) target.reasoning_effort = field('reasoning_effort');
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
 * The statuses a turn can legitimately carry.
 *
 * Narrowing here rather than trusting the wire keeps an unrecognised status from rendering
 * the dictionary key itself: a status this console does not know is shown as an unknown
 * outcome, which is also the honest reading of one.
 */
const TURN_STATUSES = [
  'running',
  'pending',
  'executing',
  'success',
  'error',
  'rejected',
  'expired',
  'uncertain',
  'partial',
  'interrupted',
];

export function isKnownTurnStatus(status: string): boolean {
  return TURN_STATUSES.includes(status);
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
 * Every failure the agent endpoints can report, and the sentence the operator reads for it.
 *
 * A raw code is a contract between two machines; showing it to the person deciding whether a
 * provider should stay disabled is a prototype habit. The code is still rendered, in mono and
 * under the sentence, because a support conversation needs the identifier - but it is not the
 * message. Codes absent from this table fall back to `agent.error.gateway`.
 */
const FAILURE_KEYS: Record<string, string> = {
  agent_busy: 'agent.error.busy',
  agent_revision_conflict: 'agent.error.conflict',
  confirmation_pending: 'agent.error.pending',
  confirmation_expired: 'agent.error.expired',
  secret_required: 'agent.error.secret',
  answer_required: 'agent.error.answer',
  invalid_answer: 'agent.error.answer',
  capability_forbidden: 'agent.error.forbidden',
  capability_unavailable: 'agent.error.unavailable',
  invalid_parameters: 'agent.error.parameters',
  invalid_timezone: 'omc.timezone_invalid',
  invalid_tool_arguments: 'agent.error.arguments',
  invalid_tool_result: 'agent.error.arguments',
  tool_input_too_large: 'agent.error.arguments',
  tool_result_too_large: 'agent.error.budget',
  operation_outcome_unknown: 'agent.error.uncertain',
  operation_failed: 'agent.error.failed',
  audit_write_failed: 'agent.error.audit',
  write_busy: 'agent.error.writing',
  resource_conflict: 'agent.error.conflict',
  resource_missing: 'agent.error.missing',
  not_found: 'agent.error.missing',
  cancelled: 'agent.error.cancelled',
  timeout: 'agent.error.timeout',
  stream_incomplete: 'agent.error.stream',
  invalid_stream: 'agent.error.stream',
  invalid_gateway_response: 'agent.error.gateway',
  session_expired: 'agent.error.session',
  authentication_required: 'agent.error.session',
  run_not_found: 'workspace.error.run_missing',
  run_expired: 'workspace.error.run_missing',
  run_id_conflict: 'agent.error.conflict',
  run_history_full: 'agent.error.busy',
  response_too_large: 'agent.error.budget',
  gateway_unavailable: 'agent.error.gateway',
  model_budget_exceeded: 'agent.error.budget',
  tool_budget_exceeded: 'agent.error.budget',
  context_budget_exceeded: 'agent.error.budget',
  schema_budget_exceeded: 'agent.error.budget',
  conversation_budget_exceeded: 'agent.error.budget',
  agent_document_too_large: 'agent.error.budget',
  demo_operation_refused: 'demo.blocked',
};

export function failureKey(code: string): string {
  return FAILURE_KEYS[code] ?? 'agent.error.gateway';
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

/** Durations are read as one number and one unit, never as milliseconds. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '-';
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
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

export interface ChartPoint {
  x: string;
  series: string;
  value: number;
}

/** An epoch in milliseconds from 1973 on: a time-bucket key, not a count. */
const EPOCH_MS_FLOOR = 1e11;

/**
 * A frozen chart's rows in long form: one point per x, series and value.
 *
 * Several y fields become one series each; a `series` field splits a single y into one series per
 * value; one y alone is a single unnamed series. An x axis whose every value is an epoch in
 * milliseconds - the shape a time-bucketed aggregate returns - is read as time. Missing values are
 * left out rather than drawn as zero, which would invent a dip.
 */
export function chartSeries(view: Pick<DisplayView, 'chart' | 'rows'>): { points: ChartPoint[]; isTime: boolean } {
  const chart = view.chart;
  if (!chart) return { points: [], isTime: false };
  const points: ChartPoint[] = [];
  for (const row of view.rows) {
    const x = row[chart.x] === null || row[chart.x] === undefined ? '' : String(row[chart.x]);
    if (chart.series) {
      const value = row[chart.y[0]];
      if (typeof value === 'number') points.push({ x, series: String(row[chart.series] ?? ''), value });
      continue;
    }
    for (const field of chart.y) {
      const value = row[field];
      if (typeof value === 'number') points.push({ x, series: chart.y.length > 1 ? field : '', value });
    }
  }
  const xs = points.map(point => point.x);
  const isTime = chart.type !== 'pie' && xs.length > 0 && xs.every(x => /^\d+$/.test(x) && Number(x) >= EPOCH_MS_FLOOR);
  return { points, isTime };
}
