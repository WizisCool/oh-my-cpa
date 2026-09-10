import assert from 'node:assert/strict';
import {
  readEventQuery,
  eventWindow,
  indexCredentialFiles,
  resolveCredential,
  requestGroupName,
  eventPageMetrics,
  formatEventDuration,
  eventKeyLabel,
  eventResultLabelKey,
  eventUserAgentLabel,
  usageFacetLabel,
  USAGE_EVENTS_VIEW_PREFERENCE,
  DEFAULT_USAGE_EVENTS_VIEW,
  parseUsageEventsView,
  hasExplicitEventQuery,
  eventCacheRate,
  successRateVerdict,
  SUCCESS_ROUTINE_FAILURE_PERCENT,
  SUCCESS_ELEVATED_FAILURE_PERCENT,
  SUCCESS_VERDICT_MIN_FAILURES,
  SUCCESS_VERDICT_MIN_SAMPLE,
  resolveProviderInfo,
  eventTokensPerSecond,
} from '../web/src/types/usageEventView.ts';
import {
  REQUEST_COLUMNS,
  USAGE_EVENTS_COLUMNS_PREFERENCE,
  parseUsageEventsColumns,
  buildGridTemplateColumns,
  computeGridMinWidth,
} from '../web/src/components/usage/requestColumns.ts';
import { usageEventParams, type UsageEvent } from '../web/src/types/usageEvents.ts';
import { cacheScaleMix, formatCacheRate, MAX_CACHE_RATE } from '../web/src/theme/cacheScale.ts';

const read = (input: string) => readEventQuery(new URLSearchParams(input));
assert.deepEqual(read(''), { preset: '1h', result: 'all', limit: 100 });
for (const input of ['limit=NaN', 'limit=-1', 'limit=0', 'limit=1.5']) assert.equal(read(input).limit, 100);
assert.equal(read('limit=99999').limit, 500);
assert.equal(read('preset=__proto__&result=oops').preset, '1h');
assert.equal(read('preset=constructor').preset, '1h');
assert.equal(read('result=failed').result, 'failed');
assert.equal(read('from=oops&to=10').from, undefined);
assert.equal(read('from=20&to=10').from, undefined);
assert.equal(read('from=-1&to=10').from, undefined);
assert.deepEqual(eventWindow(read('from=100&to=200'), 999), { from: 100, to: 200 });
assert.deepEqual(eventWindow(read('preset=15m'), 1_000_000), { from: 100_000, to: 1_000_000 });
const drilldown = read(
  'from=100&to=200&auth_index=auth-1&source=team.json&api_key=caller-1&executor=codex&auth_type=oauth&model_alias=fast&model=gpt&provider=openai&request_id=req-1',
);
assert.equal(drilldown.auth_index, 'auth-1');
assert.equal(drilldown.source, 'team.json');
const serialized = new URLSearchParams(usageEventParams(drilldown));
for (const key of [
  'from',
  'to',
  'auth_index',
  'source',
  'api_key',
  'executor',
  'auth_type',
  'model_alias',
  'model',
  'provider',
  'request_id',
])
  assert.ok(serialized.has(key), key);
assert.equal(serialized.has('preset'), false);
const event = {
  id: 1,
  failed: false,
  latency_ms: 1250,
  tokens: { total: 200 },
  resource_name: 'resource.json',
  source: 'original.json',
  auth_index: 'auth-1',
} as UsageEvent;
assert.deepEqual(eventPageMetrics([]), { count: 0, failed: 0, tokens: 0, latency: null });
assert.deepEqual(eventPageMetrics([event, { ...event, failed: true, latency_ms: 750 }]), {
  count: 2,
  failed: 1,
  tokens: 400,
  latency: 1000,
});
assert.equal(formatEventDuration(null), '—');
assert.equal(formatEventDuration(0), '0 ms');
assert.equal(formatEventDuration(1250), '1.25 s');
console.log(
  'PASS request explorer: URL validation, drill-down filters, frozen windows, credential fallbacks, scoped metrics, duration formatting',
);

const files = indexCredentialFiles([{ name: 'current.json', auth_index: 'auth-1', provider: 'openai' }]);
const unbound = { ...event, resource_name: null, source: 'hmac:source-identifier', provider: 'openai' };
assert.deepEqual(resolveCredential(event, files), { name: 'resource.json', kind: 'resource' });
assert.deepEqual(resolveCredential(unbound, files), { name: 'current.json', kind: 'current_file' });
assert.deepEqual(resolveCredential({ ...unbound, provider: 'claude' }, files), {
  name: 'auth-1',
  kind: 'index',
});
const ambiguous = indexCredentialFiles([
  { name: 'a.json', auth_index: 'auth-1' },
  { name: 'b.json', auth_index: 'auth-1' },
]);
assert.equal(resolveCredential(unbound, ambiguous).kind, 'index');
assert.deepEqual(resolveCredential({ ...unbound, auth_index: '' }, files), {
  name: 'hmac:source-identifier',
  kind: 'source',
});
assert.equal(resolveCredential({ ...unbound, auth_index: '', source: '' }, files).kind, 'unknown');
assert.equal(
  requestGroupName({
    ...event,
    api_group_label: 'api_key',
    api_group_key: 'hmac:12345678901234567890',
    api_key_mask: 'sk-12345••••••••7890',
  }),
  'sk-12345••••••••7890',
);
// The stored group key is a fingerprint, which is not a readable key: a record
// ingested before the mask column existed resolves to nothing.
assert.equal(
  requestGroupName({ ...event, api_group_label: 'api_key', api_group_key: 'hmac:12345678901234567890' }),
  undefined,
);
assert.equal(requestGroupName({ ...event, api_group_label: 'provider', api_group_key: 'openai' }), 'openai');
assert.equal(requestGroupName({ ...event, api_group_key: 'unknown' }), undefined);

// List-row labels: result capsule, UA column and Key column
assert.equal(eventResultLabelKey({ failed: false }), 'events.filter_success');
assert.equal(eventResultLabelKey({ failed: true }), 'events.filter_failed');
assert.equal(eventUserAgentLabel({ user_agent: 'codex-cli/0.46' }), 'codex-cli/0.46');
assert.equal(eventUserAgentLabel({ user_agent: '  ' }), '—');
assert.equal(eventUserAgentLabel({}), '—');
assert.equal(eventUserAgentLabel({ user_agent: null }), '—');
// A minimized-but-long label is shown verbatim; the column ellipsizes visually
const longUA = 'some-client/1.2.3-' + 'x'.repeat(100);
assert.equal(eventUserAgentLabel({ user_agent: longUA }), longUA);
// Key shows the stored display mask; the raw key is never available to show.
assert.equal(
  eventKeyLabel({
    ...event,
    api_group_label: 'api_key',
    api_group_key: 'hmac:12345678901234567890',
    api_key_mask: 'sk-12345••••••••7890',
  }),
  'sk-12345••••••••7890',
);
// A short key is masked completely rather than shown with readable edges, so
// the column never exposes most of a small secret.
assert.equal(eventKeyLabel({ ...event, api_group_label: 'api_key', api_key_mask: '••••••••' }), '••••••••');
// No mask means the key was never retained, so the column stays honest.
assert.equal(
  eventKeyLabel({ ...event, api_group_label: 'api_key', api_group_key: 'hmac:12345678901234567890' }),
  '—',
);
assert.equal(eventKeyLabel({ ...event, api_group_label: 'api_key', api_key_mask: '   ' }), '—');
// The fingerprint must never be rendered as if it were the key.
assert.equal(
  eventKeyLabel({ ...event, api_group_label: 'api_key', api_group_key: 'hmac:12345678901234567890', source: 'hmac:src' }),
  '—',
);
// A provider or endpoint group is NOT a caller key: the column must never show
// the provider name or the upstream URL as if it were one.
assert.equal(
  eventKeyLabel({ ...event, api_group_label: 'provider', api_group_key: 'openai' }),
  'original.json',
);
assert.equal(
  eventKeyLabel({ ...event, api_group_label: 'endpoint', api_group_key: 'https://relay.example/v1' }),
  'original.json',
);
assert.equal(
  eventKeyLabel({ ...event, api_group_label: 'provider', api_group_key: 'openai', source: '' }),
  '—',
);
assert.equal(
  eventKeyLabel({ ...event, api_group_label: 'endpoint', api_group_key: 'https://relay.example/v1', source: undefined }),
  '—',
);
assert.equal(eventKeyLabel({ ...event, api_group_key: 'unknown', source: 'hmac:source-fingerprint' }), 'hmac:source-fingerprint');
assert.equal(eventKeyLabel({ ...event, api_group_key: 'unknown', source: '' }), '—');
assert.equal(eventKeyLabel({ ...event, api_group_key: '', source: undefined }), '—');

// Filter dropdown labels: the caller-key facet shows its mask, every other
// facet keeps showing the stored value.
assert.equal(usageFacetLabel({ value: 'hmac:12345678901234567890', requests: 3, mask: 'sk-12345••••••••7890' }), 'sk-12345••••••••7890 (3)');
assert.equal(usageFacetLabel({ value: 'hmac:12345678901234567890', requests: 3 }), 'hmac:12345678901234567890 (3)');
assert.equal(usageFacetLabel({ value: 'gpt-5.4', requests: 7, mask: '   ' }), 'gpt-5.4 (7)');
console.log(
  'PASS credential provenance: current vs linked resources, provider mismatch, ambiguity, fingerprints, API group categories',
);

assert.equal(read('preset=30d').preset, '30d');
assert.equal(read('preset=90d').preset, '90d');
assert.deepEqual(eventWindow(read('from=100'), 999), { from: 100, to: 999 });
assert.deepEqual(eventWindow(read('from=100&to=2000'), 999), { from: 100, to: 999 });

// Usage events view preference parsing and validation tests
assert.equal(USAGE_EVENTS_VIEW_PREFERENCE, 'usage_events_view');
assert.equal(parseUsageEventsView(null), undefined);
assert.equal(parseUsageEventsView('invalid string'), undefined);
assert.equal(parseUsageEventsView(123), undefined);
assert.deepEqual(parseUsageEventsView({}), {
  preset: '1h',
  result: 'all',
  limit: 100,
  grouping: 'time',
  advanced: false,
});

// Full valid document
const fullDoc = {
  preset: '24h',
  result: 'failed',
  limit: 250,
  grouping: 'provider',
  advanced: true,
  model: 'gpt-4o',
  provider: 'openai',
  auth_index: 'idx-1',
  source: 'src.json',
  api_key: 'key-1',
  executor: 'exec-1',
  auth_type: 'oauth',
  model_alias: 'alias-1',
  request_id: 'req-123',
  unknown_garbage: 'dropped',
  __proto__: { polluted: true },
};
const parsedFull = parseUsageEventsView(fullDoc);
assert.deepEqual(parsedFull, {
  preset: '24h',
  result: 'failed',
  limit: 250,
  grouping: 'provider',
  advanced: true,
  model: 'gpt-4o',
  provider: 'openai',
  auth_index: 'idx-1',
  source: 'src.json',
  api_key: 'key-1',
  executor: 'exec-1',
  auth_type: 'oauth',
  model_alias: 'alias-1',
  request_id: 'req-123',
});
assert.equal((parsedFull as Record<string, unknown>).unknown_garbage, undefined);

// Custom from/to range vs preset
const customDoc = parseUsageEventsView({ from: 1000, to: 2000, preset: 'ignore-me' });
assert.equal(customDoc?.from, 1000);
assert.equal(customDoc?.to, 2000);
assert.equal(customDoc?.preset, undefined);

// Invalid from/to range falls back to preset
const invalidRange = parseUsageEventsView({ from: 2000, to: 1000, preset: '6h' });
assert.equal(invalidRange?.from, 2000);
assert.equal(invalidRange?.to, undefined);

// Preset sanitization
assert.equal(parseUsageEventsView({ preset: 'invalid-preset' })?.preset, '1h');
assert.equal(parseUsageEventsView({ preset: '7d' })?.preset, '7d');

// Limit clamping
assert.equal(parseUsageEventsView({ limit: -5 })?.limit, 100);
assert.equal(parseUsageEventsView({ limit: 0 })?.limit, 100);
assert.equal(parseUsageEventsView({ limit: 9999 })?.limit, 500);
assert.equal(parseUsageEventsView({ limit: 50 })?.limit, 50);

// Grouping sanitization
assert.equal(parseUsageEventsView({ grouping: 'credential' })?.grouping, 'credential');
assert.equal(parseUsageEventsView({ grouping: 'malformed' })?.grouping, 'time');

// hasExplicitEventQuery detection
assert.equal(hasExplicitEventQuery(new URLSearchParams('')), false);
assert.equal(hasExplicitEventQuery(new URLSearchParams('unrelated=123')), false);
assert.equal(hasExplicitEventQuery(new URLSearchParams('preset=6h')), true);
assert.equal(hasExplicitEventQuery(new URLSearchParams('model=claude')), true);
assert.equal(hasExplicitEventQuery(new URLSearchParams('result=failed')), true);
assert.equal(hasExplicitEventQuery(new URLSearchParams('limit=250')), true);
assert.equal(hasExplicitEventQuery(new URLSearchParams('request_id=abc')), true);

console.log('PASS usage event view preference: parsing, validation, field whitelisting, URL precedence helpers');

// Cache rate tests. The reading is formatted by cacheScale.formatCacheRate, so
// these assert the computed rate and the rendered string together.
const cacheShown = (tokens: UsageEvent['tokens']) => formatCacheRate(eventCacheRate(tokens).rate);
assert.equal(eventCacheRate(undefined).hasData, false);
assert.equal(cacheShown({ input: 0, output: 0, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 0 }), '0%');
// OpenAI style: input=1000, cache_read=800 -> 80%
assert.equal(cacheShown({ input: 1000, output: 100, reasoning: 0, cached: 0, cache_read: 800, cache_creation: 0, total: 1100 }), '80.0%');
// Anthropic style: input=200, cache_read=800 -> denominator=1000, 80%
assert.equal(cacheShown({ input: 200, output: 100, reasoning: 0, cached: 0, cache_read: 800, cache_creation: 0, total: 1100 }), '80.0%');
// Fallback cached tokens
assert.equal(cacheShown({ input: 1000, output: 100, reasoning: 0, cached: 500, cache_read: 0, cache_creation: 0, total: 1100 }), '50.0%');
// Cache writes are deliberately outside the denominator: the persisted row
// carries no canonical breakdown proving which accounting convention produced
// its raw counts, so 1000/(200+1000) = 83.3% is what is shown today. Making
// writes count is deferred until that evidence exists.
assert.equal(cacheShown({ input: 200, output: 300, reasoning: 0, cached: 0, cache_read: 1000, cache_creation: 500, total: 2000 }), '83.3%');
// A whole-prompt hit is not shown: the cap holds the reading below 100%.
assert.equal(cacheShown({ input: 1000, output: 100, reasoning: 0, cached: 0, cache_read: 1000, cache_creation: 0, total: 1100 }), '99.9%');
assert.equal(cacheShown({ input: 0, output: 0, reasoning: 0, cached: 0, cache_read: 1000, cache_creation: 0, total: 1000 }), '99.9%');
console.log('PASS cache rate calculation: OpenAI vs Anthropic conventions, cache writes, cap, fallback handling, edge boundaries');

// The badge paints a continuous scale, so the numeric rate must keep its
// fraction while the printed reading stays rounded to one decimal.
const third = eventCacheRate({ input: 3, output: 0, reasoning: 0, cached: 0, cache_read: 1, cache_creation: 0, total: 3 });
assert.ok(Math.abs(third.rate - 100 / 3) < 1e-9, `fractional rate kept: ${third.rate}`);
assert.equal(formatCacheRate(third.rate), '33.3%');
const almost = eventCacheRate({ input: 2000, output: 0, reasoning: 0, cached: 0, cache_read: 1999, cache_creation: 0, total: 2000 });
assert.equal(almost.rate, 99.95);
assert.equal(formatCacheRate(almost.rate), '99.9%');
assert.equal(eventCacheRate(undefined).rate, 0);
assert.equal(eventCacheRate({ input: 0, output: 0, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 0 }).rate, 0);
// One decimal, and a rate that rounds to zero reads as plain 0%.
assert.equal(formatCacheRate(0), '0%');
assert.equal(formatCacheRate(0.04), '0%');
assert.equal(formatCacheRate(0.06), '0.1%');
assert.equal(formatCacheRate(47.63), '47.6%');
assert.equal(formatCacheRate(99.94), '99.9%');
assert.equal(formatCacheRate(99.95), '99.9%');
assert.equal(formatCacheRate(100), '99.9%');
assert.equal(formatCacheRate(Number.NaN), '0%');
// A window with no prompt tokens at all is a dash, never a zero.
assert.equal(formatCacheRate(null), '—');
assert.equal(formatCacheRate(undefined), '—');
assert.equal(MAX_CACHE_RATE, 99.9);
console.log('PASS cache rate reading: unrounded rate for the colour scale, one decimal and the <100% presentation cap for the badge');

// Cache-rate colour scale: two stops, 0% yellow → 100% green, no red.
const YELLOW = 'var(--cache-rate-yellow)';
const GREEN = 'var(--cache-rate-green)';
assert.deepEqual(cacheScaleMix(0), { from: YELLOW, to: GREEN, fromShare: '100%' });
assert.deepEqual(cacheScaleMix(50), { from: YELLOW, to: GREEN, fromShare: '50%' });
assert.deepEqual(cacheScaleMix(100), { from: YELLOW, to: GREEN, fromShare: '0%' });
// Fractional rates must land between the stops instead of snapping to one.
assert.deepEqual(cacheScaleMix(0.5), { from: YELLOW, to: GREEN, fromShare: '99.5%' });
assert.deepEqual(cacheScaleMix(12.5), { from: YELLOW, to: GREEN, fromShare: '87.5%' });
assert.deepEqual(cacheScaleMix(99.5), { from: YELLOW, to: GREEN, fromShare: '0.5%' });
// Clamping: the scale is defined on 0..100 only, and a non-finite rate is the
// safe (yellow) end rather than a broken custom property.
assert.deepEqual(cacheScaleMix(-10), cacheScaleMix(0));
assert.deepEqual(cacheScaleMix(140), cacheScaleMix(100));
assert.deepEqual(cacheScaleMix(Number.NaN), cacheScaleMix(0));
assert.deepEqual(cacheScaleMix(Number.POSITIVE_INFINITY), cacheScaleMix(100));
assert.deepEqual(cacheScaleMix(Number.NEGATIVE_INFINITY), cacheScaleMix(0));
// The weight of the low stop decreases monotonically, so the rendered hue
// sweeps yellow → green without reversing.
const weights = [0, 10, 25, 50, 75, 90, 100].map((rate) => Number.parseFloat(cacheScaleMix(rate).fromShare));
assert.ok(weights.every((weight, index) => index === 0 || weight < weights[index - 1]), `monotonic yellow→green: ${weights}`);
// Red must never appear on the scale: a low hit rate is not a failure.
assert.ok([0, 25, 50, 75, 100].every((rate) => !cacheScaleMix(rate).from.includes('red') && !cacheScaleMix(rate).to.includes('red')));
console.log('PASS cache-rate scale: two-stop yellow→green, weight, fractional rates, clamping, monotonic sweep, no red');

// Provider info resolution tests
const credFiles = indexCredentialFiles([
  { name: 'oauth-claude.json', auth_index: 'auth-oauth', provider: 'claude', type: 'oauth', email: 'user@example.com' },
  { name: 'apiKey-custom.json', auth_index: 'auth-apikey', provider: 'openai' },
]);

const oauthEvent = {
  id: 10,
  provider: 'claude',
  auth_type: 'oauth',
  auth_index: 'auth-oauth',
  tokens: { total: 100, input: 50, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
} as UsageEvent;

const oauthResolved = resolveProviderInfo(oauthEvent, credFiles);
assert.equal(oauthResolved.isOAuth, true);
assert.equal(oauthResolved.title, 'user@example.com');
assert.equal(oauthResolved.iconId, 'Claude');
assert.equal(oauthResolved.accountIdentity, 'user@example.com');

const apiKeyEvent = {
  id: 11,
  provider: 'openai',
  auth_index: 'auth-apikey',
  tokens: { total: 100, input: 50, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
} as UsageEvent;

const apiKeyResolved = resolveProviderInfo(apiKeyEvent, credFiles, { 'openai': 'OpenAI' });
assert.equal(apiKeyResolved.isOAuth, false);
assert.equal(apiKeyResolved.title, 'Openai');
assert.equal(apiKeyResolved.subtitle, undefined);

// Configured AI provider match
const configuredProviders = [
  { id: 'custom-deepseek', name: 'DeepSeek 专线', family: 'deepseek', auth_index: 'auth-apikey' },
  { id: 'opencode-1', name: 'Opencode', family: 'openai-compatibility', auth_index: 'auth-opencode' },
];
const customResolved = resolveProviderInfo(apiKeyEvent, credFiles, { 'custom-deepseek': 'DeepSeek' }, configuredProviders);
assert.equal(customResolved.isOAuth, false);
assert.equal(customResolved.title, 'DeepSeek 专线');
assert.equal(customResolved.iconId, 'DeepSeek');
assert.equal(customResolved.subtitle, undefined);

// Technical driver string: openai-compatible-opencode go -> Opencode with no subtitle
const opencodeEvent = {
  id: 12,
  provider: 'openai-compatible-opencode go',
  auth_index: 'auth-opencode',
  tokens: { total: 100, input: 50, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
} as UsageEvent;
const opencodeResolved = resolveProviderInfo(opencodeEvent, credFiles, {}, configuredProviders);
assert.equal(opencodeResolved.isOAuth, false);
assert.equal(opencodeResolved.title, 'Opencode');
assert.equal(opencodeResolved.subtitle, undefined);

// Unconfigured fallback also cleans technical prefixes/suffixes
const fallbackOpencodeEvent = {
  id: 13,
  provider: 'openai-compatible-opencode go',
  tokens: { total: 100, input: 50, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
} as UsageEvent;
const fallbackOpencodeResolved = resolveProviderInfo(fallbackOpencodeEvent, credFiles, {}, []);
assert.equal(fallbackOpencodeResolved.isOAuth, false);
assert.equal(fallbackOpencodeResolved.title, 'Opencode');
assert.equal(fallbackOpencodeResolved.subtitle, undefined);

console.log('PASS provider info resolution: OAuth account identity, configured provider custom name/icon, fallback');

// Tokens Per Second (TPS) tests
assert.equal(eventTokensPerSecond(undefined).formatted, '—');
assert.equal(eventTokensPerSecond({ generate: false, latency_ms: 1000, tokens: { total: 500, input: 400, output: 100, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 } }).formatted, '—');
assert.equal(eventTokensPerSecond({ generate: true, latency_ms: 1000, tokens: { total: 400, input: 400, output: 0, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 } }).formatted, '—');
assert.equal(eventTokensPerSecond({ generate: true, latency_ms: 0, tokens: { total: 100, input: 50, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 } }).formatted, '—');

// Exact 109.21 t/s with TTFT subtraction:
// output = 10921, latency = 120000 ms, ttft = 20000 ms -> generation = 100000 ms -> 109.21 t/s
const tpsExact = eventTokensPerSecond({
  generate: true,
  latency_ms: 120_000,
  ttft_ms: 20_000,
  tokens: { total: 20000, input: 9079, output: 10921, reasoning: 500, cached: 0, cache_read: 0, cache_creation: 0 },
});
assert.equal(tpsExact.formatted, '109.21 t/s');
assert.equal(tpsExact.hasTTFT, true);

// Fallback without TTFT: output = 500, latency = 2500 ms -> 200.00 t/s
const tpsNoTTFT = eventTokensPerSecond({
  generate: true,
  latency_ms: 2500,
  tokens: { total: 1000, input: 500, output: 500, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
});
assert.equal(tpsNoTTFT.formatted, '200.00 t/s');
assert.equal(tpsNoTTFT.hasTTFT, false);

// Invalid TTFT (ttft >= latency) falls back safely to total latency rather than division by zero / negative
const tpsInvalidTTFT = eventTokensPerSecond({
  generate: true,
  latency_ms: 2000,
  ttft_ms: 2500,
  tokens: { total: 500, input: 400, output: 100, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
});
assert.equal(tpsInvalidTTFT.formatted, '50.00 t/s');
assert.equal(tpsInvalidTTFT.hasTTFT, false);

console.log('PASS tokens per second (TPS): TTFT-aware generation speed, fallback end-to-end average, edge boundaries');

// Request columns tests
assert.equal(USAGE_EVENTS_COLUMNS_PREFERENCE, 'usage_events_columns');
assert.equal(REQUEST_COLUMNS.length, 11);

// Sanitization & clamping
assert.deepEqual(parseUsageEventsColumns(null), {});
assert.deepEqual(parseUsageEventsColumns('invalid'), {});
assert.deepEqual(parseUsageEventsColumns({ unknown_col: 200, time: 'not-a-number' }), {});

// Clamping to min/max
const parsedWidths = parseUsageEventsColumns({
  time: 50, // below min 88 -> clamped to 88
  provider: 800, // above max 480 -> clamped to 480
  model: 210, // valid in [130, 440] -> 210
  latency: 85,
});
assert.equal(parsedWidths.time, 88);
assert.equal(parsedWidths.provider, 480);
assert.equal(parsedWidths.model, 210);
assert.equal(parsedWidths.latency, 85);

// buildGridTemplateColumns: adaptive defaults with fr for provider, model, tokens
const defaultGrid = buildGridTemplateColumns({});
assert.ok(defaultGrid.includes('minmax(140px, 1.6fr)'));
assert.ok(defaultGrid.includes('minmax(130px, 1.3fr)'));
assert.ok(defaultGrid.includes('minmax(125px, 1fr)'));
assert.ok(defaultGrid.endsWith('14px')); // chevron track

// Manual overrides lock specified tracks to exact px
const manualGrid = buildGridTemplateColumns({ provider: 250, model: 200 });
assert.ok(manualGrid.includes('250px'));
assert.ok(manualGrid.includes('200px'));
assert.ok(manualGrid.endsWith('14px'));

// computeGridMinWidth: fixed defaults + flexible mins + 11 gaps + inline padding
// 96 + 88 + 140 + 130 + 76 + 78 + 125 + 72 + 64 + 135 + 76 + 14 = 1094; gaps 11*12 = 132; padding 24 = 1250
const baseMin = 1094;
assert.equal(computeGridMinWidth({}), baseMin + 132 + 24);
// A manual override replaces the flexible minimum with the requested width
assert.equal(computeGridMinWidth({ provider: 300 }), baseMin - 140 + 300 + 132 + 24);
// Out-of-range overrides are clamped exactly as the template builder clamps them
assert.equal(computeGridMinWidth({ provider: 9999 }), baseMin - 140 + 480 + 132 + 24);
assert.ok(computeGridMinWidth({}, 8, 12) < computeGridMinWidth({}, 12, 12));

console.log(
  'PASS column definitions: clamping, sanitization, adaptive and fixed grid template generation, measured min-width floor',
);

// successRateVerdict: the pip answers "does this window need attention", not
// "did anything fail". Normal upstream noise must stay neutral so the amber and
// red steps keep meaning something.
assert.equal(successRateVerdict(0, 0), 'neutral', 'no traffic carries no verdict');
assert.equal(successRateVerdict(500, 0), 'success', 'a clean window is green');
// A lone failure is never a trend, however small the window: one retried
// upstream request must not paint the page.
assert.equal(successRateVerdict(2, 1), 'neutral', 'one failure out of two');
assert.equal(successRateVerdict(100, 1), 'neutral', 'one failure out of a hundred');
// The reported bug: 98% success (2% failures) used to show amber.
assert.equal(successRateVerdict(100, 2), 'neutral', '98% success must not be amber');
assert.equal(successRateVerdict(200, 4), 'neutral', '99%–98% band stays neutral');
assert.equal(
  successRateVerdict(100, SUCCESS_ROUTINE_FAILURE_PERCENT),
  'neutral',
  'the top of the routine band is still neutral',
);
assert.equal(successRateVerdict(100, 6), 'warn', 'above the routine band needs a look');
assert.equal(successRateVerdict(100, 20), 'warn', 'the top of the elevated band is warn');
assert.equal(successRateVerdict(100, 21), 'danger', 'above the elevated band is broken');
assert.equal(successRateVerdict(5, 5), 'danger', 'a total outage is red even in a tiny window');
// A middling rate in a window too small to mean anything stays neutral: two
// failures out of four is 50% and tells nobody anything.
assert.equal(successRateVerdict(4, 2), 'neutral', 'below the minimum sample');
assert.equal(successRateVerdict(SUCCESS_VERDICT_MIN_SAMPLE, 2), 'warn', 'at the minimum sample it counts');
assert.equal(successRateVerdict(SUCCESS_VERDICT_MIN_SAMPLE - 1, 2), 'neutral', 'one short of the minimum');
// Defensive: nonsense inputs cannot produce a verdict.
assert.equal(successRateVerdict(Number.NaN, 1), 'neutral');
assert.equal(successRateVerdict(10, Number.NaN), 'success');
assert.equal(successRateVerdict(10, -3), 'success', 'negative failures clamp to none');
assert.equal(successRateVerdict(10, 99), 'danger', 'more failures than requests clamps to all');
assert.ok(SUCCESS_ELEVATED_FAILURE_PERCENT > SUCCESS_ROUTINE_FAILURE_PERCENT);

console.log(
  'PASS success-rate verdict: routine noise stays neutral, one failure is never a trend, small samples cannot alarm',
);
