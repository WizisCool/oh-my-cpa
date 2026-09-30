/**
 * Every failure the playground endpoints report, and the sentence the operator reads for it.
 *
 * The code itself is still printed beneath the sentence, because a support conversation needs the
 * identifier; it is just not the message. Codes absent from this table read as a gateway failure.
 */
const ERROR_KEYS: Record<string, string> = {
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
