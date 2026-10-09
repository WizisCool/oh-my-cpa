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
 * Every failure the agent endpoints can report, and the sentence the operator reads for it.
 *
 * The operator reads a localized sentence; the raw identifier remains below it for support.
 * Codes absent from this table fall back to `agent.error.gateway`.
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
  request_too_large: 'agent.error.request_too_large',
  context_length_exceeded: 'agent.error.context',
  upstream_rejected: 'agent.error.upstream_rejected',
  upstream_stream_rejected: 'agent.error.upstream_refused',
  upstream_rate_limited: 'agent.error.rate_limited',
  gateway_auth_failed: 'agent.error.upstream_auth',
  model_or_endpoint_missing: 'agent.error.model',
  model_not_found: 'agent.error.model',
  unsupported_parameter: 'agent.error.parameter_unsupported',
  unsupported_output: 'agent.error.output',
  invalid_image: 'pg.error.image',
  // Compatibility for stored failures from earlier runtime versions.
  budget_exceeded: 'agent.error.budget',
  model_budget_exceeded: 'agent.error.budget',
  tool_budget_exceeded: 'agent.error.budget',
  context_budget_exceeded: 'agent.error.budget',
  schema_budget_exceeded: 'agent.error.budget',
  conversation_budget_exceeded: 'agent.error.budget',
  agent_document_too_large: 'agent.error.budget',
  demo_operation_refused: 'demo.blocked',
  demo_replay_only: 'demo.replay_only',
};

export function failureKey(code: string): string {
  return FAILURE_KEYS[code] ?? 'agent.error.gateway';
}

/**
 * Every failure the playground endpoints report, and the sentence the operator reads for it.
 *
 * The code itself is still printed beneath the sentence, because a support conversation needs the
 * identifier; it is just not the message. Codes absent from this table read as a gateway failure.
 */
const ERROR_KEYS: Record<string, string> = {
  demo_replay_only: 'demo.replay_only',
  client_key_required: 'pg.error.key',
  client_key_missing: 'pg.error.key_missing',
  playground_busy: 'pg.error.busy',
  request_too_large: 'pg.error.large',
  invalid_image: 'pg.error.image',
  image_omitted: 'pg.error.image_omitted',
  invalid_request: 'pg.error.request',
  invalid_parameters: 'pg.error.parameters',
  gateway_auth_failed: 'pg.error.auth',
  session_expired: 'pg.error.session',
  authentication_required: 'pg.error.session',
  run_not_found: 'workspace.error.run_missing',
  run_expired: 'workspace.error.run_missing',
  run_id_conflict: 'pg.error.request',
  run_history_full: 'pg.error.busy',
  gateway_unavailable: 'pg.error.gateway',
  upstream_timeout: 'pg.error.timeout',
  upstream_rejected: 'pg.error.rejected',
  upstream_rate_limited: 'pg.error.rate',
  model_or_endpoint_missing: 'pg.error.model',
  model_not_found: 'pg.error.model',
  context_length_exceeded: 'pg.error.context',
  unsupported_parameter: 'pg.error.parameters',
  unsupported_output: 'pg.error.output',
  response_too_large: 'pg.error.response_large',
  invalid_gateway_response: 'pg.error.response',
  stream_incomplete: 'pg.error.incomplete',
  streaming_unavailable: 'pg.error.streaming',
  demo_operation_refused: 'demo.blocked',
};

export function playgroundErrorKey(code: string): string {
  return ERROR_KEYS[code] ?? 'pg.error.gateway';
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
