/**
 * The demonstration's replays, asserted without a browser.
 *
 * A replay stands where a model request does, so what it has to get right is the contract the
 * console reads: the events fold into exactly the turn the run then stores, a message with no
 * recording is refused before it is accepted, and nothing in a recording is a fixed date. A
 * browser probe shows the page drawing a replay; this suite proves what it is drawing.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { applyAgentEvent, EMPTY_FRAME } from '../../src/agent/runReducer.ts';
import type { AgentRunRequest } from '../../src/agent/protocol.ts';
import { DEMO_REPLAY_ONLY, replayAgentRun } from '../../src/demo/agentReplay.ts';
import agentRecording from '../../src/demo/agentRecording.json' with { type: 'json' };
import { programOf } from '../../src/agent/openui/program.ts';
import { chunkText, recordingLanguage } from '../../src/demo/pacing.ts';
import { replayPlaygroundChat } from '../../src/demo/playgroundReplay.ts';
import playgroundRecording from '../../src/demo/playgroundRecording.json' with { type: 'json' };
import { resolveRecording } from '../../src/demo/recordingTemplate.ts';
import {
  buildSandboxIdentityArchive,
  countDemoSandboxChanges,
  interceptDemoRequest,
  resetDemoSandbox,
  type DemoSandboxState,
} from '../../src/demo/sandbox.ts';
import { readDemoConversation, resetDemoConversation, writeDemoQuestion } from '../../src/demo/session.ts';
import { applyEvent } from '../../src/pages/playground/state.ts';
import type { ChatRequest, StreamEvent, Turn } from '../../src/pages/playground/state.ts';

const instant = async () => {};
const QUESTION = agentRecording.turn.user;

function runRequest(content: string, language = 'zh'): AgentRunRequest {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    message: { id: 'message-1', content },
    tools: [],
    language,
    forwardedProps: { revision: 0, model: 'demo-model', client_key_fingerprint: 'hmac:demo' },
  };
}

async function fold(request: AgentRunRequest) {
  let frame = EMPTY_FRAME;
  const types: string[] = [];
  for await (const event of replayAgentRun(request, new AbortController().signal, instant)) {
    types.push(event.type);
    frame = applyAgentEvent(frame, event);
  }
  return { frame, types };
}

test('a replayed run folds into the turn it then stores', async () => {
  const { frame, types } = await fold(runRequest(QUESTION.zh));
  assert.equal(frame.isAccepted, true);
  assert.equal(frame.isFinished, true);
  assert.equal(frame.errorCode, '');
  const stored = frame.snapshot?.turns.at(-1);
  assert.ok(stored, 'the run reports the conversation it ended with');
  // The live transcript is replaced by the stored turn when the run ends; equal parts are
  // what keeps anything on screen from moving at that moment.
  assert.deepEqual(frame.parts, stored.parts);
  assert.deepEqual(frame.traces, stored.traces);
  assert.equal(frame.turnId, stored.id);
  assert.equal(stored.user, QUESTION.zh);
  assert.equal(stored.traces.length, stored.calls);
  assert.equal(types.filter(type => type === 'STEP_STARTED').length, stored.rounds);
  assert.equal(types.at(-1), 'RUN_FINISHED');
  assert.deepEqual(readDemoConversation(), frame.snapshot);
});

test('a generated interface arrives as a draft before it settles', async () => {
  const drafts: string[] = [];
  let frame = EMPTY_FRAME;
  for await (const event of replayAgentRun(runRequest(QUESTION.en, 'en'), new AbortController().signal, instant)) {
    frame = applyAgentEvent(frame, event);
    const display = frame.traces.find(trace => trace.name === 'present_openui');
    if (display?.result.status === 'running') drafts.push(display.arguments ?? '');
  }
  assert.ok(drafts.length > 10, 'the program is written over many frames');
  // The program is readable from the argument stream, which is what draws it while it is written.
  assert.ok(drafts.some(draft => /^root = Card\(/.test(programOf(draft))), 'a program is drawn before its call ends');
  assert.match(programOf(frame.traces.find(trace => trace.name === 'present_openui')?.arguments), /^root = Card\([\s\S]*OverviewCardBlock/);
});

test('a message with no recording is refused before it is accepted', async () => {
  const before = readDemoConversation();
  const { frame, types } = await fold(runRequest('What is my quota?'));
  assert.deepEqual(types, ['RUN_ERROR']);
  assert.equal(frame.isAccepted, false);
  assert.equal(frame.errorCode, DEMO_REPLAY_ONLY);
  assert.equal(readDemoConversation(), before);
});

test('the question is accepted as the page offers it in a third reading language', async () => {
  const offered = 'Kira permintaan dan kadar kegagalan setiap hari bagi 7 hari terakhir.';
  assert.equal((await fold(runRequest(offered, 'ms'))).frame.errorCode, DEMO_REPLAY_ONLY);
  writeDemoQuestion(offered);
  const { frame } = await fold(runRequest(offered, 'ms'));
  assert.equal(frame.errorCode, '');
  // A reader in a language the recording is not written in reads the English answer.
  assert.match(programOf(frame.snapshot?.turns.at(-1)?.traces.at(-1)?.arguments), /failure rate/);
  writeDemoQuestion('');
});

test('a second replay continues the conversation and a reset empties it', async () => {
  const current = readDemoConversation();
  assert.ok(current);
  const { frame } = await fold(runRequest(QUESTION.zh));
  assert.equal(frame.snapshot?.turns.length, current.turns.length + 1);
  assert.equal(frame.snapshot?.revision, current.revision + 1);
  const reset = resetDemoConversation(frame.snapshot!);
  assert.deepEqual(reset.turns, []);
  assert.equal(reset.revision, frame.snapshot!.revision + 1);
  assert.equal(readDemoConversation(), reset);
});

test('a stopped replay ends as a cancelled request does', async () => {
  const controller = new AbortController();
  const abortingPace = async () => {
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  };
  await assert.rejects(async () => {
    for await (const _event of replayAgentRun(runRequest(QUESTION.zh), controller.signal, abortingPace)) { /* drained */ }
  }, { name: 'AbortError' });
});

test('a recording is measured from the moment it is replayed', () => {
  const anchorMS = Date.UTC(2031, 0, 3, 9, 5, 0);
  for (const language of ['zh', 'en'] as const) {
    const resolved = JSON.stringify(resolveRecording(agentRecording.turn, anchorMS, language));
    assert.doesNotMatch(resolved, /\{\{/, 'every placeholder resolves');
    assert.match(resolved, /2030-12-27/, 'the window opens seven days before the anchor');
    assert.match(resolved, /2031-01-03/);
    assert.match(resolved, /09:05/);
  }
  // The window an answer names is the window it was asked about: the card states it in the reader's language.
  const zh = resolveRecording<{ traces: { arguments: { ui: string } }[] }>(agentRecording.turn, anchorMS, 'zh');
  assert.match(zh.traces.at(-1)!.arguments.ui, /2030 年 12 月 27 日 09:05 – 1 月 3 日 09:05/);
  const en = resolveRecording<{ traces: { arguments: { ui: string } }[] }>(agentRecording.turn, anchorMS, 'en');
  assert.match(en.traces.at(-1)!.arguments.ui, /From Dec 27, 2030 09:05 to Jan 3 09:05/);
  // Fields that hold instants are numbers on the wire, not digits in a string.
  const call = resolveRecording<{ traces: { arguments: { from_ms: unknown; to_ms: unknown } }[] }>(agentRecording.turn, anchorMS, 'en').traces[0];
  assert.equal(call.arguments.to_ms, anchorMS);
  assert.equal(call.arguments.from_ms, anchorMS - 7 * 24 * 3_600_000);
});

test('the recorded figures agree with each other', () => {
  // The demonstration cannot read rows it did not receive, so its program carries them; the card
  // derives every figure from them rather than restating a number nobody checked.
  const rows = [...agentRecording.turn.traces.at(-1)!.arguments.ui.en.matchAll(/\{day: "[^"]+", requests: (\d+), failures: (\d+), failure_rate: ([\d.]+)\}/g)]
    .map(([, requests, failures, rate]) => ({ requests: Number(requests), failures: Number(failures), rate: Number(rate) }));
  assert.equal(rows.length, 8, 'one row per day of the window');
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  const failures = rows.reduce((sum, row) => sum + row.failures, 0);
  assert.equal(requests, 1632);
  assert.equal(failures, 88);
  for (const row of rows) assert.equal(row.rate, Math.round(1e4 * row.failures / row.requests) / 1e4);
  for (const language of ['zh', 'en'] as const) {
    const program = agentRecording.turn.traces.at(-1)!.arguments.ui[language];
    assert.ok(program.includes('@Sum(rows.requests)'), `${language}: the total is read from the rows`);
    assert.ok(program.includes('@Round(100 * @Sum(rows.failures) / @Sum(rows.requests), 1)'), `${language}: the rate is read from the rows`);
  }
});

test('text is cut on whole characters', () => {
  assert.deepEqual(chunkText('a😀b中', 2), ['a😀', 'b中']);
  assert.equal(recordingLanguage('zh-Hant'), 'zh');
  assert.equal(recordingLanguage('ms'), 'en');
  assert.equal(recordingLanguage(undefined), 'en');
});

test('a replayed Playground answer folds into a finished turn', async () => {
  const request = { model: 'demo-model', client_key_fingerprint: 'hmac:demo', messages: [] } as unknown as ChatRequest;
  for (const language of ['zh', 'en'] as const) {
    let turn = { id: 'turn-1', request, keyLabel: '', user: { role: 'user', content: [] }, reply: '', status: 'running', startedAt: Date.now(), events: [], eventBytes: 0, isTruncated: false } as unknown as Turn;
    const events: StreamEvent[] = [];
    await replayPlaygroundChat(request, new AbortController().signal, event => {
      events.push(event);
      turn = applyEvent(turn, event);
    }, language, instant);
    assert.equal(turn.status, 'success');
    assert.equal(turn.reply, playgroundRecording.reply[language]);
    assert.equal(turn.thought, playgroundRecording.thought);
    assert.deepEqual(turn.usage, playgroundRecording.usage);
    assert.equal(events[0].type, 'meta');
    assert.equal(events[0].model, 'demo-model');
    assert.equal(events.at(-1)?.type, 'done');
  }
});

test('demo sandbox isolates provider, api key, routing, and reset state', async () => {
  resetDemoSandbox();
  try {
    assert.equal(countDemoSandboxChanges(), 0);

  const baselineFixtures: Record<string, unknown> = {
    '/management/api-keys?include_keys=true': {
      keys: [{ key: 'sk-omc-baseline-1234', fingerprint: 'fp-1', usage_fingerprint: 'ufp-1' }],
      total: 1,
    },
    '/management/providers?include_keys=true': {
      providers: [
        {
          id: 'openai-compatibility-0',
          family: 'openai-compatibility',
          name: 'DeepSeek Direct',
          upstream_name: 'DeepSeek Direct',
          base_url: 'https://api.deepseek.com/v1',
          disabled: false,
          priority: 1,
          models: ['deepseek-v4.1-flash-1017'],
          model_entries: [{ name: 'deepseek-v4.1-flash-1017', alias: 'deepseek-flash' }],
          api_key_entries: [{ id: 'k-0', api_key: 'sk-ds-demo', mask: 'sk-ds•••demo' }],
        },
      ],
      total: 1,
    },
    '/management/auth-files': {
      files: [
        {
          name: 'antigravity-studio.json',
          auth_index: 'auth-antigravity-01',
          type: 'antigravity',
          provider: 'antigravity',
          disabled: false,
          unavailable: false,
          runtime_only: false,
          success: 120,
          failed: 1,
          priority: 10,
          weight: 5,
          models: [{ id: 'gemini-4-hydrogen', display_name: 'Gemini 4 Hydrogen' }],
        },
      ],
    },
    '/management/routing': {
      revision: 'rev-1',
      settings: {
        strategy: 'priority',
        session_affinity: true,
        session_affinity_ttl: 300,
        request_retry: 2,
        max_retry_credentials: 2,
        max_retry_interval: 10,
        disable_cooling: false,
        transient_error_cooldown_seconds: 60,
      },
      tiers: [
        {
          priority: 10,
          members: [{ key: 'credential:antigravity-studio.json', kind: 'credential', label: 'Antigravity Ultra', priority: 10, weights: [] }],
        },
      ],
    },
    '/management/model-square': {
      models: [{ id: 'deepseek-flash', call_point: 'deepseek-flash', vision: 'unknown' }],
      routes: [{ provider_id: 'openai-compatibility-0', upstream_model: 'deepseek-v4.1-flash-1017', call_point: 'deepseek-flash' }],
    },
    '/management/audit/events': { events: [], next_cursor: '' },
  };

  const fetchBaseline = async (path: string) => {
    const body = baselineFixtures[path] ?? baselineFixtures[path.split('?')[0]];
    if (!body) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // Create API key & verify readback excludes raw secret
  const submittedSecretKey = 'demo-test-caller-key-123';
  const createKeyRes = await interceptDemoRequest(
    '/management/api-keys',
    { method: 'POST', body: JSON.stringify({ key: submittedSecretKey }) },
    fetchBaseline,
  );
  assert.ok(createKeyRes && createKeyRes.status === 200);
  const keysAfterRes = await interceptDemoRequest('/management/api-keys?include_keys=true', { method: 'GET' }, fetchBaseline);
  const keysAfter = (await keysAfterRes!.json()) as { keys: Array<{ key: string }> };
  assert.equal(keysAfter.keys.length, 2);
  assert.ok(!keysAfter.keys.some((k) => k.key === submittedSecretKey), 'sandbox must never retain submitted raw caller keys');

  // Create provider and verify Model Square automatically picks up its model
  const createProvRes = await interceptDemoRequest(
    '/management/providers',
    {
      method: 'POST',
      body: JSON.stringify({
        family: 'openai-compatibility',
        name: 'Antigravity Edge Mirror',
        base_url: 'https://antigravity.example/v1',
        priority: 3,
        disabled: false,
        keys: [{ api_key: 'demo-test-provider-key-1' }],
        model_entries: [{ name: 'gemini-4-hydrogen', alias: 'g4-hydrogen-edge' }],
      }),
    },
    fetchBaseline,
  );
  assert.ok(createProvRes && createProvRes.status === 200);
  const createdProvPayload = (await createProvRes!.json()) as { id: string };

  // Deleting the highest-numbered provider and creating another must not reuse the deleted ID
  const deleteProvRes = await interceptDemoRequest(
    `/management/providers/${encodeURIComponent(createdProvPayload.id)}`,
    { method: 'DELETE' },
    fetchBaseline,
  );
  assert.ok(deleteProvRes && deleteProvRes.status === 200);
  const recreateProvRes = await interceptDemoRequest(
    '/management/providers',
    {
      method: 'POST',
      body: JSON.stringify({
        family: 'openai-compatibility',
        name: 'Antigravity Edge Mirror 2',
        base_url: 'https://antigravity.example/v1',
        priority: 3,
        disabled: false,
        keys: [{ api_key: 'demo-test-provider-key-2' }],
        model_entries: [{ name: 'gemini-4-hydrogen', alias: 'g4-hydrogen-edge' }],
      }),
    },
    fetchBaseline,
  );
  assert.ok(recreateProvRes && recreateProvRes.status === 200);
  const recreatedProvPayload = (await recreateProvRes!.json()) as { id: string };
  assert.notEqual(recreatedProvPayload.id, createdProvPayload.id);

  // Verify submitted provider secrets (including active recreated provider) are masked and never retained verbatim
  const providersAfterRes = await interceptDemoRequest('/management/providers?include_keys=true', { method: 'GET' }, fetchBaseline);
  const providersAfterText = await providersAfterRes!.text();
  assert.ok(!providersAfterText.includes('demo-test-provider-key-1') && !providersAfterText.includes('demo-test-provider-key-2'));

  // Proxy URL userinfo is redacted
  const proxyRes = await interceptDemoRequest(
    '/management/outbound-proxy',
    { method: 'PUT', body: JSON.stringify({ mode: 'proxy', url: 'http://demo-user:demo-pass@proxy.local:7890', no_proxy: '' }) },
    fetchBaseline,
  );
  assert.ok(proxyRes && proxyRes.status === 200);
  const proxyJson = (await proxyRes!.json()) as { address: string; has_credentials: boolean };
  assert.equal(proxyJson.address, 'http://••••@proxy.local:7890');
  assert.equal(proxyJson.has_credentials, true);

  // Custom icons accept bare base64 PNG and reject spoofed RIFF non-WebP
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const iconOk = await interceptDemoRequest(
    '/custom-icons',
    { method: 'POST', body: JSON.stringify({ name: 'test-png', data: pngBase64 }) },
    fetchBaseline,
  );
  assert.ok(iconOk && iconOk.status === 200);
  const riffWavBase64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  const iconBad = await interceptDemoRequest(
    '/custom-icons',
    { method: 'POST', body: JSON.stringify({ name: 'bad-riff', data: riffWavBase64 }) },
    fetchBaseline,
  );
  assert.ok(iconBad && iconBad.status === 400);

  // OAuth callback accepts matching waiting state once and rejects duplicate/stale callbacks
  const oauthStart = await interceptDemoRequest(
    '/management/oauth/start',
    { method: 'POST', body: JSON.stringify({ provider: 'codex' }) },
    fetchBaseline,
  );
  const started = (await oauthStart!.json()) as { state: string };
  const cbUrl = `http://localhost:1455/auth/callback?code=ok&state=${encodeURIComponent(started.state)}`;
  const cbFirst = await interceptDemoRequest(
    '/management/oauth/callback',
    { method: 'POST', body: JSON.stringify({ provider: 'codex', redirect_url: cbUrl }) },
    fetchBaseline,
  );
  assert.ok(cbFirst && cbFirst.status === 200);
  const cbDuplicate = await interceptDemoRequest(
    '/management/oauth/callback',
    { method: 'POST', body: JSON.stringify({ provider: 'codex', redirect_url: cbUrl }) },
    fetchBaseline,
  );
  assert.ok(cbDuplicate && cbDuplicate.status === 409);

  // Auth JSON upload & Vertex import are intercepted locally with zero secret retention
  const authUploadRes = await interceptDemoRequest(
    '/management/auth-files?name=custom-oauth.json',
    { method: 'POST', body: JSON.stringify({ provider: 'codex', access_token: 'demo-test-tok', refresh_token: 'demo-test-ref' }) },
    fetchBaseline,
  );
  assert.ok(authUploadRes && authUploadRes.status === 200);
  const vertexImportRes = await interceptDemoRequest(
    '/management/auth-files/vertex-import?location=us-central1',
    { method: 'POST', body: JSON.stringify({ project_id: 'demo-proj', client_email: 'sa@demo-proj.iam.gserviceaccount.com', private_key: 'demo-test-pk-body' }) },
    fetchBaseline,
  );
  assert.ok(vertexImportRes && vertexImportRes.status === 200);
  const authListRes = await interceptDemoRequest('/management/auth-files', { method: 'GET' }, fetchBaseline);
  const authListText = await authListRes!.text();
  assert.ok(!authListText.includes('demo-test-tok') && !authListText.includes('demo-test-pk-body'));

  // Database backup automation strips passphrases/options and export job has kind=export & state=ready
  const autoSaveRes = await interceptDemoRequest(
    '/management/system/database-backup-automation',
    {
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        daily_at_minute: 120,
        keep_local: 7,
        keep_remote: 14,
        passphrase: 'demo-test-passphrase',
        destinations: [{ id: 'd1', name: 'S3', provider: 's3', root: 'bucket', options: { secret_key: 'demo-test-s3-opt' } }],
      }),
    },
    fetchBaseline,
  );
  assert.ok(autoSaveRes && autoSaveRes.status === 200);
  const autoSavedText = await autoSaveRes!.text();
  assert.ok(!autoSavedText.includes('demo-test-passphrase') && !autoSavedText.includes('demo-test-s3-opt'));

  const exportRes = await interceptDemoRequest(
    '/management/system/database-backups',
    { method: 'POST', body: JSON.stringify({ passphrase: 'export-passphrase' }) },
    fetchBaseline,
  );
  assert.ok(exportRes && exportRes.status === 200);
  const exportJob = (await exportRes!.json()) as { id: string; kind: string; state: string };
  assert.equal(exportJob.kind, 'export');
  assert.equal(exportJob.state, 'ready');
  const exportDownloadRes = await interceptDemoRequest(
    `/management/system/database-backups/${encodeURIComponent(exportJob.id)}/download`,
    { method: 'GET' },
    fetchBaseline,
  );
  assert.ok(exportDownloadRes && exportDownloadRes.status === 200);

  const squareRes = await interceptDemoRequest('/management/model-square', { method: 'GET' }, fetchBaseline);
  const square = (await squareRes!.json()) as { models: Array<{ call_point: string }> };
  assert.ok(square.models.some((m) => m.call_point === 'g4-hydrogen-edge'));

  // Audit trail captures sandbox actions
  const auditRes = await interceptDemoRequest('/management/audit/events', { method: 'GET' }, fetchBaseline);
  const audit = (await auditRes!.json()) as { events: Array<{ action: string }> };
  assert.ok(audit.events.some((e) => e.action === 'provider.create'));
  assert.ok(countDemoSandboxChanges() >= 2);

    // Reset restores baseline cleanly
    resetDemoSandbox();
    assert.equal(countDemoSandboxChanges(), 0);
    const keysResetRes = await interceptDemoRequest('/management/api-keys?include_keys=true', { method: 'GET' }, fetchBaseline);
    const keysReset = (await keysResetRes!.json()) as { keys: Array<{ key: string }> };
    assert.equal(keysReset.keys.length, 1);
  } finally {
    resetDemoSandbox();
  }
});

test('sandbox archive marks conflicting deleted baseline providers ambiguous without persisted snapshots', () => {
  const emptyState: DemoSandboxState = {
    version: 1,
    revisionSeq: 1,
    preferences: {},
    apiKeys: { aliasesByFingerprint: {} },
    providers: {
      byId: {},
      deletedIds: ['openai-compat-0', 'openai-compat-1'],
      statusOverrides: {},
      nameOverrides: {},
    },
    config: { backupYamlById: {} },
    authFiles: {
      created: [],
      deletedNames: [],
      statusOverrides: {},
      displayNameOverrides: {},
      safeFieldsOverrides: {},
      recoveredNames: {},
      siwcOverrides: {},
    },
    routing: { settingsOverrides: {}, memberOverrides: {} },
    plugins: { enabledOverrides: {}, deletedIds: [], installed: [], configs: {} },
    pricing: { modelOverrides: {}, channelModelOverrides: {}, dismissedCandidates: {}, channelOverrides: {} },
    quota: { clearedCooldowns: {}, refreshedAt: {}, resetAt: {}, redeemedCredits: {}, warmupRunsAdded: [] },
    customIcons: { created: [], updated: {}, deletedIds: [], dataUrls: {} },
    fonts: { deletedIds: [] },
    system: {},
    auditTrail: [],
    extraLogLines: [],
  };

  const provBase = {
    total: 2,
    providers: [
      {
        id: 'openai-compat-0',
        family: 'openai-compatibility',
        name: 'Relay',
        upstream_name: 'relay',
        protocol: 'OpenAI Chat Completions',
        base_url: 'https://relay-alpha.example/v1',
        auth_indexes: ['idx-shared'],
        disabled: false,
        key_configured: true,
        api_key: 'sk-alpha-1111',
        proxy_configured: false,
      },
      {
        id: 'openai-compat-1',
        family: 'openai-compatibility',
        name: 'Relay',
        upstream_name: 'relay',
        protocol: 'OpenAI Chat Completions',
        base_url: 'https://relay-beta.example/v1',
        auth_indexes: ['idx-shared'],
        disabled: false,
        key_configured: true,
        api_key: 'sk-beta-2222',
        proxy_configured: false,
      },
    ],
  };

  const conflictArchive = buildSandboxIdentityArchive(undefined, provBase, undefined, emptyState, {});
  assert.equal(conflictArchive.archivedProviders.length, 1);
  assert.equal(conflictArchive.archivedProviders[0].provider_key, 'openai-compatible-relay');
  assert.equal(conflictArchive.archivedProviders[0].is_ambiguous, true);
  assert.equal(conflictArchive.archivedCredentials.length, 1);
  assert.equal(conflictArchive.archivedCredentials[0].auth_index, 'idx-shared');
  assert.equal(conflictArchive.archivedCredentials[0].is_ambiguous, true);

  // Single renamed baseline provider matching baseDir immutable claim retains its sandbox name without false ambiguity.
  const singleRenamedState: DemoSandboxState = {
    ...emptyState,
    providers: {
      ...emptyState.providers,
      deletedIds: ['openai-compat-0'],
      nameOverrides: { 'openai-compat-0': 'Relay Custom' },
    },
  };
  const baseDir = {
    providers: [],
    credentials: [],
    plugins: [],
    provider_icons: {},
    archived_credentials: [],
    archived_providers: [
      {
        provider_key: 'openai-compatible-relay',
        kind: 'ai_provider' as const,
        name: 'Relay',
        upstream_name: 'relay',
        family: 'openai-compatibility',
        base_url: 'https://relay-alpha.example/v1',
      },
    ],
    catalog_status: { providers_known: true, credentials_known: true, plugins_known: true },
  };
  const singleArchive = buildSandboxIdentityArchive(
    baseDir,
    { total: 1, providers: [provBase.providers[0]] },
    undefined,
    singleRenamedState,
    {},
  );
  assert.equal(singleArchive.archivedProviders.length, 1);
  assert.equal(singleArchive.archivedProviders[0].name, 'Relay Custom');
  assert.ok(!singleArchive.archivedProviders[0].is_ambiguous);
});
