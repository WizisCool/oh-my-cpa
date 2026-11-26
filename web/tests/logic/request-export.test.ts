import assert from 'node:assert/strict';
import {
  DEFAULT_SENSITIVE_DETAILS,
  EXPORT_ROW_LIMIT,
  effectiveMasks,
  exportPixelRatio,
  exportRows,
  loadedSelectionState,
  setLoadedSelection,
  toggleSelection,
} from '../../src/components/usage/requestSelection.ts';
import { buildRequestExport, REQUEST_EXPORT_SCHEMA } from '../../src/components/usage/requestExportJson.ts';
import {
  buildRequestRecordLog,
  formatRequestRecordLog,
  REQUEST_RECORD_LOG_SCHEMA,
  requestRecordLogFileName,
} from '../../src/components/usage/requestRecordLog.ts';
import { buildRequestSheet, sheetStrings } from '../../src/components/usage/requestSheetModel.ts';
import type { Catalog, MessageKey, MessageVars, TFunc } from '../../src/i18n/catalog.ts';
import enCatalog from '../../src/i18n/locales/en/index.ts';
import zhCatalog from '../../src/i18n/locales/zh/index.ts';
import { modelMarkIconId } from '../../src/types/modelSquare.ts';
import { indexCredentialFiles } from '../../src/types/usageEventIdentity.ts';
import { pluginMultiPortalKeys, pluginOAuthProviderLogos, pluginOAuthProviderTitles } from '../../src/types/pluginOAuthProviders.ts';
import type { UsageEvent } from '../../src/types/usageEvents.ts';
import type { SelectionAnchor } from '../../src/types/rowSelection.ts';
import { test } from 'vitest';

test('request image export uses the same issuing portal name and artwork as the request row', () => {
  const globalLogo = 'https://cdn.example.test/qoder.svg';
  const cnLogo = 'https://cdn.example.test/qoder-cn.svg';
  const plugins = [{
    id: 'qoder-plugin', configured: true, registered: true, enabled: true, effective_enabled: true, config_fields: [],
    supports_oauth: true, oauth_providers: ['qoder', 'qoder-cn'], logo: globalLogo,
    oauth_provider_entries: [{ identifier: 'qoder-cn', name: 'Qoder CN', logo: cnLogo }],
  }];
  const credentials = indexCredentialFiles([
    { name: 'cn.json', auth_index: 'cn', provider: 'qoder', type: 'qoder', oauth_provider: 'qoder-cn' },
  ]);
  const event = {
    id: 1, timestamp_ms: 1_700_000_000_000, provider: 'qoder', auth_type: 'oauth', auth_index: 'cn',
    model: 'example-model', tokens: { input: 1, output: 1, total: 2 },
  } as UsageEvent;
  const sheet = buildRequestSheet({
    rows: [event], masks: effectiveMasks([], []), colWidths: {}, caption: '', t: (key) => key,
    tokenStyle: 'en-compact', tpsMode: 'exclude_ttft', credentials,
    pluginLogos: pluginOAuthProviderLogos(plugins), multiPortalKeys: pluginMultiPortalKeys(plugins),
    pluginTitles: pluginOAuthProviderTitles(plugins),
  });
  assert.equal(sheet.rows[0].cells.provider.mark?.logo, cnLogo);
  assert.ok(sheetStrings(sheet).includes('Qoder CN'));
});

test('request export', () => {
  const rows = [5, 4, 3, 2, 1].map((id) => ({ id, timestamp_ms: id * 1000 }));
  const none = new Map<number, (typeof rows)[number]>();
  const ids = (selection: ReadonlyMap<number, unknown>) => [...selection.keys()].sort();

  const pick = (selection: ReadonlyMap<number, (typeof rows)[number]>, id: number, anchor: SelectionAnchor<number> | null, isRange: boolean) =>
    toggleSelection(selection, rows, id, anchor, isRange);
  const one = pick(none, 4, null, false);
  assert.deepEqual(ids(one.selection), [4]);
  assert.deepEqual(ids(pick(one.selection, 4, one.anchor, false).selection), [], 'a plain click on a selected row clears it');
  const run = pick(one.selection, 2, one.anchor, true);
  assert.deepEqual(ids(run.selection), [2, 3, 4], 'a Shift click selects the run from the anchor');
  assert.deepEqual(ids(pick(run.selection, 3, run.anchor, true).selection), [3, 4], 'a shorter run gives rows back, as on a desktop');
  const other = pick(run.selection, 1, run.anchor, false);
  assert.deepEqual(ids(pick(other.selection, 3, other.anchor, true).selection), [1, 2, 3, 4], 'a new anchor starts its own run and keeps the last one');
  const cleared = pick(run.selection, 4, run.anchor, false);
  assert.deepEqual(ids(pick(cleared.selection, 3, cleared.anchor, true).selection), [2], 'a run from a cleared anchor clears');
  assert.deepEqual(ids(pick(one.selection, 2, { key: 99, isSelected: true, changed: [] }, true).selection), [2, 4], 'an anchor that left the page makes the click plain');
  assert.deepEqual(ids(pick(one.selection, 99, one.anchor, true).selection), [4], 'a row that is not loaded changes nothing');
  const runSelection = run.selection;

  assert.equal(loadedSelectionState(none, rows), 'none');
  assert.equal(loadedSelectionState(runSelection, rows), 'some');
  const otherPage = new Map([[42, { id: 42, timestamp_ms: 1 }]]);
  assert.equal(loadedSelectionState(otherPage, rows), 'none', "another page's rows do not tick this page's header");
  const everything = setLoadedSelection(otherPage, rows, true);
  assert.equal(loadedSelectionState(everything, rows), 'all');
  assert.deepEqual(ids(setLoadedSelection(everything, rows, false)), [42], "clearing the page keeps another page's rows");

  const many = new Map(
    Array.from({ length: EXPORT_ROW_LIMIT + 20 }, (_, index) => [index, { id: index, timestamp_ms: index % 7 }] as const),
  );
  const exported = exportRows(many);
  assert.equal(exported.length, EXPORT_ROW_LIMIT);
  assert.ok(
    exported.every((row, index) => {
      const next = exported[index + 1];
      return !next || row.timestamp_ms > next.timestamp_ms || (row.timestamp_ms === next.timestamp_ms && row.id > next.id);
    }),
    'newest first, the id breaking ties',
  );

  assert.equal(exportPixelRatio(1480, 600), 2);
  const tall = exportPixelRatio(1480, 7000);
  assert.ok(tall < 2 && tall >= 0.5 && 1480 * tall * 7000 * tall <= 16_000_000, `a tall sheet fits the canvas ceiling (${tall})`);
  assert.equal(exportPixelRatio(0, 10), 1);

  assert.deepEqual([...effectiveMasks(DEFAULT_SENSITIVE_DETAILS, [])].sort(), ['key', 'provider_account', 'provider_key']);
  assert.deepEqual([...effectiveMasks([], ['model'])], ['model']);

  const ACCOUNT = 'someone@example.com';
  // The mask as stored with the event, and as the list and the sheet both render it.
  const STORED_KEY_MASK = 'sk-up••••••••4321';
  const PROVIDER_KEY = 'sk-u••••••••21';
  const base = {
    timestamp_ms: 1_700_000_000_000,
    failed: false,
    generate: true,
    latency_ms: 1250,
    ttft_ms: 300,
    cost_usd: 0.0123,
    tokens: { total: 200, input: 150, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
    user_agent: 'codex-cli/1.0',
    client_agent: 'codex-cli',
  } as unknown as UsageEvent;
  const events = [
    { ...base, id: 2, request_id: 'req-oauth', provider: 'claude', model: 'claude-opus', auth_type: 'oauth', auth_index: 'oauth-a', source: 'someone.json', api_group_label: 'api_key', api_key_alias: 'laptop key' },
    { ...base, id: 1, request_id: 'req-key', provider: 'openai', model: 'gpt-5', auth_type: 'apikey', auth_index: 'key-a', source: 'relay', provider_key_mask: STORED_KEY_MASK, api_group_label: 'api_key', api_key_alias: 'laptop key' },
  ] as UsageEvent[];
  const credentials = indexCredentialFiles([
    { name: 'someone.json', auth_index: 'oauth-a', provider: 'claude', type: 'oauth', email: ACCOUNT },
  ]);
  const build = (masks: ReturnType<typeof effectiveMasks>) =>
    sheetStrings(
      buildRequestSheet({
        rows: events,
        masks,
        colWidths: {},
        caption: 'caption',
        t: (key) => key,
        tokenStyle: 'en-compact',
        tpsMode: 'exclude_ttft',
        credentials,
      }),
    ).join('\n');

  const openSheet = buildRequestSheet({
    rows: events,
    masks: effectiveMasks([], []),
    colWidths: {},
    caption: 'caption',
    t: (key) => key,
    tokenStyle: 'en-compact',
    tpsMode: 'exclude_ttft',
    credentials,
  });
  assert.deepEqual(openSheet.rows[0].cells.result.lines, [[
    { kind: 'dot', text: 'events.filter_success', tone: 'success', isWashed: true },
  ]], 'a successful request draws the same tinted status chip as a failed one');
  const failedSheet = buildRequestSheet({
    rows: [{ ...events[0], failed: true }],
    masks: effectiveMasks([], []),
    colWidths: {},
    caption: 'caption',
    t: (key) => key,
    tokenStyle: 'en-compact',
    tpsMode: 'exclude_ttft',
    credentials,
  });
  assert.deepEqual(failedSheet.rows[0].cells.result.lines, [[
    { kind: 'dot', text: 'events.filter_failed', tone: 'danger', isWashed: true },
  ]], 'a failed request draws the danger tinted status chip');
  assert.deepEqual(openSheet.rows[0].cells.client.lines, [[
    { kind: 'mark', mark: { iconId: 'Codex' } },
    { kind: 'text', text: 'Codex', tone: 'fg2', size: 12, weight: 500, isMono: false },
  ]], 'a Codex client draws its brand mark before the Codex label');

  const open = sheetStrings(openSheet).join('\n');
  for (const value of [ACCOUNT, PROVIDER_KEY, 'laptop key', 'req-oauth', 'claude-opus']) {
    assert.ok(open.includes(value), `an unredacted sheet draws ${value}`);
  }

  // The claim an exported picture rests on: a withheld value is not among the
  // strings handed to the painter, so no drawing mistake can put it in the image.
  const byDefault = build(effectiveMasks(DEFAULT_SENSITIVE_DETAILS, []));
  for (const value of [ACCOUNT, 'someone', PROVIDER_KEY, 'laptop key']) {
    assert.ok(!byDefault.includes(value), `the default redaction withholds ${value}`);
  }
  for (const value of ['req-oauth', 'claude-opus', 'gpt-5', 'Claude']) {
    assert.ok(byDefault.includes(value), `the default redaction keeps ${value}`);
  }

  // Both credential types draw the same two lines: the provider, then the
  // credential that answered. Redaction covers the second line and never the first.
  const providerLines = (masks: ReturnType<typeof effectiveMasks>) =>
    buildRequestSheet({ rows: events, masks, colWidths: {}, caption: '', t: (key) => key, tokenStyle: 'en-compact', tpsMode: 'exclude_ttft', credentials })
      .rows.map((row) => row.cells.provider.lines);
  const [oauthLines, keyLines] = providerLines(effectiveMasks([], []));
  assert.deepEqual(oauthLines, [
    [{ kind: 'text', text: 'Claude', tone: 'fg', size: 13, weight: 500, isMono: false }, { kind: 'tag', text: 'OAuth', tone: 'fg2' }],
    [{ kind: 'text', text: ACCOUNT, tone: 'muted', size: 11, weight: 400, isMono: false }],
  ], 'an OAuth cell is its provider, then the account');
  assert.equal(keyLines.length, 2, 'an API-key cell is its provider, then the masked key');
  assert.deepEqual(keyLines[1], oauthLines[1].map((segment) => ({ ...segment, text: PROVIDER_KEY })), 'both credential lines are drawn alike');
  const [oauthRedacted, keyRedacted] = providerLines(effectiveMasks(DEFAULT_SENSITIVE_DETAILS, []));
  assert.deepEqual(oauthRedacted[0], oauthLines[0], 'withholding the account keeps the provider name');
  assert.deepEqual([oauthRedacted[1], keyRedacted[1]], [[{ kind: 'mask' }], [{ kind: 'mask' }]], 'each withheld credential is a bar on its own line');

  const idsHidden = build(effectiveMasks(['request_id'], []));
  assert.ok(!idsHidden.includes('req-oauth') && !idsHidden.includes('req-key') && idsHidden.includes(ACCOUNT));

  const modelHidden = build(effectiveMasks([], ['model']));
  assert.ok(!modelHidden.includes('claude-opus') && !modelHidden.includes('gpt-5') && modelHidden.includes('events.col_model'),
    'a redacted column keeps its heading and loses its values');

  // How a request was made is its own column, so it is withheld on its own: hiding
  // the model keeps the effort, and hiding the mode keeps the model.
  const moded = [{ ...events[1], reasoning_effort: 'xhigh', stream: false, ttft_ms: undefined }] as UsageEvent[];
  const modeSheet = (masks: ReturnType<typeof effectiveMasks>) =>
    buildRequestSheet({ rows: moded, masks, colWidths: {}, caption: 'caption', t: (key) => key, tokenStyle: 'en-compact', tpsMode: 'exclude_ttft', credentials });
  const modeCell = modeSheet(effectiveMasks([], [])).rows[0].cells.mode.lines;
  assert.deepEqual(modeCell, [[
    { kind: 'tag', text: 'xHigh', tone: 'fg2', effortStep: 5 },
    { kind: 'glyph', glyph: 'non_stream', tone: 'muted', isBoxed: true },
  ]], 'the mode cell draws the effort on its scale step, then the non-streaming mark');
  assert.equal(modeSheet(effectiveMasks([], [])).rows[0].cells.model.lines.length, 1, 'the model cell is the name alone');

  // The picture carries the model's mark when the list does, resolved the way the list resolves it.
  const markedModel = (event: UsageEvent, showModelIcons: boolean) =>
    buildRequestSheet({ rows: [event], masks: effectiveMasks([], []), colWidths: {}, caption: '', t: (key) => key, tokenStyle: 'en-compact', tpsMode: 'exclude_ttft', credentials, showModelIcons })
      .rows[0].cells.model.lines[0][0];
  assert.deepEqual(markedModel(events[0], true), { kind: 'mark', mark: { iconId: modelMarkIconId('claude-opus') } }, 'a known model is drawn with its maker\'s mark');
  assert.ok(modelMarkIconId('claude-opus'), 'the fixture model resolves to a maker');
  assert.deepEqual(markedModel({ ...events[0], model: 'house-model-7' } as UsageEvent, true), { kind: 'glyph', glyph: 'model', tone: 'muted' },
    'a model with no maker is drawn with the neutral mark, as the list draws it');
  assert.equal(markedModel(events[0], false).kind, 'text', 'with model marks turned off the line starts with the name');
  assert.deepEqual(
    buildRequestSheet({ rows: [events[1]], masks: effectiveMasks([], []), colWidths: {}, caption: '', t: (key) => key, tokenStyle: 'en-compact', tpsMode: 'exclude_ttft', credentials }).rows[0].cells.mode.lines,
    [[{ kind: 'text', text: '—', tone: 'muted', size: 12, weight: 400, isMono: false }]],
    'a request with nothing to mark draws a dash, not an empty cell',
  );

  // Duration is one reading on one ramp; TTFT stays secondary and is never painted.
  const latencySheet = (event: UsageEvent) =>
    buildRequestSheet({ rows: [event], masks: effectiveMasks([], []), colWidths: {}, caption: '', t: (key) => key, tokenStyle: 'en-compact', tpsMode: 'exclude_ttft', credentials })
      .rows[0].cells.latency.lines;
  const durationOf = (event: UsageEvent) => {
    const segment = latencySheet(event)[0][0];
    assert.ok(segment.kind === 'duration', 'the duration is drawn from its ramp, not from a fixed tone');
    return segment;
  };
  assert.equal(durationOf(events[0]).text, '1.25 s');
  assert.deepEqual(latencySheet(events[0])[1], [
    { kind: 'text', text: 'TTFT', tone: 'muted', size: 11, weight: 400, isMono: false },
    { kind: 'text', text: '300 ms', tone: 'muted', size: 11, weight: 400, isMono: false },
  ], 'TTFT is request detail and keeps the secondary ink');
  // A green start, an even middle and an orange end: the ramp is continuous rather than banded.
  assert.equal(durationOf({ ...events[0], latency_ms: 0 }).mix.fromShare, '100%', 'an instant sits at the green end');
  assert.equal(durationOf({ ...events[0], latency_ms: 30_000 }).mix.fromShare, '50%', 'half a minute is halfway along');
  assert.equal(durationOf({ ...events[0], latency_ms: 60_000 }).mix.fromShare, '0%', 'a minute is the orange end');
  assert.equal(durationOf({ ...events[0], latency_ms: 300_000 }).mix.fromShare, '0%', 'past a minute the ramp has nothing left to say');
  // Two readings inside what used to be one band must no longer paint alike.
  assert.notEqual(durationOf({ ...events[0], latency_ms: 1_000 }).mix.fromShare, durationOf({ ...events[0], latency_ms: 14_999 }).mix.fromShare,
    'duration is continuous, so two readings in one old band still differ');
  for (const ttft of [undefined, null, 0, -1, 65_000, 65_001, Number.NaN]) {
    assert.equal(latencySheet({ ...events[0], latency_ms: 65_000, ttft_ms: ttft }).length, 1,
      'image export omits unavailable TTFT rather than painting it');
  }
  // A record with no duration has no ramp to sit on: the sheet falls back to the plain ink.
  const missingDuration = latencySheet({ ...events[0], latency_ms: undefined as unknown as number })[0][0];
  assert.ok(missingDuration.kind === 'text' && missingDuration.tone === 'fg', 'a missing duration is not a fast one');
  const fastSheet = buildRequestSheet({
    rows: [{ ...events[1], provider: 'codex', service_tier: 'priority', response_service_tier: 'default', resolved_service_tier: 'priority', resolved_service_tier_source: 'request' }] as UsageEvent[],
    masks: effectiveMasks([], []), colWidths: {}, caption: '', t: (key) => key, tokenStyle: 'en-compact', tpsMode: 'exclude_ttft', credentials,
  });
  assert.deepEqual(fastSheet.rows[0].cells.mode.lines, [[{ kind: 'glyph', glyph: 'fast', tone: 'accent', isBoxed: true, isFilled: true }]],
    'a Codex request resolved as priority draws the lightning mark despite its default response');
  const tierExport = buildRequestExport({
    rows: [{ ...events[1], provider: 'codex', service_tier: 'priority', response_service_tier: 'default', resolved_service_tier: 'priority', resolved_service_tier_source: 'request' }],
    masks: effectiveMasks([], []), exportedAt: new Date(0), tpsMode: 'exclude_ttft', credentials,
  }).requests[0];
  assert.equal(tierExport.service_tier, 'priority');
  assert.equal(tierExport.response_service_tier, 'default');
  assert.equal(tierExport.resolved_service_tier, 'priority');
  assert.equal(tierExport.resolved_service_tier_source, 'request');
  const hiddenTierExport = buildRequestExport({
    rows: [{ ...events[1], resolved_service_tier: 'priority', resolved_service_tier_source: 'request' }],
    masks: effectiveMasks([], ['mode']), exportedAt: new Date(0), tpsMode: 'exclude_ttft', credentials,
  }).requests[0];
  assert.ok(!('resolved_service_tier' in hiddenTierExport) && !('resolved_service_tier_source' in hiddenTierExport));
  const modeHidden = sheetStrings(modeSheet(effectiveMasks([], ['mode'])));
  assert.ok(!modeHidden.includes('xHigh') && modeHidden.includes('gpt-5'), 'hiding the mode column keeps the model');
  const modeJson = (columns: Parameters<typeof effectiveMasks>[1]) =>
    buildRequestExport({ rows: moded, masks: effectiveMasks([], columns), exportedAt: new Date(0), tpsMode: 'exclude_ttft', credentials }).requests[0];
  assert.equal(modeJson(['model']).reasoning_effort, 'xhigh', 'the JSON keeps the effort when only the model is withheld');
  assert.equal(modeJson(['model']).model, undefined);
  assert.ok(!('reasoning_effort' in modeJson(['mode'])) && !('stream' in modeJson(['mode'])) && modeJson(['mode']).model === 'gpt-5',
    'the JSON withholds the mode fields with the mode column');

  // The JSON document makes the same promise in a form a program reads: stored
  // values, and a withheld field absent rather than blanked.
  const exportJson = (masks: ReturnType<typeof effectiveMasks>) =>
    buildRequestExport({
      rows: [{ ...events[0], api_group_key: 'fingerprint-of-a-secret' }, events[1]],
      masks,
      exportedAt: new Date(0),
      tpsMode: 'exclude_ttft',
      credentials,
    });
  const openDocument = exportJson(effectiveMasks([], []));
  assert.equal(openDocument.schema, REQUEST_EXPORT_SCHEMA);
  assert.equal(openDocument.count, 2);
  assert.deepEqual(openDocument.redacted, []);
  assert.deepEqual(openDocument.requests[0], {
    id: 2,
    timestamp: '2023-11-14T22:13:20.000Z',
    timestamp_ms: 1_700_000_000_000,
    request_id: 'req-oauth',
    failed: false,
    generate: true,
    provider: 'claude',
    auth_type: 'oauth',
    auth_index: 'oauth-a',
    account: ACCOUNT,
    source: 'someone.json',
    model: 'claude-opus',
    latency_ms: 1250,
    ttft_ms: 300,
    tokens_per_second: (50 * 1000) / 950,
    tps_basis: 'exclude_ttft',
    tps_mode: 'exclude_ttft',
    tokens: { total: 200, input: 150, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
    cost_usd: 0.0123,
    api_key_alias: 'laptop key',
    client_agent: 'codex-cli',
    user_agent: 'codex-cli/1.0',
  });
  assert.ok(!JSON.stringify(openDocument).includes('fingerprint-of-a-secret'), "a key's fingerprint is never exported");

  const redactedDocument = exportJson(effectiveMasks(DEFAULT_SENSITIVE_DETAILS, ['cache']));
  const redactedBody = JSON.stringify(redactedDocument);
  for (const value of [ACCOUNT, 'someone', PROVIDER_KEY, 'laptop key']) {
    assert.ok(!redactedBody.includes(value), `the default redaction keeps ${value} out of the document`);
  }
  assert.deepEqual(redactedDocument.redacted, ['cache', 'key', 'provider_account', 'provider_key']);
  assert.equal(redactedDocument.requests[0].auth_index, 'oauth-a', 'requests still group by the account that answered');
  assert.equal(redactedDocument.requests[1].source, 'relay', 'a key provider keeps its source');
  assert.deepEqual(redactedDocument.requests[0].tokens, { total: 200, input: 150, output: 50, reasoning: 0 });
  // Withholding the client column takes the client and the User-Agent it was read from.
  const clientless = exportJson(effectiveMasks([], ['client']));
  assert.deepEqual(clientless.redacted, ['client']);
  assert.ok(!JSON.stringify(clientless).includes('codex-cli'), 'a withheld client leaves no trace of its User-Agent');


  const outboundEvent: UsageEvent = { ...events[1], service_tier: 'auto', effective_service_tier: 'priority', response_service_tier: 'default', resolved_service_tier: 'priority', resolved_service_tier_source: 'outbound' };
  const outboundExport = buildRequestExport({ rows: [outboundEvent], masks: effectiveMasks([], []), exportedAt: new Date(0), tpsMode: 'exclude_ttft', credentials }).requests[0];
  assert.equal(outboundExport.effective_service_tier, 'priority');
  assert.equal(outboundExport.service_tier, 'auto');
  assert.equal(outboundExport.response_service_tier, 'default');
  assert.equal(outboundExport.resolved_service_tier_source, 'outbound');
  const hiddenOutboundExport = buildRequestExport({ rows: [outboundEvent], masks: effectiveMasks([], ['mode']), exportedAt: new Date(0), tpsMode: 'exclude_ttft', credentials }).requests[0];
  assert.ok(!('effective_service_tier' in hiddenOutboundExport));
});

test('single-record OMC log captures full diagnostics, masks identities, and formats .log/.json cleanly', () => {
  const RAW_EMAIL = 'alice.operator@example.com';
  const SECRET_FINGERPRINT = 'hmac:deadbeef-client-key-fingerprint';
  const credentials = indexCredentialFiles([
    { name: `codex-${RAW_EMAIL}.json`, auth_index: 'oauth-1', provider: 'codex', type: 'oauth', email: RAW_EMAIL },
  ]);

  const doc = buildRequestRecordLog({
    detail: {
      event: {
        id: 88,
        event_key: 'evt-88',
        request_id: 'req-abc-88',
        timestamp_ms: 1_700_000_000_000,
        provider: 'codex',
        endpoint: '/v1/responses',
        executor_type: 'CodexWebsocketsExecutor',
        auth_type: 'oauth',
        auth_index: 'oauth-1',
        api_group_key: SECRET_FINGERPRINT,
        api_group_label: 'api_key',
        api_key_alias: 'cli-laptop',
        api_key_mask: 'sk-ab••••••••90',
        source: `codex-${RAW_EMAIL}.json`,
        resource_name: `codex-${RAW_EMAIL}.json`,
        model: 'gpt-5',
        model_alias: 'fast-gpt',
        response_model: 'gpt-5-2026-01',
        model_substituted: true,
        reasoning_effort: 'high',
        service_tier: 'auto',
        effective_service_tier: 'priority',
        response_service_tier: 'priority',
        resolved_service_tier: 'priority',
        resolved_service_tier_source: 'outbound',
        failed: true,
        fail_status_code: 429,
        fail_code: 'force_cooldown',
        fail_body: `{"error":{"message":"Account ${RAW_EMAIL} is disabled due to rate limit"}}`,
        response_headers: [
          { name: 'retry-after', value: '30' },
          { name: 'x-account-hint', value: `owner=${RAW_EMAIL}` },
          { name: 'x-request-id', value: 'up-88' },
        ],
        access_provider: 'native-config',
        is_native_key: true,
        generate: true,
        stream: true,
        latency_ms: 2500,
        ttft_ms: 500,
        tokens: { input: 1000, output: 200, reasoning: 50, cached: 400, cache_read: 400, cache_creation: 0, total: 1200 },
        accounting_status: 'complete',
        has_request_log: false,
        cost_usd: 0.042,
        pricing_status: 'priced',
        price_version_id: 7,
        client_ip: '203.0.113.10',
        x_forwarded_for: '198.51.100.2',
        user_agent: 'codex-cli/0.41',
        client_agent: 'codex-cli',
        client_agent_category: 'agent',
        structured_usage: { tool_usage_details: { web_search_calls: 0, mcp_calls: 2 }, is_partial: false },
      },
      related_errors: [{
        id: 19,
        status_code: 429,
        code: 'rate_limit',
        body: `Account ${RAW_EMAIL} exceeded quota`,
        retryable: true,
        quota_exceeded: true,
        quota_reason: `rpm_exceeded for ${RAW_EMAIL}`,
        timestamp_ms: 1_700_000_005_000,
      }],
      cost_breakdown: {
        status: 'priced',
        stored_nanos: 42_000_000,
        service_tier: 'priority',
        service_tier_source: 'outbound',
        recomputed_matches: true,
      },
    },
    tpsMode: 'exclude_ttft',
    exportedAt: new Date(1_700_000_010_000),
    credentials,
  });

  const makeT = (catalog: Catalog): TFunc => (key: MessageKey, vars?: MessageVars) =>
    Object.entries(vars ?? {}).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      catalog[key],
    );

  assert.equal(doc.schema, REQUEST_RECORD_LOG_SCHEMA);
  assert.equal(doc.request.status, 'failed');
  assert.equal(doc.request.transport, 'websocket');
  assert.equal(doc.model.served, 'gpt-5-2026-01');
  assert.equal(doc.model.substituted, true);
  assert.equal(doc.timing.ttft_ms, 500);
  assert.equal(doc.upstream?.fail_status_code, 429);
  assert.equal(doc.upstream?.fail_code, 'force_cooldown');
  assert.ok(doc.upstream?.fail_body?.includes('is disabled due to rate limit'), 'diagnostic message stays intact after account masking');
  assert.equal(doc.related_errors?.length, 1);
  assert.ok(doc.related_errors?.[0].body?.includes('exceeded quota'), 'correlated error diagnostic message stays intact');
  assert.ok(doc.related_errors?.[0].quota_reason?.includes('rpm_exceeded'), 'quota reason diagnostic text stays intact');
  assert.equal(doc.structured_usage?.tool_usage_details?.web_search_calls, 0);

  const jsonBody = JSON.stringify(doc);
  const enTextBody = formatRequestRecordLog(doc, makeT(enCatalog));
  const zhTextBody = formatRequestRecordLog(doc, makeT(zhCatalog));
  for (const serialized of [jsonBody, enTextBody, zhTextBody]) {
    assert.ok(!serialized.includes(SECRET_FINGERPRINT), 'HMAC key fingerprint must never appear in record logs');
    assert.ok(!serialized.includes(RAW_EMAIL), 'raw OAuth email must stay masked in record logs and error bodies');
  }
  assert.ok(enTextBody.includes('=== Request details ==='));
  assert.ok(enTextBody.includes('=== Request parameters ==='));
  assert.ok(enTextBody.includes('=== Source & routing ==='));
  assert.ok(enTextBody.includes('=== Timing & tokens ==='));
  assert.ok(enTextBody.includes('=== Cost breakdown ==='));
  assert.ok(enTextBody.includes('=== Upstream usage details ==='));
  assert.ok(enTextBody.includes('=== Client information ==='));
  assert.ok(enTextBody.includes('=== Upstream response ==='));
  assert.ok(enTextBody.includes('retry-after: 30'));
  assert.ok(enTextBody.includes('is disabled due to rate limit'));
  assert.ok(enTextBody.includes('=== Correlated Errors & Credential Status ==='));
  assert.ok(enTextBody.includes('Quota reason: rpm_exceeded'));

  assert.ok(zhTextBody.includes('=== 请求详情 ==='));
  assert.ok(zhTextBody.includes('=== 耗时与 Token ==='));
  assert.ok(zhTextBody.includes('总耗时: 2500 毫秒'));
  assert.ok(zhTextBody.includes('首 Token 耗时: 500 毫秒'));
  assert.ok(zhTextBody.includes('计量状态: 完整'));
  assert.ok(zhTextBody.includes('=== 费用构成 ==='));
  assert.ok(zhTextBody.includes('费用状态: 已定价'));
  assert.ok(zhTextBody.includes('=== 上游响应 ==='));
  assert.ok(zhTextBody.includes(`格式版本: ${REQUEST_RECORD_LOG_SCHEMA}`));

  // When auth_type and credential metadata are absent, provider_title can fall back to resource_name
  // and must still mask account-bearing filenames in both JSON and text outputs.
  const fallbackDoc = buildRequestRecordLog({
    detail: {
      event: {
        id: 89,
        event_key: 'evt-89',
        timestamp_ms: 1_700_000_000_000,
        provider: '',
        resource_name: `oauth-${RAW_EMAIL}.json`,
        model: 'gpt-5',
        failed: false,
        generate: true,
        latency_ms: 100,
        tokens: { input: 10, output: 5, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 15 },
        has_request_log: false,
        pricing_status: 'invalid_price',
      },
    },
    tpsMode: 'exclude_ttft',
    exportedAt: new Date(1_700_000_010_000),
    credentials: new Map(),
  });
  assert.ok(!JSON.stringify(fallbackDoc).includes(RAW_EMAIL), 'fallback provider_title must mask account-bearing filenames');
  const fallbackZh = formatRequestRecordLog(fallbackDoc, makeT(zhCatalog));
  assert.ok(!fallbackZh.includes(RAW_EMAIL));
  assert.ok(fallbackZh.includes('费用状态: 价格无效'));

  // Distinct from CPA's `request-<id>.log` so saving both never collides, and safe when request_id is absent.
  assert.equal(requestRecordLogFileName({ id: 88, request_id: 'req-abc-88' }, 'log'), 'record-req-abc-88.log');
  assert.equal(requestRecordLogFileName({ id: 88, request_id: 'req-abc-88' }, 'json'), 'record-req-abc-88.json');
  assert.equal(requestRecordLogFileName({ id: 88, request_id: '../bad/id' }, 'log'), 'record-bad-id.log');
  assert.equal(requestRecordLogFileName({ id: 88 }, 'log'), 'record-event-88.log');
  assert.equal(requestRecordLogFileName({ id: 88, request_id: '' }, 'json'), 'record-event-88.json');
});
