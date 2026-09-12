import assert from 'node:assert/strict';
import {
  readEventQuery,
  readFilterParams,
  rejectedEventParams,
  filterParamsToUrl,
  queryToFilterParams,
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
  mergeFacetOptions,
  activeFilterCount,
  USAGE_EVENTS_VIEW_PREFERENCE,
  DEFAULT_USAGE_EVENTS_VIEW,
  EVENT_FILTER_KEYS,
  EVENT_AUTO_REFRESH_MS,
  parseUsageEventsView,
  hasExplicitEventQuery,
  eventCacheRate,
  successRateVerdict,
  SUCCESS_ROUTINE_FAILURE_PERCENT,
  SUCCESS_ELEVATED_FAILURE_PERCENT,
  SUCCESS_VERDICT_MIN_FAILURES,
  SUCCESS_VERDICT_MIN_SAMPLE,
  resolveProviderInfo,
  createProviderNameResolver,
  providerFacetLabel,
  eventTokensPerSecond,
} from '../web/src/types/usageEventView.ts';
import {
  EMPTY_FILTER_DRAFT,
  draftFromView,
  draftToView,
  isDraftDirty,
  validateFilterDraft,
} from '../web/src/types/usageEventFilters.ts';
import {
  REQUEST_COLUMNS,
  USAGE_EVENTS_COLUMNS_PREFERENCE,
  parseUsageEventsColumns,
  buildGridTemplateColumns,
  computeGridMinWidth,
} from '../web/src/components/usage/requestColumns.ts';
import {
  usageEventParams,
  USAGE_RANGE_MAX,
  compareCostBounds,
  formatUsageRangeBound,
  parseUsageRangeBound,
  type UsageEvent,
} from '../web/src/types/usageEvents.ts';
import { cacheScaleMix, formatCacheRate, MAX_CACHE_RATE } from '../web/src/theme/cacheScale.ts';

const read = (input: string) => readEventQuery(new URLSearchParams(input));
assert.deepEqual(read(''), { preset: '1h', result: 'all', limit: 100 });
for (const input of ['limit=NaN', 'limit=-1', 'limit=0', 'limit=1.5']) assert.equal(read(input).limit, 100);
assert.equal(read('limit=99999').limit, 500);
assert.equal(read('preset=__proto__&result=oops').preset, '1h');
assert.equal(read('preset=constructor').preset, '1h');
assert.equal(read('result=failed').result, 'failed');
assert.equal(read('cost=priced').cost, 'priced');
assert.equal(read('cost=nonsense').cost, undefined);
assert.equal(read('from=oops&to=10').from, undefined);
assert.equal(read('from=20&to=10').from, undefined);
assert.equal(read('from=-1&to=10').from, undefined);
assert.deepEqual(eventWindow(read('from=100&to=200'), 999), { from: 100, to: 200 });
assert.deepEqual(eventWindow(read('preset=15m'), 1_000_000), { from: 100_000, to: 1_000_000 });

// A drill-down link still writes one value per dimension, and it must still be
// read back as the filter the dashboard meant.
const drilldown = read(
  'from=100&to=200&auth_index=auth-1&source=team.json&api_key=caller-1&executor=codex&auth_type=oauth&model_alias=fast&model=gpt&provider=openai&request_id=req-1',
);
assert.deepEqual(drilldown.filters?.auth_index, ['auth-1']);
assert.deepEqual(drilldown.filters?.source, ['team.json']);
assert.equal(drilldown.text?.request_id, 'req-1');

// The auto-refresh cadence is a constant, not a setting: the console offers two
// answers (keep this current / stop moving), not five intervals to weigh.
assert.equal(EVENT_AUTO_REFRESH_MS, 10_000);

// Multi-select round trip. Repeated parameters are the wire format because a
// comma is a legal character in a model name, a source label and a caller mask;
// splitting on it would corrupt the values being filtered on.
const multi = read('model=vendor%2Cinc%2Fgpt-5&model=o3&provider=openai');
assert.deepEqual(multi.filters?.model, ['vendor,inc/gpt-5', 'o3']);
assert.deepEqual(multi.filters?.provider, ['openai']);
const multiParams = usageEventParams(multi);
assert.deepEqual(new URLSearchParams(multiParams).getAll('model'), ['vendor,inc/gpt-5', 'o3']);
// A repeated value is collapsed, so a hand-edited URL cannot inflate the query.
assert.deepEqual(read('model=o3&model=o3').filters?.model, ['o3']);
// A blank value narrows nothing and must not become an empty-string filter.
assert.equal(read('model=&provider=').filters, undefined);

// Every filter dimension the panel owns must survive a URL round trip, or a
// reload would silently drop part of the operator's filter.
const everyFilter = [
  'model=gpt-5&provider=openai&auth_index=auth-a&source=src&api_key=key&executor=codex',
  'auth_type=oauth&reasoning=high&service_tier=flex&model_alias=fast',
  'q=codex&ua=codex-cli&endpoint=%2Fv1%2Fresponses&request_id=req-1',
  'latency_min=100&latency_max=60000&tokens_min=0&tokens_max=500000',
  'cost_min=0.000001&cost_max=12.5&cost=unpriced',
].join('&');
const everyQuery = read(everyFilter);
const everyParams = new URLSearchParams(usageEventParams(everyQuery));
const everyAgain = read(everyParams.toString());
assert.deepEqual(everyAgain, everyQuery);
assert.equal(everyAgain.ranges?.tokens?.min, 0, 'a bound of zero is a bound, not an absent one');
assert.equal(everyAgain.ranges?.cost?.min, '0.000001', 'a cost bound keeps its decimal text');
assert.equal(everyAgain.cost, 'unpriced');

// A reversed range cannot match any record, so it is dropped instead of being
// forwarded as a filter that renders a guaranteed-empty list.
assert.equal(read('latency_min=500&latency_max=100').ranges, undefined);
assert.equal(read('latency_min=abc').ranges, undefined);
assert.equal(read('latency_min=-1').ranges, undefined);
// A bound above the field's typing ceiling must survive: the ceiling is a hint at
// the control, and applying it here would silently drop the constraint, which
// returns everything the operator was trying to exclude.
assert.deepEqual(read('tokens_min=999999999999').ranges, { tokens: { min: 999999999999 } });
assert.deepEqual(read('latency_min=1000000000').ranges, { latency: { min: 1000000000 } });
// One-sided bounds are legitimate and must survive on their own.
assert.deepEqual(read('latency_min=1000').ranges, { latency: { min: 1000 } });
assert.deepEqual(read('cost_max=2').ranges, { cost: { max: '2' } });

// The formatter passes values through; it never rounds. Rounding here would turn
// a rejected fractional input into a slightly different filter.
assert.equal(formatUsageRangeBound('0.000001'), '0.000001');
assert.equal(formatUsageRangeBound('12.5'), '12.5');
assert.equal(formatUsageRangeBound('0'), '0');
assert.equal(formatUsageRangeBound('0.000000001'), '0.000000001');
assert.equal(formatUsageRangeBound(1500), '1500');
assert.equal(formatUsageRangeBound(' 7 '), '7');
// Nine fractional digits is the stored precision, so anything up to it is kept
// exactly; the tenth is refused rather than rounded to zero, because rounding
// would answer a real constraint with "no cost at all".
assert.equal(parseUsageRangeBound('cost', '0.0000001'), '0.0000001');
assert.equal(parseUsageRangeBound('cost', '0.000000001'), '0.000000001');
assert.equal(parseUsageRangeBound('cost', '0.0000000001'), undefined);
assert.equal(parseUsageRangeBound('cost', '0.000001'), '0.000001');
assert.equal(parseUsageRangeBound('cost', '1.123456789'), '1.123456789');
assert.equal(parseUsageRangeBound('cost', '  '), undefined);
assert.equal(parseUsageRangeBound('cost', null), undefined);
assert.equal(parseUsageRangeBound('cost', ''), undefined);
// A bare separator carries no digits and is not an amount.
assert.equal(parseUsageRangeBound('cost', '.'), undefined);
assert.equal(parseUsageRangeBound('cost', 'abc'), undefined);
assert.equal(parseUsageRangeBound('cost', '-1'), undefined);
assert.equal(parseUsageRangeBound('cost', '1e-7'), undefined);
assert.equal(parseUsageRangeBound('cost', '1.2.3'), undefined);
// The magnitude limit is the cost column's own: int64 nanos. A larger amount
// cannot be stored or compared, so it is refused rather than silently broadened.
assert.equal(parseUsageRangeBound('cost', '9223372036.854775807'), '9223372036.854775807');
assert.equal(parseUsageRangeBound('cost', '9223372036.854775808'), undefined);
assert.equal(parseUsageRangeBound('cost', '9999999999999'), undefined);
// Leading zeros are stripped before the magnitude is judged, so a padded amount
// that is genuinely in range is not refused.
assert.equal(parseUsageRangeBound('cost', '0000000000009'), '0000000000009');
assert.equal(compareCostBounds('0000000000009', '9'), 0);
// Integers only for the two token-shaped fields, so nothing is silently rounded.
assert.equal(parseUsageRangeBound('latency', '1500.7'), undefined);
assert.equal(parseUsageRangeBound('latency', '1500'), 1500);
assert.equal(parseUsageRangeBound('latency', '-5'), undefined);
assert.equal(parseUsageRangeBound('latency', '1e3'), undefined);
// Beyond the field's typing ceiling the value is still accepted: the parser's job
// is to refuse what the wire cannot carry, not to re-apply a UI hint and drop a
// constraint the server supports.
assert.equal(parseUsageRangeBound('latency', String(USAGE_RANGE_MAX.latency + 1)), USAGE_RANGE_MAX.latency + 1);
assert.equal(parseUsageRangeBound('latency', String(USAGE_RANGE_MAX.latency)), USAGE_RANGE_MAX.latency);
assert.equal(parseUsageRangeBound('tokens', '0'), 0, 'zero is a bound');
// Past the exact-integer range a JS number would change the value as it travelled.
assert.equal(parseUsageRangeBound('tokens', '9007199254740993'), undefined);

// The serialized wire value keeps its decimal text all the way out. Converting a
// bound to a double anywhere on that path turns 0.000000001 into "1e-9", which the
// server's decimal parser rejects - so this asserts the exact parameter the Go
// endpoint will receive.
const nanoParams = usageEventParams({
  preset: '1h',
  result: 'all',
  limit: 100,
  ranges: { cost: { min: '0.000000001', max: '12.000000001' } },
});
assert.ok(nanoParams.includes('cost_min=0.000000001'), nanoParams);
assert.ok(nanoParams.includes('cost_max=12.000000001'), nanoParams);
assert.ok(!nanoParams.includes('e-'), `no exponential notation on the wire: ${nanoParams}`);
assert.ok(!nanoParams.includes('%2E'), `no encoded notation on the wire: ${nanoParams}`);
// And it survives a full URL round trip through the reader.
assert.deepEqual(read(nanoParams).ranges, { cost: { min: '0.000000001', max: '12.000000001' } });

// Cost ordering is on scaled digits, so bounds that differ only in the ninth
// decimal are ordered correctly instead of collapsing to the same double.
assert.ok(compareCostBounds('0.000000001', '0.000000002') < 0);
assert.ok(compareCostBounds('0.000000002', '0.000000001') > 0);
assert.equal(compareCostBounds('1.5', '1.500000000'), 0);
assert.ok(compareCostBounds('2', '10') < 0, 'a longer whole part is larger, not lexicographically later');
assert.ok(compareCostBounds('0.09', '0.1') < 0);
assert.equal(read('cost_min=0.1&cost_max=0.09').ranges, undefined, 'a reversed cost pair is dropped');
assert.deepEqual(read('cost_min=0.000000001&cost_max=0.000000002').ranges, {
  cost: { min: '0.000000001', max: '0.000000002' },
});

// queryToFilterParams / filterParamsToUrl are inverses, and they are what the
// chips and the saved view are both built from.
const flattened = queryToFilterParams(everyQuery);
const rebuilt = read(filterParamsToUrl(flattened).toString());
assert.deepEqual(rebuilt, everyQuery);
assert.deepEqual(readFilterParams(new URLSearchParams(everyFilter)), flattened);
assert.deepEqual(readFilterParams(new URLSearchParams('')), {});
// A dimension counts once however many values it holds: "2 models" is one
// decision, so the badge must not report two.
assert.equal(activeFilterCount({}), 0);
assert.equal(activeFilterCount({ model: ['a', 'b'], provider: ['x'] }), 2);
assert.equal(activeFilterCount({ model: [] }), 0);
// Every key the console can emit has to be recognised as a filter key, or reset
// would leave it behind.
for (const key of Object.keys(flattened)) {
  assert.ok((EVENT_FILTER_KEYS as readonly string[]).includes(key), `${key} is not a filter key`);
}

// A selected value that the current window no longer reports must still be
// offered, or the control renders blank while the filter is still applied.
const merged = mergeFacetOptions(
  [{ value: 'gpt-5', requests: 3 }],
  ['gpt-5', 'gone-from-window'],
  usageFacetLabel,
);
assert.deepEqual(merged.map((option) => option.value), ['gpt-5', 'gone-from-window']);
assert.equal(merged[0].label, 'gpt-5 (3)');
assert.equal(merged[1].label, 'gone-from-window');
assert.deepEqual(mergeFacetOptions(undefined, [], usageFacetLabel), []);

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

// Every parameter the console refuses to apply has to be nameable, or a mistyped
// link silently widens the query while the panel still shows a narrowed view.
assert.deepEqual(rejectedEventParams(new URLSearchParams('')), []);
assert.deepEqual(rejectedEventParams(new URLSearchParams('preset=1h&model=gpt-5&q=codex')), []);
assert.deepEqual(rejectedEventParams(new URLSearchParams('latency_min=abc')), ['latency_min']);
// Past the exact-integer range the value would change as it travelled, so it is
// refused and reported rather than quietly dropped.
assert.deepEqual(rejectedEventParams(new URLSearchParams('tokens_min=9007199254740993')), ['tokens_min']);
assert.deepEqual(rejectedEventParams(new URLSearchParams('cost_min=1e-9')), ['cost_min']);
assert.deepEqual(rejectedEventParams(new URLSearchParams('cost=maybe')), ['cost']);
assert.deepEqual(rejectedEventParams(new URLSearchParams('preset=nonsense')), ['preset']);
assert.deepEqual(rejectedEventParams(new URLSearchParams('result=maybe')), ['result']);
assert.deepEqual(rejectedEventParams(new URLSearchParams('q=' + 'x'.repeat(300))), ['q']);
// A reversed pair is one mistake, reported under the dimension once.
assert.deepEqual(rejectedEventParams(new URLSearchParams('latency_min=500&latency_max=100')), ['latency']);
assert.deepEqual(rejectedEventParams(new URLSearchParams('cost_min=0.1&cost_max=0.09')), ['cost']);
// A large but representable bound is applied, not reported.
assert.deepEqual(rejectedEventParams(new URLSearchParams('tokens_min=999999999999')), []);

console.log('PASS rejected filters: every unusable parameter is named, valid bounds are not');

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
  autoRefresh: false,
});

// Full valid document in the current shape.
const fullDoc = {
  preset: '24h',
  result: 'failed',
  cost: 'unpriced',
  limit: 250,
  grouping: 'provider',
  autoRefresh: true,
  filterValues: {
    model: ['gpt-4o', 'o3'],
    provider: ['openai'],
    auth_index: ['idx-1'],
    source: ['src.json'],
    api_key: ['key-1'],
    executor: ['exec-1'],
    auth_type: ['oauth'],
    model_alias: ['alias-1'],
    q: ['needle'],
    ua: ['codex-cli'],
    endpoint: ['/v1/responses'],
    request_id: ['req-123'],
    latency_min: ['100'],
    latency_max: ['60000'],
    tokens_min: ['0'],
    tokens_max: ['500000'],
    cost_min: ['0.5'],
    cost_max: ['12.5'],
    // A contradictory nested copy is present on purpose: the top-level field is the
    // canonical one, so this must not survive into the parsed document.
    cost: ['priced'],
  },
  unknown_garbage: 'dropped',
  __proto__: { polluted: true },
};
const parsedFull = parseUsageEventsView(fullDoc);
assert.deepEqual(parsedFull, {
  preset: '24h',
  result: 'failed',
  cost: 'unpriced',
  limit: 250,
  grouping: 'provider',
  autoRefresh: true,
  filterValues: {
    model: ['gpt-4o', 'o3'],
    provider: ['openai'],
    auth_index: ['idx-1'],
    source: ['src.json'],
    api_key: ['key-1'],
    executor: ['exec-1'],
    auth_type: ['oauth'],
    model_alias: ['alias-1'],
    q: ['needle'],
    ua: ['codex-cli'],
    endpoint: ['/v1/responses'],
    request_id: ['req-123'],
    latency_min: ['100'],
    latency_max: ['60000'],
    tokens_min: ['0'],
    tokens_max: ['500000'],
    cost_min: ['0.5'],
    cost_max: ['12.5'],
  },
});
assert.equal((parsedFull as Record<string, unknown>).unknown_garbage, undefined);

// The legacy flat shape is still on disk. Dropping it would silently reset a
// returning operator's filters to the default window, so each old scalar becomes
// the one-element list it always meant.
const legacy = parseUsageEventsView({
  preset: '7d',
  result: 'failed',
  limit: 250,
  grouping: 'credential',
  model: 'gpt-4o',
  provider: 'openai',
  auth_type: 'oauth',
  model_alias: 'alias-1',
  request_id: 'req-123',
});
assert.deepEqual(legacy?.filterValues, {
  model: ['gpt-4o'],
  provider: ['openai'],
  auth_type: ['oauth'],
  model_alias: ['alias-1'],
  request_id: ['req-123'],
});
assert.equal(legacy?.preset, '7d');
assert.equal(legacy?.result, 'failed');
assert.equal(legacy?.grouping, 'credential');

// The new shape wins when both are present, so a current document is never
// reinterpreted through the legacy branch.
const bothShapes = parseUsageEventsView({ filterValues: { model: ['new'] }, model: 'old' });
assert.deepEqual(bothShapes?.filterValues, { model: ['new'] });
// Blank and duplicate stored values are dropped rather than replayed; a
// dimension left with nothing is omitted entirely.
assert.equal(parseUsageEventsView({ filterValues: { model: ['  ', '', ''] } })?.filterValues, undefined);
assert.deepEqual(parseUsageEventsView({ filterValues: { model: ['  ', 'a', 'a'] } })?.filterValues, {
  model: ['a'],
});
assert.deepEqual(parseUsageEventsView({ filterValues: { model: ['a', 'a', 'b'] } })?.filterValues, {
  model: ['a', 'b'],
});
// An unwritable preference document is still rejected outright.
assert.equal(parseUsageEventsView({ cost: 'nonsense' })?.cost, undefined);
assert.equal(parseUsageEventsView({ autoRefresh: 'yes' })?.autoRefresh, false);

// A nested cost value is adopted when no top-level one exists. An earlier revision
// persisted it that way, and discarding it would silently drop a filter the
// operator saved; a valid top-level value still wins.
assert.equal(parseUsageEventsView({ filterValues: { cost: ['unpriced'] } })?.cost, 'unpriced');
assert.equal(
  parseUsageEventsView({ cost: 'priced', filterValues: { cost: ['unpriced'] } })?.cost,
  'priced',
  'the current shape wins over the nested copy',
);
assert.equal(
  parseUsageEventsView({ filterValues: { cost: ['unpriced'] } })?.filterValues,
  undefined,
  'cost is never kept inside the filter map',
);
// A sibling dimension is unaffected by the cost normalisation.
assert.deepEqual(parseUsageEventsView({ cost: 'priced', filterValues: { model: ['a'] } })?.filterValues, {
  model: ['a'],
});
// Two contradictory nested values are not a document to guess from, so no cost
// filter is produced at all.
assert.equal(
  parseUsageEventsView({ filterValues: { cost: ['priced', 'unpriced'] } })?.cost,
  undefined,
  'contradictory nested values are refused rather than guessed at',
);
assert.equal(
  parseUsageEventsView({ filterValues: { cost: ['priced', 'priced'] } })?.cost,
  'priced',
  'a repeated identical value is still a singleton',
);
assert.equal(parseUsageEventsView({ filterValues: { cost: ['nonsense'] } })?.cost, undefined);

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
assert.equal(hasExplicitEventQuery(new URLSearchParams('latency_min=100')), true);
assert.equal(hasExplicitEventQuery(new URLSearchParams('cost=unpriced')), true);
assert.equal(hasExplicitEventQuery(new URLSearchParams('q=needle')), true);

console.log('PASS usage event view preference: parsing, validation, field whitelisting, URL precedence helpers');

// ---- filter draft: the drawer's working copy ----
const emptyView = { result: 'all' as const, params: {} };
assert.deepEqual(draftFromView(emptyView), EMPTY_FILTER_DRAFT, 'an empty view produces an empty draft');
assert.deepEqual(draftToView(EMPTY_FILTER_DRAFT), emptyView, 'an empty draft produces an empty view');

const loadedView = {
  result: 'failed' as const,
  params: {
    model: ['gpt-5', 'o3'],
    auth_type: ['oauth'],
    q: ['needle'],
    endpoint: ['/v1/responses'],
    latency_min: ['100'],
    latency_max: ['60000'],
    tokens_min: ['0'],
    cost_min: ['0.000001'],
    cost_max: ['12.5'],
    cost: ['unpriced'],
  },
};
const loaded = draftFromView(loadedView);
assert.deepEqual(loaded.multi.model, ['gpt-5', 'o3']);
assert.equal(loaded.text.q, 'needle');
assert.equal(loaded.ranges.latency?.min, 100);
assert.equal(loaded.ranges.latency?.max, 60000);
// A zero bound has to load as a bound; folding it into "unset" here would make
// the field look empty while the filter still applied.
assert.equal(loaded.ranges.tokens?.min, 0);
assert.equal(loaded.ranges.cost?.min, '0.000001');
assert.equal(loaded.cost, 'unpriced');
assert.equal(loaded.result, 'failed');
assert.deepEqual(draftToView(loaded), loadedView, 'a draft round trips through the view unchanged');
assert.deepEqual(validateFilterDraft(loaded), {}, 'a loaded view is valid');

// A model alias is an exact-match dimension, so it lives in the multi map. The
// serialiser reads that map, which is why rendering it as a free-text field made
// every edit silently do nothing.
const aliasView = draftFromView({ result: 'all', params: { model_alias: ['coding-fast', 'deep'] } });
assert.deepEqual(aliasView.multi.model_alias, ['coding-fast', 'deep']);
assert.equal(aliasView.text.model_alias, undefined);
assert.deepEqual(draftToView(aliasView).params, { model_alias: ['coding-fast', 'deep'] });
assert.equal(isDraftDirty(aliasView, { result: 'all', params: {} }), true);

// A cost bound beyond the stored precision cannot be honoured, so it is an error
// rather than a silent zero.
assert.equal(
  validateFilterDraft({ ...EMPTY_FILTER_DRAFT, ranges: { cost: { min: '0.0000000001' } } }).cost_min,
  'events.range_invalid',
);
assert.equal(
  validateFilterDraft({ ...EMPTY_FILTER_DRAFT, ranges: { latency: { min: 1500.7 } } }).latency_min,
  'events.range_invalid',
);
// Cost is compared exactly, so a pair that differs in the ninth decimal is not
// reported as reversed.
assert.deepEqual(
  validateFilterDraft({ ...EMPTY_FILTER_DRAFT, ranges: { cost: { min: '0.000000001', max: '0.000000002' } } }),
  {},
);
assert.equal(
  validateFilterDraft({ ...EMPTY_FILTER_DRAFT, ranges: { cost: { min: '0.1', max: '0.09' } } }).cost,
  'events.range_reversed',
);

// A value the console cannot honour is dropped on load rather than rendered as
// an empty field that still filters the list. A large-but-representable bound is
// kept, because dropping it would widen the query instead of narrowing it.
const corrupt = draftFromView({
  result: 'all',
  params: { latency_min: ['not-a-number'], tokens_max: ['999999999999'], model: ['ok'] },
});
assert.equal(corrupt.ranges.latency, undefined);
assert.equal(corrupt.ranges.tokens?.max, 999999999999);
assert.deepEqual(corrupt.multi.model, ['ok']);

// An empty field must not round trip as a parameter, or clearing a filter would
// leave it applied.
const cleared = draftToView({ ...loaded, text: { ...loaded.text, q: '   ' } });
assert.equal(cleared.params.q, undefined);
const clearedMulti = draftToView({ ...loaded, multi: { ...loaded.multi, model: [] } });
assert.equal(clearedMulti.params.model, undefined);

// Only a field that cannot be honoured is an error; a one-sided bound is fine.
assert.deepEqual(validateFilterDraft(EMPTY_FILTER_DRAFT), {});
assert.deepEqual(validateFilterDraft({ ...EMPTY_FILTER_DRAFT, ranges: { latency: { min: 100 } } }), {});
const reversed = validateFilterDraft({ ...EMPTY_FILTER_DRAFT, ranges: { latency: { min: 500, max: 100 } } });
assert.equal(reversed.latency, 'events.range_reversed');
// An end equal to the start is a one-millisecond window, not a reversal.
assert.deepEqual(validateFilterDraft({ ...EMPTY_FILTER_DRAFT, ranges: { latency: { min: 100, max: 100 } } }), {});
const tooLarge = validateFilterDraft({
  ...EMPTY_FILTER_DRAFT,
  ranges: { latency: { min: USAGE_RANGE_MAX.latency + 1 } },
});
assert.equal(tooLarge.latency_min, 'events.range_too_large');
assert.equal(tooLarge.latency, undefined, 'a field error must not also report a range error');
assert.deepEqual(
  validateFilterDraft({ ...EMPTY_FILTER_DRAFT, ranges: { latency: { min: 100, max: 100 } } }),
  {},
  'a pair with equal ends is not reversed',
);

// Dirty detection drives whether Apply is enabled, so it has to notice a removal
// as well as an addition.
assert.equal(isDraftDirty(EMPTY_FILTER_DRAFT, emptyView), false);
assert.equal(isDraftDirty(loaded, loadedView), false);
assert.equal(isDraftDirty({ ...loaded, result: 'all' }, loadedView), true);
assert.equal(isDraftDirty({ ...loaded, text: { ...loaded.text, q: 'other' } }, loadedView), true);
assert.equal(isDraftDirty({ ...loaded, multi: { ...loaded.multi, model: ['gpt-5'] } }, loadedView), true);
assert.equal(isDraftDirty({ ...loaded, multi: { ...loaded.multi, model: ['o3', 'gpt-5'] } }, loadedView), true, 'reordering a multi-select is a change');
assert.equal(isDraftDirty({ ...loaded, ranges: { ...loaded.ranges, latency: { min: 100 } } }, loadedView), true);
// A trailing space in a text field is not a semantic change; the value is
// trimmed before it reaches the URL either way.
assert.equal(isDraftDirty({ ...loaded, text: { ...loaded.text, q: 'needle ' } }, loadedView), false);

console.log(
  'PASS filter draft: typed load, lossless round trip, invalidation, dirty detection, zero as a bound',
);

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

// Provider-key to configured-name resolution for the request filter.
//
// The reported value is CPA's stored provider key, so the label has to come from
// the operator's configuration. Guessing it from the key (stripping a prefix,
// capitalising) would print a name the operator never chose and would disagree
// with the providers page for the same line.
const nameResolver = createProviderNameResolver([
  { id: 'openai-compat-0', name: 'CommandCode GOAT', family: 'openai-compatibility', auth_index: 'shared-index' },
  { id: 'custom-deepseek', name: 'DeepSeek 专线', family: 'openai-compatibility' },
  { id: 'claude-1', name: 'Claude relay', family: 'claude' },
]);
// Exact id match wins even though the key itself carries an operator-style name.
assert.equal(nameResolver('openai-compat-0'), 'CommandCode GOAT');
assert.equal(nameResolver('custom-deepseek'), 'DeepSeek 专线');
assert.equal(nameResolver('claude-1'), 'Claude relay');
// The key CPA stores for a configured OpenAI-compatible line is its display name
// behind a prefix, which resolves once the prefix is stripped.
assert.equal(nameResolver('openai-compatible-commandcode goat'), 'CommandCode GOAT');
assert.equal(nameResolver('openai-compatible-deepseek 专线'), 'DeepSeek 专线');
// Case never decides identity, and surrounding whitespace is not a difference.
assert.equal(nameResolver('OPENAI-COMPAT-0'), 'CommandCode GOAT');
assert.equal(nameResolver('  openai-compat-0  '), 'CommandCode GOAT');
// A deleted or renamed provider keeps the raw key: still true, never fabricated.
assert.equal(nameResolver('openai-compatible-vanished-line'), 'openai-compatible-vanished-line');
assert.equal(nameResolver('codex'), 'codex');
assert.equal(nameResolver(''), '');
assert.equal(nameResolver(null), '');
assert.equal(nameResolver(undefined), '');
// An ambiguous key is reported raw rather than resolved to an arbitrary provider.
// An exact name still wins outright: the stripped remainder equals one
// provider's name, and the other name is not contained in it.
const nearMiss = createProviderNameResolver([
  { id: 'a', name: 'Relay' },
  { id: 'b', name: 'Relay Two' },
]);
assert.equal(nearMiss('openai-compatible-relay'), 'Relay');
// A key two providers could both answer to stays raw rather than picking one:
// neither name equals the remainder, and both are contained in it.
const ambiguousResolver = createProviderNameResolver([
  { id: 'a', name: 'Relay' },
  { id: 'b', name: 'One' },
]);
assert.equal(ambiguousResolver('openai-compatible-relay one'), 'openai-compatible-relay one');
// An empty configuration resolves nothing and never throws.
const emptyResolver = createProviderNameResolver([]);
assert.equal(emptyResolver('openai-compatible-anything'), 'openai-compatible-anything');
assert.equal(providerFacetLabel('CommandCode GOAT', 42), 'CommandCode GOAT (42)');
console.log('PASS provider name resolution: configured name, prefix strip, exact id, raw-key fallback, ambiguity');

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
