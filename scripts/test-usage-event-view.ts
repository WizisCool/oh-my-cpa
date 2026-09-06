import assert from 'node:assert/strict';
import {
  readEventQuery,
  eventWindow,
  indexCredentialFiles,
  resolveCredential,
  requestGroupName,
  eventPageMetrics,
  formatEventDuration,
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
