import assert from 'node:assert/strict';
import {
  readEventQuery,
  eventWindow,
  indexCredentialFiles,
  resolveCredential,
  requestGroupName,
  eventPageMetrics,
  formatEventDuration,
  USAGE_EVENTS_VIEW_PREFERENCE,
  DEFAULT_USAGE_EVENTS_VIEW,
  parseUsageEventsView,
  hasExplicitEventQuery,
  eventCacheRate,
  resolveProviderInfo,
} from '../web/src/types/usageEventView.ts';
import { usageEventParams, type UsageEvent } from '../web/src/types/usageEvents.ts';

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
  requestGroupName({ ...event, api_group_label: 'api_key', api_group_key: 'hmac:12345678901234567890' }),
  'API Key · 123456789012…',
);
assert.equal(requestGroupName({ ...event, api_group_label: 'provider', api_group_key: 'openai' }), 'openai');
assert.equal(requestGroupName({ ...event, api_group_key: 'unknown' }), undefined);
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

// Cache rate tests
assert.equal(eventCacheRate(undefined).formatted, '—');
assert.equal(eventCacheRate({ input: 0, output: 0, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 0 }).formatted, '0%');
// OpenAI style: input=1000, cache_read=800 -> 80%
assert.equal(
  eventCacheRate({ input: 1000, output: 100, reasoning: 0, cached: 0, cache_read: 800, cache_creation: 0, total: 1100 }).formatted,
  '80%',
);
// Anthropic style: input=200, cache_read=800 -> denominator=1000, 80%
assert.equal(
  eventCacheRate({ input: 200, output: 100, reasoning: 0, cached: 0, cache_read: 800, cache_creation: 0, total: 1100 }).formatted,
  '80%',
);
// Fallback cached tokens
assert.equal(
  eventCacheRate({ input: 1000, output: 100, reasoning: 0, cached: 500, cache_read: 0, cache_creation: 0, total: 1100 }).formatted,
  '50%',
);
console.log('PASS cache rate calculation: OpenAI vs Anthropic conventions, fallback handling, edge boundaries');

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
assert.equal(apiKeyResolved.subtitle, '(apiKey-custom.json)');

// Configured AI provider match
const configuredProviders = [
  { id: 'custom-deepseek', name: 'DeepSeek 专线', family: 'deepseek', auth_index: 'auth-apikey' },
];
const customResolved = resolveProviderInfo(apiKeyEvent, credFiles, { 'custom-deepseek': 'DeepSeek' }, configuredProviders);
assert.equal(customResolved.isOAuth, false);
assert.equal(customResolved.title, 'DeepSeek 专线');
assert.equal(customResolved.iconId, 'DeepSeek');
assert.equal(customResolved.subtitle, '(apiKey-custom.json)');

console.log('PASS provider info resolution: OAuth account identity, configured provider custom name/icon, fallback');


