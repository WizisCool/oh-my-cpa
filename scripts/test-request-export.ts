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
} from '../web/src/components/usage/requestSelection.ts';
import { buildRequestExport, REQUEST_EXPORT_SCHEMA } from '../web/src/components/usage/requestExportJson.ts';
import { buildRequestSheet, sheetStrings } from '../web/src/components/usage/requestSheetModel.ts';
import { indexCredentialFiles } from '../web/src/types/usageEventIdentity.ts';
import type { UsageEvent } from '../web/src/types/usageEvents.ts';

const rows = [5, 4, 3, 2, 1].map((id) => ({ id, timestamp_ms: id * 1000 }));
const none = new Map<number, (typeof rows)[number]>();
const ids = (selection: ReadonlyMap<number, unknown>) => [...selection.keys()].sort();

const one = toggleSelection(none, rows, 4, null, false);
assert.deepEqual(ids(one), [4]);
assert.deepEqual(ids(toggleSelection(one, rows, 4, 4, false)), [], 'a plain click on a selected row clears it');
const run = toggleSelection(one, rows, 2, 4, true);
assert.deepEqual(ids(run), [2, 3, 4], 'a range click selects the run from the anchor');
assert.deepEqual(ids(toggleSelection(run, rows, 3, 4, true)), [2], 'a range click on a selected row clears the run');
assert.deepEqual(ids(toggleSelection(one, rows, 2, 99, true)), [2, 4], 'an anchor that left the page makes the click plain');
assert.deepEqual(ids(toggleSelection(one, rows, 99, 4, true)), [4], 'a row that is not loaded changes nothing');

assert.equal(loadedSelectionState(none, rows), 'none');
assert.equal(loadedSelectionState(run, rows), 'some');
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

const open = build(effectiveMasks([], []));
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
  [{ kind: 'text', text: 'Claude', tone: 'fg', size: 13, weight: 600, isMono: true }, { kind: 'tag', text: 'OAuth', tone: 'accent' }],
  [{ kind: 'text', text: ACCOUNT, tone: 'meta', size: 11, weight: 400, isMono: true }],
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
  { kind: 'tag', text: 'xhigh', tone: 'fg2', effortStep: 5 },
  { kind: 'glyph', glyph: 'non_stream', tone: 'muted', isBoxed: true },
]], 'the mode cell draws the effort on its scale step, then the non-streaming mark');
assert.equal(modeSheet(effectiveMasks([], [])).rows[0].cells.model.lines.length, 1, 'the model cell is the name alone');
assert.deepEqual(
  buildRequestSheet({ rows: [events[1]], masks: effectiveMasks([], []), colWidths: {}, caption: '', t: (key) => key, tokenStyle: 'en-compact', tpsMode: 'exclude_ttft', credentials }).rows[0].cells.mode.lines,
  [[{ kind: 'text', text: '—', tone: 'muted', size: 12, weight: 400, isMono: false }]],
  'a request with nothing to mark draws a dash, not an empty cell',
);
const fastSheet = buildRequestSheet({
  rows: [{ ...events[1], response_service_tier: 'priority' }] as UsageEvent[],
  masks: effectiveMasks([], []), colWidths: {}, caption: '', t: (key) => key, tokenStyle: 'en-compact', tpsMode: 'exclude_ttft', credentials,
});
assert.deepEqual(fastSheet.rows[0].cells.mode.lines, [[{ kind: 'glyph', glyph: 'fast', tone: 'accent', isBoxed: true, isFilled: true }]],
  'a request served on the fast lane draws the lightning mark');
const modeHidden = sheetStrings(modeSheet(effectiveMasks([], ['mode'])));
assert.ok(!modeHidden.includes('xhigh') && modeHidden.includes('gpt-5'), 'hiding the mode column keeps the model');
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
  tokens: { total: 200, input: 150, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
  cost_usd: 0.0123,
  api_key_alias: 'laptop key',
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

console.log('PASS request export: selection ranges, page-scoped select-all, row cap, canvas ceiling, redaction leaves values out of the sheet and the JSON document');
