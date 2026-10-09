import { createID as sharedCreateID } from '../web/src/utils/ids';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actualRequest, applyEvent, buildChatRequest, buildCurl, buildHistory, createID, DEFAULT_PLAYGROUND_PARAMETERS,
  hasCustomParameters, hasOmittedImage, inspectRequest, effectiveModel, MAX_EVENTS, parametersFromSession,
  parsePlaygroundSession, playgroundUserAgent, readCustomBody, retriedTurn, sanitizeTurnsForStorage, sessionDocument,
  STORED_IMAGE_URL_LIMIT, usageLink,
} from '../web/src/pages/playground/state.ts';
import type { Turn } from '../web/src/pages/playground/state.ts';
import { readEventQuery } from '../web/src/types/usageEventQuery.ts';

function makeTurn(): Turn {
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] };
  return { id: 'test', request: { model: 'alias/model', client_key_fingerprint: 'fingerprint', messages: [user] },
    user, reply: '', status: 'running', startedAt: 1000000, keyLabel: 'test key', events: [], eventBytes: 0, isTruncated: false };
}

test('completion, partial failures, and retries do not smuggle partial answers into context', () => {
  const running = applyEvent(makeTurn(), { type: 'delta', content: 'partial' }, 1000100);
  const failed = applyEvent(running, { type: 'error', code: 'stream_incomplete' }, 1000200);
  assert.equal(failed.reply, 'partial'); assert.equal(buildHistory([failed]).length, 1);
  assert.equal(applyEvent(failed, { type: 'done' }).status, 'error');
  const complete = applyEvent(running, { type: 'done', finish_reason: 'stop', first_content_ms: 42, duration_ms: 200 }, 1000200);
  assert.equal(buildHistory([complete]).length, 2); assert.equal(complete.firstContentMS, 42);
  assert.equal(complete.usage, undefined);
});

test('thought events accumulate in turn.thought', () => {
  let turn = makeTurn();
  turn = applyEvent(turn, { type: 'thought', content: 'thinking step 1; ' });
  turn = applyEvent(turn, { type: 'thought', content: 'step 2.' });
  assert.equal(turn.thought, 'thinking step 1; step 2.');
  assert.equal(turn.reply, '');
});

test('bounded diagnostic events do not truncate the actual answer', () => {
  let turn = makeTurn();
  for (let i = 0; i < MAX_EVENTS + 2; i++) turn = applyEvent(turn, { type: 'delta', content: 'x' });
  assert.equal(turn.events.length, MAX_EVENTS); assert.equal(turn.isTruncated, true); assert.equal(turn.reply.length, MAX_EVENTS + 2);
  const large = applyEvent(makeTurn(), { type: 'delta', content: 'x'.repeat(1024 * 1024) });
  assert.equal(large.events.length, 0); assert.equal(large.isTruncated, true);
});

test('inspection and cURL omit secret identity and image payload, preserve the request snapshot', () => {
  const turn = makeTurn(); turn.request.system_prompt = 'system instruction';
  turn.request.reasoning_effort = 'ultra';
  turn.request.custom_body = { seed: 42 };
  turn.request.messages[0].content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=' } });
  const snapshot = JSON.stringify(turn.request);
  const inspected = JSON.stringify(inspectRequest(turn.request)); const command = buildCurl(turn.request, playgroundUserAgent());
  for (const value of [inspected, command]) { assert.ok(!value.includes('fingerprint')); assert.ok(!value.includes('aW1hZ2UtYnl0ZXM=')); }
  assert.ok(command.includes('$CPA_API_KEY')); assert.ok(command.includes('$CPA_BASE_URL'));
  assert.ok(command.includes('"reasoning_effort": "ultra"'));
  assert.ok(command.includes('"seed": 42'));
  assert.ok(command.includes('User-Agent: Oh-My-CPA/0.1.0'));
  assert.equal(JSON.stringify(turn.request), snapshot);
  assert.equal(inspectRequest(turn.request).messages[0].role, 'system');
  assert.equal(inspectRequest(turn.request).reasoning_effort, 'ultra');
  assert.equal((inspectRequest(turn.request) as Record<string, unknown>).seed, 42);
});

test('custom_body overrides any request fields with highest priority', () => {
  const turn = makeTurn();
  turn.request.model = 'base-model';
  turn.request.temperature = 0.9;
  turn.request.custom_body = {
    model: 'custom-override-model',
    temperature: 0.1,
    top_p: 0.5,
  };
  const inspected = inspectRequest(turn.request) as Record<string, unknown>;
  assert.equal(inspected.model, 'custom-override-model');
  assert.equal(inspected.temperature, 0.1);
  assert.equal(inspected.top_p, 0.5);
});

test('user_agent is a transport header, never a payload field', () => {
  // The server sets the outbound User-Agent header from this field and does not
  // forward it inside the chat payload, so the diagnostic must agree: body without
  // it, cURL with it. Asserting only one of the two let them disagree before.
  const turn = makeTurn();
  turn.request.user_agent = 'CustomClient/2.0';
  const inspected = inspectRequest(turn.request) as Record<string, unknown>;
  assert.equal('user_agent' in inspected, false, 'body must not carry user_agent');
  assert.equal(buildCurl(turn.request, playgroundUserAgent()).includes("User-Agent: CustomClient/2.0"), true);

  // Absent or blank means the product's own default, in the header only.
  delete turn.request.user_agent;
  assert.equal('user_agent' in (inspectRequest(turn.request) as Record<string, unknown>), false);
  assert.equal(buildCurl(turn.request, playgroundUserAgent()).includes(`User-Agent: ${playgroundUserAgent()}`), true);
  turn.request.user_agent = '   ';
  assert.equal(buildCurl(turn.request, playgroundUserAgent()).includes(`User-Agent: ${playgroundUserAgent()}`), true);
});

test("request drill-down names the turn's own request id within its window", () => {
  let turn = applyEvent(makeTurn(), { type: "meta", started_at_ms: 5_000_000 });
  turn = applyEvent(turn, { type: "request", request_id: "0000002a" });
  turn = applyEvent(turn, { type: "done", first_content_ms: 35, duration_ms: 2_000 }, 1003000);
  assert.equal(turn.requestID, "0000002a");
  const url = new URL(usageLink(turn)!, "http://local");
  const query = readEventQuery(url.searchParams);
  assert.equal(url.pathname, "/usage/events");
  assert.equal(query.text?.request_id, "0000002a");
  // The id is exact; key, model and User-Agent would only repeat it, and a mismatch would hide it.
  assert.equal(url.searchParams.has("api_key"), false);
  assert.equal(url.searchParams.has("model"), false);
  assert.equal(url.searchParams.has("ua"), false);
  assert.equal(url.searchParams.has("preset"), false);
  // CPA's ids restart with CPA, so the window stays; server time anchors it.
  assert.equal(query.from, 5_000_000 - 5 * 60_000);
  assert.equal(query.to, 5_000_000 + 2_000 + 5 * 60_000);
});

test("a turn CPA gave no request id has no drill-down at all", () => {
  let turn = applyEvent(makeTurn(), { type: "meta", started_at_ms: 5_000_000 });
  turn = applyEvent(turn, { type: "done", duration_ms: 2_000 }, 1003000);
  assert.equal(turn.requestID, undefined);
  assert.equal(usageLink(turn), undefined);
});

test("a request CPA rejected is still found by the id on its error", () => {
  const failed = applyEvent(makeTurn(), { type: "error", code: "upstream_rate_limited", upstream_status: 429, request_id: "0000002b" }, 1_001_000);
  assert.equal(failed.requestID, "0000002b");
  assert.equal(new URL(usageLink(failed)!, "http://local").searchParams.get("request_id"), "0000002b");
  // The id announced first is the request's; a later error cannot rename it.
  const streamed = applyEvent(applyEvent(makeTurn(), { type: "request", request_id: "0000002c" }), { type: "error", code: "stream_incomplete", request_id: "ffffffff" });
  assert.equal(streamed.requestID, "0000002c");
});

test("a turn restored without server timings is placed by the browser clock", () => {
  const turn = { ...makeTurn(), requestID: "0000002a", endedAt: 1_001_000 };
  const query = readEventQuery(new URL(usageLink(turn)!, "http://local").searchParams);
  assert.equal(query.from, 1_000_000 - 5 * 60_000);
  assert.equal(query.to, 1_001_000 + 5 * 60_000);
});

test("a turn that just finished stays open-ended until its record can have been ingested", () => {
  let turn = applyEvent(makeTurn(), { type: "meta", started_at_ms: 9_000_000 });
  turn = applyEvent(turn, { type: "request", request_id: "0000002a" });
  turn = applyEvent(turn, { type: "done", duration_ms: 1_000 }, 9_001_000);
  const fresh = new URL(usageLink(turn, 9_010_000)!, "http://local").searchParams;
  assert.equal(fresh.get("from"), String(9_000_000 - 5 * 60_000));
  assert.equal(fresh.has("to"), false);
  const settled = new URL(usageLink(turn, 9_000_000 + 1_000 + 5 * 60_000 + 60_000)!, "http://local").searchParams;
  assert.equal(settled.get("to"), String(9_000_000 + 1_000 + 5 * 60_000));
});

test("a turn without an end stays open-ended however long ago it started", () => {
  const started = applyEvent(makeTurn(), { type: "meta", started_at_ms: 2_000_000 });
  const link = usageLink(applyEvent(started, { type: "request", request_id: "0000002a" }), 2_000_000 + 24 * 3_600_000);
  const params = new URL(link!, "http://local").searchParams;
  assert.equal(params.has("to"), false);
  assert.equal(readEventQuery(params).from, 2_000_000 - 5 * 60_000);
});

test('playground session preference parses all configuration and turns safely', () => {
  const raw = {
    client_key_fingerprint: 'hmac:fp',
    model: 'claude-3-7-sonnet',
    system_prompt: 'Be concise',
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 4096,
    reasoning_effort: 'ultra',
    custom_body: '{"seed": 42}',
    turns: [
      {
        id: 'turn-1',
        request: { model: 'claude-3-7-sonnet', client_key_fingerprint: 'hmac:fp', messages: [] },
        keyLabel: 'Default',
        user: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        reply: 'hello',
        thought: 'greeting',
        status: 'running',
        startedAt: 1000,
        events: [],
        eventBytes: 0,
        isTruncated: false,
      },
    ],
  };
  const parsed = parsePlaygroundSession(raw);
  assert.ok(parsed);
  assert.equal(parsed.client_key_fingerprint, 'hmac:fp');
  assert.equal(parsed.model, 'claude-3-7-sonnet');
  assert.equal(parsed.system_prompt, 'Be concise');
  assert.equal(parsed.temperature, 0.7);
  assert.equal(parsed.top_p, 0.9);
  assert.equal(parsed.max_tokens, 4096);
  assert.equal(parsed.reasoning_effort, 'ultra');
  assert.equal(parsed.custom_body, '{"seed": 42}');
  assert.equal(parsed.turns?.length, 1);
  assert.equal(parsed.turns?.[0].status, 'cancelled'); // running converted to cancelled on restore

  // Test turn sanitization for images
  const turnWithHugeImage: Turn = {
    ...makeTurn(),
    user: {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(20000) } },
      ],
    },
  };
  const sanitized = sanitizeTurnsForStorage([turnWithHugeImage]);
  assert.equal(sanitized[0].user.content[1].type, 'image_url');
  if (sanitized[0].user.content[1].type === 'image_url') {
    assert.equal(sanitized[0].user.content[1].image_url.url, '<image omitted>');
  }
});

test('the default user-agent names the running build, not a literal', () => {
  // The version is the server's; a second copy here would drift from OMCPA_VERSION and
  // the panel would name a build the deployment is not.
  assert.equal(playgroundUserAgent('v0.1.0-dev'), 'Oh-My-CPA/0.1.0-dev');
  assert.equal(playgroundUserAgent('v1.2.3'), 'Oh-My-CPA/1.2.3');
  assert.equal(playgroundUserAgent('1.2.3'), 'Oh-My-CPA/1.2.3', 'a leading v is a tag spelling');
  assert.equal(playgroundUserAgent('v0.1.0-demo'), 'Oh-My-CPA/0.1.0-demo', 'a build suffix survives');
  // An absent or non-token version falls back rather than emitting a header a parser cannot
  // read back or, worse, forging a second product pair with a `/`.
  for (const value of [undefined, '', '   ', 'v', 'bad value', 'bad/1.0', 'v1\u0000', 'v1\nX-Injected: 1', '-1.0']) {
    assert.equal(playgroundUserAgent(value), 'Oh-My-CPA/0.1.0', `value=${JSON.stringify(value)}`);
  }
  // The separators releases actually use stay legal.
  assert.equal(playgroundUserAgent('v1.2.3-rc.1+build.7'), 'Oh-My-CPA/1.2.3-rc.1+build.7');
});

test('the effective model follows the override everywhere it is named', () => {
  // The selector is not always the model that was called: `custom_body` outranks it. Every
  // surface that names or filters by the model reads this, so a turn cannot be labelled with
  // one model and filtered by another.
  const request = { ...makeTurn().request, model: 'selected', custom_body: { model: 'overridden' } as Record<string, unknown> };
  assert.equal(effectiveModel(request), 'overridden');

  // A blank or non-string override is not a model, so the selection stands.
  for (const override of ['   ', 42, null, undefined, {}]) {
    assert.equal(effectiveModel({ ...request, custom_body: { model: override } as Record<string, unknown> }), 'selected', JSON.stringify(override));
  }
  // No override at all is the ordinary case.
  assert.equal(effectiveModel(makeTurn().request), 'alias/model');
});

test('a stored session carries no oversized image bytes anywhere in the turn', () => {
  // Redacting only `turn.user.content` left the same bytes in `turn.request.messages`, which
  // is the snapshot the turn was built from and carries every earlier turn's images as
  // history - so the copies that weighed the most were the ones that were kept.
  const oversized = 'data:image/png;base64,' + 'A'.repeat(STORED_IMAGE_URL_LIMIT + 1);
  const small = 'data:image/png;base64,' + 'B'.repeat(64);
  const turn = {
    ...makeTurn(),
    user: { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }, { type: 'image_url' as const, image_url: { url: oversized } }] },
    request: {
      ...makeTurn().request,
      messages: [{ role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: oversized } }] }],
      custom_body: { nested: { deep: oversized } } as Record<string, unknown>,
    },
  };
  const stored = JSON.stringify(sanitizeTurnsForStorage([turn]));
  assert.equal(stored.includes('A'.repeat(STORED_IMAGE_URL_LIMIT + 1)), false, 'oversized bytes must not survive anywhere');
  assert.equal(stored.includes('"<image omitted>"'), true, 'the placeholder marks where an image was');

  // A small image is still stored, so a retry against it keeps working.
  const withSmall = { ...turn, user: { role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: small } }] }, request: { ...turn.request, messages: [], custom_body: undefined } };
  const storedSmall = JSON.stringify(sanitizeTurnsForStorage([withSmall]));
  assert.equal(storedSmall.includes(small), true, 'an image under the limit is kept');
});

test('a restored conversation replays without unusable image URLs', () => {
  // A redacted placeholder is not a URL. Replaying it would make the gateway reject the whole
  // request as `invalid_image`, so the image is dropped - and a turn that was only an image is
  // dropped with it, because a message with no content is not a message.
  const oversized = 'data:image/png;base64,' + 'A'.repeat(STORED_IMAGE_URL_LIMIT + 1);
  const textTurn = {
    ...makeTurn(), status: 'success' as const, reply: 'answer',
    user: { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }, { type: 'image_url' as const, image_url: { url: oversized } }] },
  };
  const imageOnlyTurn = { ...makeTurn(), id: 'only-image', user: { role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: oversized } }] } };
  const history = buildHistory(sanitizeTurnsForStorage([textTurn, imageOnlyTurn]));
  const types = history.flatMap(message => message.content.map(part => part.type));
  assert.equal(types.includes('image_url'), false, 'no unusable image URL is replayed');
  assert.equal(types.includes('text'), true, 'the text that is still available is replayed');
  for (const message of history) assert.notEqual(message.content.length, 0, 'no empty message is replayed');
  // In memory, before redaction, the image is still replayed: the drop is about restoration.
  assert.equal(buildHistory([textTurn]).some(message => message.content.some(part => part.type === 'image_url')), true);
});

test('session restoration rejects malformed nested turns without crashing later consumers', () => {
  const valid = makeTurn();
  for (const bad of [
    { ...valid, user: null }, { ...valid, user: { role: 'user', content: [{}] } },
    { ...valid, request: {} }, { ...valid, request: { ...valid.request, messages: [null] } },
    { ...valid, status: 'invented' }, { ...valid, usage: { total_tokens: 'wrong' } },
    { ...valid, reply: {} }, { ...valid, thought: {} }, { ...valid, requestID: 42 },
  ]) assert.equal(parsePlaygroundSession({ turns: [bad, valid] })?.turns?.length, 1);
  // A restored turn keeps the id its drill-down needs.
  const withID = { ...valid, requestID: '0000002a', events: [{ type: 'request', request_id: '0000002a' }, { type: 'request', request_id: 42 }] };
  const restored = parsePlaygroundSession(JSON.parse(JSON.stringify({ turns: [withID] })))?.turns?.[0];
  assert.equal(restored?.requestID, '0000002a');
  assert.deepEqual(restored?.events, [{ type: 'request', request_id: '0000002a' }]);
});
test('storage redacts diagnostics and avoids quadratic historical snapshots', () => {
  const turns = Array.from({ length: 10 }, (_, index) => ({ ...makeTurn(), id: String(index), request: { ...makeTurn().request, messages: Array(index + 1).fill(makeTurn().user) } }));
  turns[0].events = [{ type: 'delta', content: 'data:image/png;base64,' + 'A'.repeat(STORED_IMAGE_URL_LIMIT + 1) }];
  const stored = sanitizeTurnsForStorage(turns);
  assert.equal(stored[0].events[0].content, '<image omitted>');
  assert.equal(stored[8].request.messages.length, 1);
  assert.equal(stored[8].hasOmittedHistory, true);
  assert.equal(stored[9].request.messages.length, 10);
  assert.equal(turns[8].request.messages.length, 9);
});

test('the custom body is one JSON object or nothing, and says which as it is typed', () => {
  assert.deepEqual(readCustomBody(''), { ok: true });
  assert.deepEqual(readCustomBody('   '), { ok: true });
  assert.deepEqual(readCustomBody('{"seed": 42}'), { ok: true, value: { seed: 42 } });
  for (const invalid of ['[1, 2]', '42', 'null', '"text"', '{"seed":', 'seed: 42']) {
    assert.deepEqual(readCustomBody(invalid), { ok: false }, invalid);
  }
});

test('an unset parameter is left out of the request so the model default applies', () => {
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] };
  const target = { fingerprint: 'hmac:key', model: 'alias', endpoint: 'chat' as const };
  const minimal = buildChatRequest(target, DEFAULT_PLAYGROUND_PARAMETERS, undefined, [], user);
  // Chat Completions is the default and is left out, so a turn stored before the endpoint could
  // be chosen and a new one read the same.
  assert.deepEqual(Object.keys(minimal).sort(), ['client_key_fingerprint', 'messages', 'model']);
  assert.equal(buildChatRequest({ ...target, endpoint: 'responses' }, DEFAULT_PLAYGROUND_PARAMETERS, undefined, [], user).endpoint, 'responses');
  const full = buildChatRequest(target, {
    systemPrompt: 'be brief', reasoningEffort: ' high ', temperature: 0, topP: 0.5, maxTokens: 64, userAgent: ' Client/1 ', customBody: '{"seed":1}',
  }, { seed: 1 }, [], user);
  // Zero is a value, not an absence: a temperature of 0 must reach the gateway.
  assert.equal(full.temperature, 0);
  assert.equal(full.reasoning_effort, 'high');
  assert.equal(full.user_agent, 'Client/1');
  assert.deepEqual(full.custom_body, { seed: 1 });
});

test('the stored session round-trips the parameters, and reset means every field is at its default', () => {
  const parameters = { ...DEFAULT_PLAYGROUND_PARAMETERS, systemPrompt: 'sys', temperature: 0.2, customBody: '{}' };
  const stored = parsePlaygroundSession(JSON.parse(JSON.stringify(sessionDocument({ fingerprint: 'fp', model: 'm', endpoint: 'messages' }, parameters, []))));
  assert.ok(stored);
  assert.deepEqual(parametersFromSession(stored), parameters);
  assert.equal(stored.client_key_fingerprint, 'fp');
  assert.equal(stored.endpoint, 'messages');
  assert.equal(parsePlaygroundSession({ endpoint: '/v1/embeddings' })?.endpoint, undefined);
  assert.equal(hasCustomParameters(parameters), true);
  assert.equal(hasCustomParameters(DEFAULT_PLAYGROUND_PARAMETERS), false);
  // Effort is chosen in the composer, so the panel's reset neither counts nor clears it.
  assert.equal(hasCustomParameters({ ...DEFAULT_PLAYGROUND_PARAMETERS, reasoningEffort: 'high' }), false);
});

test('the inspected request is the body its endpoint receives', () => {
  const image = 'data:image/png;base64,AAAA';
  const base = {
    client_key_fingerprint: 'fp', model: 'alias', system_prompt: 'be brief', reasoning_effort: 'high', max_tokens: 64, temperature: 0,
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, { type: 'image_url' as const, image_url: { url: image } }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'seen' }] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'again' }] },
    ],
    custom_body: { metadata: { trace: 'a' } },
  };

  const responses = actualRequest({ ...base, endpoint: 'responses' }) as Record<string, any>;
  assert.equal(responses.instructions, 'be brief');
  assert.equal(responses.max_output_tokens, 64);
  assert.equal(responses.temperature, 0);
  assert.deepEqual(responses.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(responses.input[0].content, [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: image }]);
  assert.equal(responses.input[1].content[0].type, 'output_text');
  assert.equal(responses.messages, undefined);
  assert.deepEqual(responses.metadata, { trace: 'a' });

  const messages = actualRequest({ ...base, endpoint: 'messages' }) as Record<string, any>;
  assert.equal(messages.system, 'be brief');
  assert.equal(messages.max_tokens, 64);
  assert.deepEqual(messages.thinking, { type: 'adaptive' });
  assert.deepEqual(messages.output_config, { effort: 'high' });
  assert.deepEqual(messages.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.equal(messages.messages.length, 3);
  // The schema requires a limit, and "none" is the one effort that means thinking is off.
  const bare = actualRequest({ ...base, endpoint: 'messages', max_tokens: undefined, reasoning_effort: 'none' }) as Record<string, any>;
  assert.equal(bare.max_tokens, 4096);
  assert.deepEqual(bare.thinking, { type: 'disabled' });
  assert.equal(bare.output_config, undefined);

  // Image bytes never reach the panel, in either schema's spelling of an image.
  for (const endpoint of ['responses', 'messages'] as const) {
    const inspected = JSON.stringify(inspectRequest({ ...base, endpoint }));
    assert.equal(inspected.includes('AAAA'), false, endpoint);
    assert.equal(inspected.includes('base64 omitted'), true, endpoint);
  }
  const responsesCurl = buildCurl({ ...base, endpoint: 'responses' }, playgroundUserAgent());
  assert.equal(responsesCurl.includes('"$CPA_BASE_URL/v1/responses"'), true);
  assert.equal(responsesCurl.includes('anthropic-version'), false);
  const messagesCurl = buildCurl({ ...base, endpoint: 'messages' }, playgroundUserAgent());
  assert.equal(messagesCurl.includes('"$CPA_BASE_URL/v1/messages"') && messagesCurl.includes("-H 'anthropic-version: 2023-06-01'"), true);
  assert.equal(buildCurl(base, playgroundUserAgent()).includes('"$CPA_BASE_URL/v1/chat/completions"'), true);
});

test('a retry replays the snapshot and forgets what the failed attempt observed', () => {
  const failed = applyEvent(applyEvent(makeTurn(), { type: 'delta', content: 'partial' }), { type: 'error', code: 'upstream_timeout' });
  const retried = retriedTurn(failed, 'retry-id', 2000000);
  assert.equal(retried.request, failed.request);
  assert.equal(retried.status, 'running');
  assert.equal(retried.reply, '');
  assert.equal(retried.error, undefined);
  assert.equal(retried.startedAt, 2000000);
});

test('a turn whose image did not survive storage is recognised as unreplayable', () => {
  const turn = makeTurn();
  assert.equal(hasOmittedImage(turn), false);
  turn.request.messages[0].content.push({ type: 'image_url', image_url: { url: '<image omitted>' } });
  assert.equal(hasOmittedImage(turn), true);
});

test('the Playground compatibility export shares the neutral ID generator', () => {
  assert.equal(createID, sharedCreateID);
});
