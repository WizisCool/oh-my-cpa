export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const MAX_EVENTS = 500;
export const MAX_EVENT_BYTES = 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const PLAYGROUND_SESSION_PREFERENCE = 'playground_session';

/**
 * The default User-Agent for a deployment, mirroring `gateway.UserAgentForVersion`.
 *
 * The version comes from the runtime config the server injects, not a constant here: a
 * second copy of the number would drift from `OMCPA_VERSION`, and the panel and the wire
 * would then name different builds. This is only the placeholder and the copied cURL,
 * though - the server resolves the value that actually leaves the process, so a client
 * that never loaded this config still sends the right one.
 * The token rule matches the server's: a version that is not a valid product token falls
 * back to the default rather than being mangled into one, so a copied cURL cannot describe
 * a header the server would never send.
 */
export function playgroundUserAgent(version?: string): string {
  const trimmed = (version ?? '').trim().replace(/^v/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(trimmed)) return 'Oh-My-CPA/0.1.0';
  return `Oh-My-CPA/${trimmed}`;
}

/**
 * The generation settings the next request is built from.
 *
 * `null` and the empty string mean "not set": the field is omitted from the request, so the
 * model's own default applies. That is a different claim from any value the control could show,
 * which is why an unset number is never displayed as zero or as a midpoint.
 */
export interface PlaygroundParameters {
  systemPrompt: string;
  reasoningEffort: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  userAgent: string;
  customBody: string;
}

export const DEFAULT_PLAYGROUND_PARAMETERS: PlaygroundParameters = {
  systemPrompt: '',
  reasoningEffort: '',
  temperature: null,
  topP: null,
  maxTokens: null,
  userAgent: '',
  customBody: '',
};

/** The parameters a stored session carries, with every absent field at its default. */
export function parametersFromSession(session: PlaygroundSession): PlaygroundParameters {
  return {
    systemPrompt: session.system_prompt ?? '',
    reasoningEffort: session.reasoning_effort ?? '',
    temperature: session.temperature ?? null,
    topP: session.top_p ?? null,
    maxTokens: session.max_tokens ?? null,
    userAgent: session.user_agent ?? '',
    customBody: session.custom_body ?? '',
  };
}

/** Whether any parameter differs from the model's defaults, which is what "Reset" undoes. */
export function hasCustomParameters(parameters: PlaygroundParameters): boolean {
  return (Object.keys(DEFAULT_PLAYGROUND_PARAMETERS) as (keyof PlaygroundParameters)[])
    .some(key => parameters[key] !== DEFAULT_PLAYGROUND_PARAMETERS[key]);
}

/** The single stored session: the target, the parameters, and the conversation's bounded turns. */
export function sessionDocument(
  target: { fingerprint: string; model: string },
  parameters: PlaygroundParameters,
  turns: Turn[],
  lastRunID?: string,
): PlaygroundSession {
  return {
    client_key_fingerprint: target.fingerprint || undefined,
    model: target.model || undefined,
    system_prompt: parameters.systemPrompt || undefined,
    temperature: parameters.temperature,
    top_p: parameters.topP,
    max_tokens: parameters.maxTokens,
    reasoning_effort: parameters.reasoningEffort || undefined,
    user_agent: parameters.userAgent || undefined,
    custom_body: parameters.customBody || undefined,
    turns: sanitizeTurnsForStorage(turns),
    ...(lastRunID ? { last_run_id: lastRunID } : {}),
  };
}

export type CustomBodyReading =
  | { ok: true; value?: Record<string, unknown> }
  | { ok: false };

/**
 * Reads the custom body field: empty is "no override", and anything else must be one JSON object.
 *
 * Checked as the operator types rather than on send, so the field can say it is invalid while it
 * is still in view instead of refusing the message after the fact.
 */
export function readCustomBody(text: string): CustomBodyReading {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { ok: true, value: parsed as Record<string, unknown> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** The request for the next message: the snapshot a turn keeps, and what retry replays. */
export function buildChatRequest(
  target: { fingerprint: string; model: string },
  parameters: PlaygroundParameters,
  customBody: Record<string, unknown> | undefined,
  history: Message[],
  user: Message,
): ChatRequest {
  return {
    client_key_fingerprint: target.fingerprint,
    model: target.model,
    messages: [...history, user],
    ...(parameters.systemPrompt.trim() ? { system_prompt: parameters.systemPrompt } : {}),
    ...(parameters.reasoningEffort.trim() ? { reasoning_effort: parameters.reasoningEffort.trim() } : {}),
    ...(parameters.temperature !== null ? { temperature: parameters.temperature } : {}),
    ...(parameters.topP !== null ? { top_p: parameters.topP } : {}),
    ...(parameters.maxTokens !== null ? { max_tokens: parameters.maxTokens } : {}),
    ...(parameters.userAgent.trim() ? { user_agent: parameters.userAgent.trim() } : {}),
    ...(customBody ? { custom_body: customBody } : {}),
  };
}

/** The status tone a turn earns, in the console's semantic palette. */
export function turnTone(status: Turn['status']): 'success' | 'processing' | 'warning' | 'error' | 'default' {
  switch (status) {
    case 'success': return 'success';
    case 'running': return 'processing';
    case 'error': return 'error';
    default: return 'default';
  }
}

/** A retry replays the snapshot; everything the previous attempt observed is cleared. */
export function retriedTurn(turn: Turn, id: string, now: number): Turn {
  return {
    id,
    request: turn.request,
    keyLabel: turn.keyLabel,
    user: turn.user,
    reply: '',
    status: 'running',
    startedAt: now,
    events: [],
    eventBytes: 0,
    isTruncated: false,
    hasOmittedHistory: turn.hasOmittedHistory,
  };
}

/**
 * The last turn asked again with its text changed: the same request snapshot - key, model,
 * parameters, history, and the images that went with the message - with only the message's text
 * replaced. Editing is a retry with different words, not a new turn after the old one.
 */
export function editedTurn(turn: Turn, text: string, id: string, now: number): Turn {
  const images = turn.user.content.filter(part => part.type === 'image_url');
  const user: Message = { role: 'user', content: [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...images] };
  return { ...retriedTurn(turn, id, now), user, request: { ...turn.request, messages: [...turn.request.messages.slice(0, -1), user] } };
}

/** Whether a stored turn lost an image to storage redaction, so its request can no longer be replayed. */
export function hasOmittedImage(turn: Turn): boolean {
  return turn.request.messages.some(message => message.content.some(part =>
    part.type === 'image_url' && !part.image_url.url.startsWith('data:')));
}

export interface PlaygroundSession {
  last_run_id?: string;
  client_key_fingerprint?: string;
  model?: string;
  system_prompt?: string;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  reasoning_effort?: string | null;
  user_agent?: string;
  custom_body?: string;
  turns?: Turn[];
}

export const DEFAULT_PLAYGROUND_SESSION: PlaygroundSession = {};

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isStoredMessage(value: unknown): value is Message {
  if (!isObject(value) || !['user', 'assistant', 'system'].includes(String(value.role)) || !Array.isArray(value.content)) return false;
  return value.content.every(part => isObject(part) && (part.type === 'text' && typeof part.text === 'string' || part.type === 'image_url' && isObject(part.image_url) && typeof part.image_url.url === 'string'));
}
function isStoredEvent(value: unknown): value is StreamEvent {
  if (!isObject(value) || !(PLAYGROUND_EVENT_TYPES as readonly string[]).includes(String(value.type))) return false;
  for (const field of ['content', 'model', 'finish_reason', 'code', 'parameter', 'request_id']) if (value[field] !== undefined && typeof value[field] !== 'string') return false;
  for (const field of ['started_at_ms', 'duration_ms', 'upstream_status']) if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]))) return false;
  return value.usage === undefined || isStoredUsage(value.usage);
}
function isStoredUsage(value: unknown): value is Usage {
  return isObject(value) && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => value[key] === undefined || typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);
}
function isStoredTurn(value: unknown): value is Turn {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.reply !== 'string' || typeof value.keyLabel !== 'string' || !isStoredMessage(value.user) || value.user.role !== 'user') return false;
  if (!['running', 'success', 'error', 'cancelled'].includes(String(value.status)) || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return false;
  if (typeof value.eventBytes !== 'number' || !Number.isFinite(value.eventBytes) || typeof value.isTruncated !== 'boolean') return false;
  for (const field of ['serverStartedAt', 'endedAt', 'firstContentMS', 'durationMS']) if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]))) return false;
  for (const field of ['thought', 'finishReason', 'requestID']) if (value[field] !== undefined && typeof value[field] !== 'string') return false;
  if (value.usage !== undefined && !isStoredUsage(value.usage) || value.error !== undefined && !isStoredEvent(value.error)) return false;
  const request = value.request;
  if (!isObject(request) || typeof request.model !== 'string' || typeof request.client_key_fingerprint !== 'string' || !Array.isArray(request.messages) || !request.messages.every(isStoredMessage)) return false;
  for (const field of ['temperature', 'top_p', 'max_tokens']) if (request[field] !== undefined && (typeof request[field] !== 'number' || !Number.isFinite(request[field]))) return false;
  for (const field of ['system_prompt', 'reasoning_effort', 'user_agent']) if (request[field] !== undefined && typeof request[field] !== 'string') return false;
  if (request.custom_body !== undefined && !isObject(request.custom_body)) return false;
  return true;
}

/** Parse the persisted single latest playground session. */
export function parsePlaygroundSession(raw: unknown): PlaygroundSession | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const clientKeyFingerprint = typeof value.client_key_fingerprint === 'string' ? value.client_key_fingerprint.trim() : undefined;
  const model = typeof value.model === 'string' ? value.model.trim() : undefined;
  const systemPrompt = typeof value.system_prompt === 'string' ? value.system_prompt : undefined;
  const temperature = typeof value.temperature === 'number' && Number.isFinite(value.temperature) ? value.temperature : null;
  const topP = typeof value.top_p === 'number' && Number.isFinite(value.top_p) ? value.top_p : null;
  const maxTokens = typeof value.max_tokens === 'number' && Number.isFinite(value.max_tokens) ? value.max_tokens : null;
  const reasoningEffort = typeof value.reasoning_effort === 'string' && value.reasoning_effort.trim() ? value.reasoning_effort.trim() : undefined;
  const userAgent = typeof value.user_agent === 'string' ? value.user_agent.trim() : undefined;
  const customBody = typeof value.custom_body === 'string' ? value.custom_body : undefined;

  let turns: Turn[] | undefined = undefined;
  if (Array.isArray(value.turns)) {
    turns = value.turns.filter((turn): turn is Turn => {
      return isStoredTurn(turn);
    }).map(turn => ({
      ...turn,
      status: turn.status === 'running' ? 'cancelled' : turn.status,
      events: Array.isArray(turn.events) ? turn.events.filter(isStoredEvent).slice(-50) : [],
    }));
  }

  return {
    ...(typeof value.last_run_id === 'string' ? { last_run_id: value.last_run_id } : {}),
    ...(clientKeyFingerprint ? { client_key_fingerprint: clientKeyFingerprint } : {}),
    ...(model ? { model } : {}),
    ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
    ...(temperature !== null ? { temperature } : {}),
    ...(topP !== null ? { top_p: topP } : {}),
    ...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(userAgent ? { user_agent: userAgent } : {}),
    ...(customBody !== undefined ? { custom_body: customBody } : {}),
    ...(turns ? { turns } : {}),
  };
}

/**
 * storedImageURLsLargerThan is the size past which an inline image is not stored.
 *
 * A preference document is not an image store: one screenshot is orders of magnitude larger
 * than every other field combined. Anything past this is replaced with a placeholder, and the
 * conversation replay treats that placeholder as an image it no longer has.
 */
export const STORED_IMAGE_URL_LIMIT = 16384;

/**
 * redactStoredImages replaces oversized inline image payloads anywhere in a stored turn.
 *
 * Recursive on purpose. Redacting only `turn.user.content` left the same bytes in
 * `turn.request.messages` - which is the snapshot the turn was built from, and which carries
 * every earlier turn's images as history - so a "large images are not stored" claim was false
 * for the copies that actually weighed the most.
 */
function redactStoredImages(value: unknown): any {
  if (typeof value === 'string') {
    return value.startsWith('data:image/') && value.length > STORED_IMAGE_URL_LIMIT
      ? '<image omitted>'
      : value;
  }
  if (Array.isArray(value)) return value.map(redactStoredImages);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactStoredImages(entry)]));
  }
  return value;
}

/**
 * sanitizeTurnsForStorage bounds what a stored session can weigh.
 *
 * It redacts the whole turn, then caps the diagnostic event log: the events are a debugging
 * aid, and 50 of them is enough to explain a turn without letting a long stream dominate the
 * document.
 */
export function sanitizeTurnsForStorage(turns: Turn[]): Turn[] {
  const stored = turns.map((turn, index) => {
    const redacted = redactStoredImages(turn) as Turn;
    const shouldOmitHistory = index < turns.length - 1 && redacted.request.messages.length > 1;
    return { ...redacted, request: shouldOmitHistory ? { ...redacted.request, messages: [redacted.user] } : redacted.request,
      hasOmittedHistory: redacted.hasOmittedHistory || shouldOmitHistory, events: redacted.events.slice(-50) };
  });
  while (stored.length > 1 && JSON.stringify(stored).length > 512 * 1024) stored.shift();
  return stored;
}

export interface IDSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => void;
}

let fallbackIDCounter = 0;

function formatUUID(bytes: Uint8Array): string {
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * createID works on plain HTTP origins as well as secure origins. `randomUUID`
 * is restricted to a secure context, while `getRandomValues` is not; the final
 * fallback exists only for browsers that expose neither.
 */
export function createID(prefix = 'id', source: IDSource | undefined = typeof globalThis === 'undefined' ? undefined : globalThis.crypto): string {
  try {
    if (typeof source?.randomUUID === 'function') return source.randomUUID();
  } catch {
    // Fall through to the non-secure-context generator.
  }
  try {
    if (typeof source?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      source.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return formatUUID(bytes);
    }
  } catch {
    // Fall through to the timestamp/counter fallback.
  }
  fallbackIDCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackIDCounter.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export interface ImageAttachment { uid: string; name: string; size: number; type: string; url: string }
export type Content = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface Message { role: 'user' | 'assistant' | 'system'; content: Content[] }
export interface ChatRequest {
  client_key_fingerprint: string;
  model: string;
  system_prompt?: string;
  messages: Message[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  user_agent?: string;
  custom_body?: Record<string, unknown>;
}
export interface Usage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
/** Every event the playground route streams; anything else is a malformed response. */
export const PLAYGROUND_EVENT_TYPES = ['meta', 'request', 'delta', 'thought', 'usage', 'done', 'error'] as const;
export interface StreamEvent {
  type: typeof PLAYGROUND_EVENT_TYPES[number];
  content?: string;
  model?: string;
  started_at_ms?: number;
  first_content_ms?: number | null;
  duration_ms?: number;
  usage?: Usage;
  finish_reason?: string;
  code?: string;
  upstream_status?: number;
  parameter?: string;
  /** CPA's id for the request, on `request` and on an `error` for a request CPA rejected. */
  request_id?: string;
}
export interface Turn {
  id: string;
  request: ChatRequest;
  keyLabel: string;
  user: Message;
  reply: string;
  thought?: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  startedAt: number;
  serverStartedAt?: number;
  /** CPA's `request_id` for this turn: the key its request record is found by. */
  requestID?: string;
  endedAt?: number;
  firstContentMS?: number;
  durationMS?: number;
  finishReason?: string;
  usage?: Usage;
  error?: StreamEvent;
  events: StreamEvent[];
  eventBytes: number;
  isTruncated: boolean;
  hasOmittedHistory?: boolean;
}
export function buildHistory(turns: Turn[]): Message[] {
  return turns.flatMap(turn => {
    // A restored turn may hold a redacted placeholder where an image used to be
    // (`sanitizeTurnsForStorage`). Replaying it would send an unusable URL and the gateway
    // would reject the whole request as `invalid_image`, so the image is dropped rather than
    // faked - and a turn whose only content was that image is dropped with it, because a
    // message with no content is not a message.
    const content = turn.user.content.filter(part =>
      part.type === 'text' || part.image_url.url.startsWith('data:'),
    );
    if (content.length === 0) return [];
    return [
      { ...turn.user, content },
      ...(turn.status === 'success' && turn.reply
        ? [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: turn.reply }] }]
        : []),
    ];
  });
}
export function applyEvent(turn: Turn, event: StreamEvent, now = Date.now()): Turn {
  if (turn.status !== 'running') return turn;
  const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
  const canKeep = !turn.isTruncated && turn.events.length < MAX_EVENTS && turn.eventBytes + eventBytes <= MAX_EVENT_BYTES;
  const next = { ...turn, events: canKeep ? [...turn.events, event] : turn.events,
    eventBytes: canKeep ? turn.eventBytes + eventBytes : turn.eventBytes, isTruncated: turn.isTruncated || !canKeep };
  if (event.type === 'meta' && event.started_at_ms !== undefined) next.serverStartedAt = event.started_at_ms;
  if ((event.type === 'request' || event.type === 'error') && event.request_id) next.requestID ??= event.request_id;
  if (event.type === 'thought' && event.content) {
    next.thought = (next.thought ?? '') + event.content;
  }
  if (event.type === 'delta' && event.content) {
    next.reply += event.content;
    next.firstContentMS ??= event.first_content_ms ?? undefined;
  }
  if (event.type === 'usage') next.usage = event.usage;
  if (event.type === 'done') {
    next.status = 'success'; next.endedAt = now; next.durationMS = event.duration_ms;
    next.firstContentMS = event.first_content_ms ?? undefined; next.finishReason = event.finish_reason;
  }
  if (event.type === 'error') { next.status = event.code === 'cancelled' ? 'cancelled' : 'error'; next.error = event; next.endedAt = now; next.durationMS = event.duration_ms ?? now - turn.startedAt; next.firstContentMS ??= event.first_content_ms ?? undefined; }
  return next;
}

/** Extract thinking blocks if model outputs inline <think> tags. */
export function extractThinking(text: string): { thought?: string; reply: string; isThinking?: boolean } {
  const openTag = '<think>';
  const closeTag = '</think>';
  const openIndex = text.indexOf(openTag);
  if (openIndex === -1) return { reply: text, isThinking: false };
  const closeIndex = text.indexOf(closeTag, openIndex);
  if (closeIndex === -1) {
    return {
      thought: text.slice(openIndex + openTag.length).trim(),
      reply: text.slice(0, openIndex).trim(),
      isThinking: true,
    };
  }
  const thought = text.slice(openIndex + openTag.length, closeIndex).trim();
  const reply = (text.slice(0, openIndex) + text.slice(closeIndex + closeTag.length)).trim();
  return { thought: thought || undefined, reply, isThinking: false };
}

export function actualRequest(request: ChatRequest) {
  // `user_agent` is the one playground field that is not part of the chat payload:
  // the server reads it to set the outbound `User-Agent` header and never forwards
  // it as a body field. It is therefore excluded here (the body is what the gateway
  // receives) and rendered by `buildCurl` as a header instead, so the diagnostic
  // matches what actually leaves the process.
  const { client_key_fingerprint: _fingerprint, system_prompt: systemPrompt, custom_body: customBody, user_agent: _userAgent, ...fields } = request;
  return {
    ...fields,
    messages: [...(systemPrompt ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: systemPrompt }] }] : []), ...fields.messages],
    stream: true,
    stream_options: { include_usage: true },
    ...(customBody ?? {}),
  };
}
export function inspectRequest(request: ChatRequest) {
  return redactImageData(actualRequest(request));
}

/**
 * redactImageData replaces inline image payloads with a placeholder, at any depth.
 *
 * A recursive walk, rather than mapping `messages[].content[]`, because
 * `custom_body` may legitimately override `messages` with the string-content form the
 * OpenAI schema also accepts (`{"role":"user","content":"hi"}`). The shape is
 * whatever the operator typed, so a walk that assumes arrays either crashes the
 * diagnostics panel or renders a multi-megabyte base64 string into the DOM.
 *
 * `JSON.parse(JSON.stringify())` is not enough: it would copy the payload whole.
 */
function redactImageData(value: unknown): any {
  if (typeof value === 'string') {
    const match = /^data:([^;,]+)[^,]*,/.exec(value);
    return match ? `<${match[1]}; base64 omitted>` : value;
  }
  if (Array.isArray(value)) return value.map(redactImageData);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactImageData(entry)]));
  }
  return value;
}
export function buildCurl(request: ChatRequest, defaultUserAgent: string): string {
  const json = JSON.stringify(inspectRequest(request), null, 2);
  // The delimiter must not be supplied by a prompt: otherwise copying a prompt
  // containing shell syntax could turn a diagnostic command into code execution.
  let delimiter = 'OMC_REQUEST_JSON';
  while (json.split('\n').includes(delimiter)) delimiter += '_';
  // The UA is a header on the outbound request, not a body field, so the command has
  // to set it explicitly to reproduce the same wire request. The default is passed in
  // rather than held here, because the server resolves the value that is actually sent
  // and this function only renders it.
  const userAgent = (request.user_agent?.trim() || defaultUserAgent).replace(/'/g, `'\\''`);
  return `cat > request.json <<'${delimiter}'\n${json}\n${delimiter}\ncurl "$CPA_BASE_URL/v1/chat/completions" \\\n  -H "Authorization: Bearer $CPA_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H 'User-Agent: ${userAgent}' \\\n  --no-buffer --data-binary @request.json`;
}
/**
 * effectiveModel reports the model a turn's request will actually use.
 *
 * `custom_body` outranks the selector, so the selected call point is not always the model
 * that was called. Every surface that names the model - the turn label and the diagnostics
 * panel heading - reads this, so a turn is never labelled with a model it did not call.
 */
export function effectiveModel(request: ChatRequest): string {
  const override = request.custom_body?.model;
  return typeof override === 'string' && override.trim() ? override : request.model;
}

/**
 * How far either side of a turn's own span the request-records window reaches.
 *
 * The request id is what names the record; the window is there because CPA numbers requests
 * with a counter that starts again from zero whenever CPA restarts, so the same id recurs
 * across restarts. The record's time is stamped by CPA's clock and the turn's by OMC's (or,
 * for a turn restored without server timings, the browser's), so the margin is wide enough
 * to absorb skew between them while staying far shorter than the gap between two uses of one id.
 */
const USAGE_LINK_MARGIN_MS = 5 * 60_000;
/**
 * How long after a turn's window closes its record may still be on its way into OMC. CPA
 * publishes a record when the request finishes and ingest drains it on its own cadence; a
 * closed window is frozen and never re-read, so a link opened inside this grace stays
 * open-ended and the list keeps polling until the record arrives.
 */
const USAGE_LINK_INGEST_GRACE_MS = 60_000;

/**
 * usageLink opens the request records on the one request this turn made, or returns
 * undefined when the turn never learned CPA's id for it.
 *
 * The turn is found by the `request_id` CPA published on its usage record. There is
 * deliberately no fallback to matching by key, model and time, which lists neighbouring
 * requests as if they were this one.
 */
export function usageLink(turn: Turn, now = Date.now()): string | undefined {
  if (!turn.requestID) return undefined;
  const started = turn.serverStartedAt ?? turn.startedAt;
  const span = turn.durationMS
    ?? (turn.endedAt !== undefined ? turn.endedAt - turn.startedAt : undefined);
  const from = Math.max(0, Math.floor(started - USAGE_LINK_MARGIN_MS));
  const params = new URLSearchParams({ request_id: turn.requestID, from: String(from) });
  // A turn still running, or cut off without a `done`, has no known end: its record may land
  // at any later time, and a closed window is never re-read, so the link stays open-ended.
  if (span !== undefined) {
    const to = Math.ceil(started + Math.max(0, span) + USAGE_LINK_MARGIN_MS);
    if (now >= to + USAGE_LINK_INGEST_GRACE_MS) params.set("to", String(to));
  }
  return `/usage/events?${params.toString()}`;
}
export async function readImage(file: File): Promise<ImageAttachment> {
  if (!IMAGE_TYPES.includes(file.type) || file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new Error('invalid_image');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isPNG = header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71;
  const isJPEG = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const text = String.fromCharCode(...header);
  const isWebP = text.startsWith('RIFF') && text.slice(8) === 'WEBP';
  if (!(file.type === 'image/png' && isPNG || file.type === 'image/jpeg' && isJPEG || file.type === 'image/webp' && isWebP)) throw new Error('invalid_image');
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('invalid_image')); reader.readAsDataURL(file);
  });
  const preview = new Image();
  preview.src = url;
  try { await preview.decode(); } catch { throw new Error('invalid_image'); }
  if (!preview.naturalWidth || !preview.naturalHeight || preview.naturalWidth * preview.naturalHeight > 40_000_000) throw new Error('invalid_image');
  return { uid: createID('image'), name: file.name, size: file.size, type: file.type, url };
}
