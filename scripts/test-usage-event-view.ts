import assert from 'node:assert/strict';
import {
  readEventQuery,
  readFilterParams,
  rejectedEventParams,
  filterParamsToUrl,
  queryToFilterParams,
  eventWindow,
  eventWindowQuery,
  mergeFacetOptions,
  activeFilterCount,
  EVENT_FILTER_KEYS,
  hasExplicitEventQuery,
} from '../web/src/types/usageEventQuery.ts';
import { EVENT_AUTO_REFRESH_MS } from '../web/src/types/usageEventCadence.ts';
import {
  DEFAULT_USAGE_EVENTS_VIEW,
  USAGE_EVENTS_VIEW_PREFERENCE,
  EVENT_GROUPING_VALUES,
  parseEventGrouping,
  parseUsageEventsView,
} from '../web/src/types/usageEventViewPreference.ts';
import {
  indexCredentialFiles,
  resolveCredential,
  resolveProviderInfo,
  createProviderNameResolver,
} from '../web/src/types/usageEventIdentity.ts';
import {
  requestGroupName,
  eventKeyLabel,
  eventResultLabelKey,
  eventUserAgentLabel,
  usageFacetLabel,
  providerFacetLabel,
} from '../web/src/types/usageEventLabels.ts';
import {
  eventPageMetrics,
  formatEventDuration,
  eventCacheRate,
  successRateTone,
  SUCCESS_RATE_DEGRADED_PERCENT,
  SUCCESS_RATE_HEALTHY_PERCENT,
  hasMeasurableTTFT,
  isFastTierEvent,
  fastTierHintKey,
  requestTransport,
} from '../web/src/types/usageEventMetrics.ts';
import {
  eventProviderIdentity,
  eventCredentialIdentity,
  eventUserAgentGroupKey,
  formatEventSourceGroupTitle,
  providersWithMultipleAuthSources,
  UNKNOWN_EVENT_GROUP,
} from '../web/src/types/usageEventGrouping.ts';
import {
  EMPTY_FILTER_DRAFT,
  draftFromView,
  draftToView,
  isDraftDirty,
  validateFilterDraft,
} from '../web/src/types/usageEventFilters.ts';
import {
  REQUEST_COLUMNS,
  REQUEST_STACK_WIDTH,
  foldRequestColumns,
  USAGE_EVENTS_COLUMNS_PREFERENCE,
  parseUsageEventsColumns,
  SHEET_GRID_CHROME,
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
import { test } from 'vitest';

test('usage event view', () => {
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

  // Reads send the window as chosen and leave "now" to the server. Records carry the
  // server's clock, so an end resolved on a browser clock that runs behind hid every
  // record newer than it - a request that had just completed stayed off the list
  // through any number of refreshes. Only a bound the reader picked may travel.
  assert.deepEqual(eventWindowQuery(read('preset=15m')), { preset: '15m' });
  assert.deepEqual(eventWindowQuery(read('from=100')), { from: 100 });
  assert.deepEqual(eventWindowQuery(read('from=100&to=200')), { from: 100, to: 200 });
  for (const [input, expected] of [
    ['preset=1h', 'preset=1h'],
    ['from=100', 'from=100'],
    ['from=100&to=200', 'from=100&to=200'],
  ] as const) {
    const chosen = read(input);
    const sent = new URLSearchParams(usageEventParams({ ...chosen, ...eventWindowQuery(chosen) }));
    const windowParams = ['preset', 'from', 'to']
      .filter((key) => sent.has(key))
      .map((key) => `${key}=${sent.get(key)}`)
      .join('&');
    assert.equal(windowParams, expected, `the ${input} window reaches the server unresolved`);
  }

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
    'auth_type=oauth&reasoning=high&service_tier=flex&resolved_service_tier=priority&model_alias=fast',
    'q=codex&ua=codex-cli&endpoint=%2Fv1%2Fresponses&request_id=req-1',
    'latency_min=100&latency_max=60000&tokens_min=0&tokens_max=500000',
    'cost_min=0.000001&cost_max=12.5&cost=unpriced&served=substituted&transport=websocket',
  ].join('&');
  const everyQuery = read(everyFilter);
  assert.deepEqual(everyQuery.filters?.resolved_service_tier, ['priority']);
  const everyParams = new URLSearchParams(usageEventParams(everyQuery));
  assert.deepEqual(everyParams.getAll('resolved_service_tier'), ['priority']);
  const everyAgain = read(everyParams.toString());
  assert.deepEqual(everyAgain, everyQuery);
  assert.equal(everyAgain.ranges?.tokens?.min, 0, 'a bound of zero is a bound, not an absent one');
  assert.equal(everyAgain.ranges?.cost?.min, '0.000001', 'a cost bound keeps its decimal text');
  assert.equal(everyAgain.cost, 'unpriced');
  assert.equal(everyAgain.served, 'substituted');
  assert.equal(everyAgain.transport, 'websocket');
  // An unknown served state is dropped from the query and reported, never sent on
  // as a filter the server would refuse.
  assert.equal(read('served=maybe').served, undefined);
  assert.deepEqual(rejectedEventParams(new URLSearchParams('served=maybe')), ['served']);
  assert.deepEqual(rejectedEventParams(new URLSearchParams('served=matched')), []);
  assert.equal(read('transport=grpc').transport, undefined);
  assert.deepEqual(rejectedEventParams(new URLSearchParams('transport=grpc')), ['transport']);

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

  // An open-ended custom range is expressed by `from` without `to`; it must
  // reach the server that way rather than falling back to a relative preset and
  // silently widening the query.
  const openEndedParams = new URLSearchParams(usageEventParams({ from: 100, result: 'all', limit: 100 }));
  assert.equal(openEndedParams.get('from'), '100');
  assert.equal(openEndedParams.has('to'), false);
  assert.equal(openEndedParams.has('preset'), false);

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


  const files = indexCredentialFiles([{ name: 'current.json', auth_index: 'auth-1', provider: 'openai' }]);
  const unbound = { ...event, resource_name: null, source: 'hmac:source-identifier', provider: 'openai' };
  assert.deepEqual(resolveCredential(event, files), { name: 'resource.json', kind: 'resource' });
  assert.deepEqual(resolveCredential(unbound, files), { name: 'current.json', kind: 'current_file' });
  // A file named after its account prints that account masked, while the stored name
  // stays the grouping identity: two accounts can render the same mask.
  const namedAfterAccount = indexCredentialFiles([
    { name: 'codex-owner@example.com.json', auth_index: 'auth-1', provider: 'openai', type: 'oauth', email: 'owner@example.com' },
  ]);
  assert.deepEqual(resolveCredential(unbound, namedAfterAccount), {
    name: 'codex-owner@example.com.json',
    displayName: 'ow•••r@example.com',
    kind: 'current_file',
  });
  // A discovered resource is named after the auth file, so the resource branch carries the
  // same masked display form while its raw name stays the grouping key.
  const namedResource = { ...unbound, resource_name: 'codex-owner@example.com.json' } as UsageEvent;
  assert.deepEqual(resolveCredential(namedResource, namedAfterAccount), {
    name: 'codex-owner@example.com.json',
    displayName: 'ow•••r@example.com',
    kind: 'resource',
  });
  // A Vertex service account reports both an address and a project id, and its file is
  // named after the project: masking only the first reported identity would leave it whole.
  const vertexFiles = indexCredentialFiles([
    {
      name: 'vertex-acme-prod.json',
      auth_index: 'auth-vertex',
      provider: 'vertex',
      type: 'vertex',
      email: 'runner@acme-prod.iam.gserviceaccount.com',
      project_id: 'acme-prod',
    },
  ]);
  const vertexEvent = { ...unbound, auth_index: 'auth-vertex', provider: 'vertex' } as UsageEvent;
  assert.deepEqual(resolveCredential(vertexEvent, vertexFiles), {
    name: 'vertex-acme-prod.json',
    displayName: 'ru•••r@acme-prod.iam.gserviceaccount.com',
    kind: 'current_file',
  });
  assert.deepEqual(resolveCredential({ ...unbound, provider: 'claude' }, files), {
    name: 'auth-1',
    kind: 'index',
  });
  const customNamed = indexCredentialFiles([
    { name: 'current.json', auth_index: 'auth-1', provider: 'openai', display_name: 'Team seat' },
  ]);
  assert.deepEqual(resolveCredential(unbound, customNamed), {
    name: 'current.json', displayName: 'Team seat', kind: 'current_file',
  });
  assert.deepEqual(resolveCredential({ ...unbound, provider: 'claude' }, customNamed), {
    name: 'auth-1', kind: 'index',
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
    // The document stores the retired `provider` grouping, so this assertion also
    // pins the migration: a saved view keeps its shape instead of reverting to
    // chronological order.
    grouping: 'source',
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
  // The flat document carries the retired `credential` grouping, which migrates to
  // the merged source mode this console now offers.
  assert.equal(legacy?.grouping, 'source');

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
  assert.equal(parseUsageEventsView({ grouping: 'source' })?.grouping, 'source');
  assert.equal(parseUsageEventsView({ grouping: 'ua' })?.grouping, 'ua');
  assert.equal(parseUsageEventsView({ grouping: 'time' })?.grouping, 'time');
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
  assert.equal(hasExplicitEventQuery(new URLSearchParams('served=substituted')), true);
  assert.equal(hasExplicitEventQuery(new URLSearchParams('q=needle')), true);



  // ---- grouping: the merged source mode, the UA mode, and legacy migration ----

  // The retired modes both described the provider-and-credential pair the merged
  // mode now means, so a saved view keeps its shape rather than reverting to
  // chronological order - which a returning operator reads as "my preference was
  // forgotten".
  assert.equal(parseEventGrouping('provider'), 'source', 'a stored provider grouping migrates');
  assert.equal(parseEventGrouping('credential'), 'source', 'a stored credential grouping migrates');
  assert.equal(parseUsageEventsView({ grouping: 'provider' })?.grouping, 'source');
  assert.equal(parseUsageEventsView({ grouping: 'credential' })?.grouping, 'source');

  // The current modes round trip, and anything unreadable falls back to the order
  // that never hides a record.
  for (const value of EVENT_GROUPING_VALUES) {
    assert.equal(parseEventGrouping(value), value);
  }
  for (const value of [undefined, null, '', 'nonsense', 'PROVIDER', 'Source']) {
    assert.equal(parseEventGrouping(value), 'time', `${String(value)} must fall back to chronological`);
  }
  assert.equal(EVENT_GROUPING_VALUES.length, 3, 'the console offers exactly time, source and client');

  // `provider` and `credential` are gone as values, so no consumer can be handed
  // one by the parser any more.
  assert.equal((EVENT_GROUPING_VALUES as readonly string[]).includes('provider'), false);
  assert.equal((EVENT_GROUPING_VALUES as readonly string[]).includes('credential'), false);



  // ---- source grouping keeps provider context and splits the auth source ----

  const sourceEvents = [
    {
      id: 1,
      provider: 'openai-compatible-relay-station',
      auth_index: 'cred-a',
      source: 'team.json',
      user_agent: 'Claude-Code/1.2',
    },
    {
      id: 2,
      provider: 'openai-compatible-relay-station',
      auth_index: 'cred-b',
      source: 'personal.json',
      user_agent: 'codex-cli/0.9',
    },
    { id: 3, provider: 'openai-compatible-relay-station', auth_index: 'cred-b', source: 'personal.json' },
    { id: 4, provider: '', auth_index: '', source: '', resource_name: '' },
  ] as unknown as UsageEvent[];

  const credentialFiles = indexCredentialFiles([
    // The stored provider field is CPA's own key for the line, and the resolver
    // refuses to attach a file whose provider disagrees with the record - so the
    // fixture has to carry the real key or the test would be asserting the
    // fallback rather than the lookup.
    { name: 'team.json', auth_index: 'cred-a', provider: 'openai-compatible-relay-station' },
    { name: 'personal.json', auth_index: 'cred-b', provider: 'openai-compatible-relay-station' },
  ]);
  const resolveName = createProviderNameResolver([
    {
      id: 'openai-compat-0',
      name: 'Relay Station',
      upstream_name: 'relay-station',
      family: 'openai-compatibility',
    },
  ]);

  // The provider half resolves to the operator's own name for the line, so the
  // header agrees with the providers page instead of printing CPA's raw key.
  const resolvedProvider = eventProviderIdentity(sourceEvents[0], resolveName, 'Provider not recorded');
  assert.equal(resolvedProvider.label, 'Relay Station');
  assert.equal(resolvedProvider.key, 'relay station', 'bucketing is case-insensitive');

  // A missing provider or credential is its own bucket rather than a dropped row.
  const unknownProvider = eventProviderIdentity(sourceEvents[3], resolveName, 'Provider not recorded');
  assert.equal(unknownProvider.key, UNKNOWN_EVENT_GROUP);
  assert.equal(unknownProvider.label, 'Provider not recorded');
  const unknownCredential = eventCredentialIdentity(sourceEvents[3], credentialFiles, 'Credential not recorded');
  assert.equal(unknownCredential.key, UNKNOWN_EVENT_GROUP);
  assert.equal(unknownCredential.label, 'Credential not recorded');

  // The credential half is the readable file name, not the stored auth index.
  assert.equal(
    eventCredentialIdentity(sourceEvents[0], credentialFiles, 'Credential not recorded').label,
    'team.json',
  );

  // Two credentials for one provider are named; a provider served by one
  // credential is not repeated on every header.
  const multiple = providersWithMultipleAuthSources(sourceEvents, credentialFiles, resolveName, 'Provider not recorded');
  assert.equal(multiple.has('relay station'), true, 'two credentials make this provider split');
  assert.equal(multiple.size, 1, 'the unknown provider is not split');
  assert.equal(
    formatEventSourceGroupTitle('Relay Station', 'team.json', true),
    'Relay Station / team.json',
  );
  assert.equal(
    formatEventSourceGroupTitle('Relay Station', 'team.json', false),
    'Relay Station',
    'a single-credential provider reads as the provider alone',
  );

  // The single-credential case is what the merged mode buys over the old
  // credential grouping: the same header no longer prints a credential nobody
  // needs to distinguish.
  const single = providersWithMultipleAuthSources(
    [sourceEvents[0]],
    credentialFiles,
    resolveName,
    'Provider not recorded',
  );
  assert.equal(single.has('relay station'), false);

  // An ambiguous auth index must not be resolved to a guessed file name, but it
  // still names something real - the index - so it stays a distinct bucket rather
  // than collapsing into `unknown`. Folding it into `unknown` would merge two
  // different credentials of one provider into a single header, which is exactly
  // what the merged grouping must not do.
  const ambiguousFiles = indexCredentialFiles([
    { name: 'team.json', auth_index: 'cred-a', provider: 'openai-compatible-relay-station' },
    { name: 'other.json', auth_index: 'cred-a', provider: 'openai-compatible-relay-station' },
  ]);
  const ambiguousIdentity = eventCredentialIdentity(sourceEvents[0], ambiguousFiles, 'Credential not recorded');
  assert.equal(ambiguousIdentity.label, 'cred-a', 'an ambiguous index is not given a guessed file name');
  assert.notEqual(ambiguousIdentity.key, UNKNOWN_EVENT_GROUP, 'a real index is not the unknown bucket');
  assert.notEqual(
    ambiguousIdentity.key,
    eventCredentialIdentity(sourceEvents[1], credentialFiles, 'Credential not recorded').key,
    'two different credentials of one provider stay distinct',
  );

  // And a record with no credential at all lands in the unknown bucket.
  assert.equal(
    eventCredentialIdentity(sourceEvents[3], credentialFiles, 'Credential not recorded').key,
    UNKNOWN_EVENT_GROUP,
  );



  // ---- UA grouping ----

  // The stored value is already the minimised product label, so it is used
  // verbatim; bucketing lower-cases so two spellings of one client are one bucket.
  assert.equal(eventUserAgentGroupKey(sourceEvents[0]), 'claude-code/1.2');
  assert.equal(eventUserAgentGroupKey({ user_agent: 'Codex-CLI/0.9' }), 'codex-cli/0.9');
  assert.equal(eventUserAgentGroupKey({ user_agent: '  spaced/1.0  ' }), 'spaced/1.0');

  // A record captured without a client is its own bucket, never dropped and never
  // folded into a named client.
  for (const absent of [undefined, null, '', '   ']) {
    assert.equal(eventUserAgentGroupKey({ user_agent: absent }), UNKNOWN_EVENT_GROUP);
  }



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
      served: ['substituted'],
      transport: ['sse'],
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
  assert.equal(loaded.served, 'substituted');
  assert.equal(loaded.transport, 'sse');
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

  const reusedIndex = indexCredentialFiles([
    { name: 'codex.json', auth_index: 'auth-oauth', provider: 'codex', email: 'new@example.com', display_name: 'New seat' },
  ]);
  const historical = resolveProviderInfo(oauthEvent, reusedIndex);
  assert.equal(historical.credential, 'auth-oauth', 'a reused index cannot name another provider’s credential');
  assert.equal(historical.title, 'Claude');
  assert.equal(historical.accountIdentity, undefined);

  // A resource names the file CPA recorded. The live file behind today's index may be another
  // file entirely, so its operator name must not stand in for the resource's label; the resource
  // row keeps the masked account every surface printed before a name existed.
  const resourceFromOtherFile = {
    ...unbound, provider: 'openai', auth_index: 'auth-1', resource_name: 'history.json',
  } as UsageEvent;
  assert.deepEqual(resolveCredential(resourceFromOtherFile, customNamed), {
    name: 'history.json',
    kind: 'resource',
  }, 'another file\u2019s operator name never labels a resource it does not name');
  const resourceFromOtherFileWithAccount = {
    ...resourceFromOtherFile, resource_name: 'codex-owner@example.com.json',
  } as UsageEvent;
  assert.equal(resolveCredential(resourceFromOtherFileWithAccount, namedAfterAccount).displayName, 'ow•••r@example.com',
    'the matching file\u2019s account labels its resource, as before');
  const resourceFromSameFile = {
    ...unbound, provider: 'openai', auth_index: 'auth-1', resource_name: 'current.json',
  } as UsageEvent;
  assert.equal(resolveCredential(resourceFromSameFile, customNamed).displayName, 'Team seat',
    'the operator name stands in only for the resource of the file it names');

  // A provider mismatch drops attribution, never masking: the rejected file still reports the
  // address the resource name repeats, so the label stays masked exactly as before the rename.
  const rejectedFile = indexCredentialFiles([
    { name: 'codex-owner@example.com.json', auth_index: 'auth-1', provider: 'codex', email: 'owner@example.com' },
  ]);
  assert.equal(
    resolveCredential({ ...resourceFromOtherFileWithAccount, provider: 'claude' }, rejectedFile).displayName,
    'codex-ow•••r@example.com.json',
    'a mismatched file still masks the resource name',
  );

  const oauthResolved = resolveProviderInfo(oauthEvent, credFiles);
  assert.equal(oauthResolved.isOAuth, true);
  // One grammar for both credential types: the provider is the title, and the
  // credential that answered is the line under it. The line is the masked account,
  // because a request record is shared far more often than it is read alone; the raw
  // address survives only for an export the operator explicitly unredacts.
  assert.equal(oauthResolved.title, 'Claude', 'an OAuth cell leads with its provider, as an API-key cell does');
  assert.equal(oauthResolved.credential, 'us•••r@example.com', 'the account is the credential line, masked');
  // A file that records only its credential type does not name the provider; the record does.
  const typeOnlyOAuth = resolveProviderInfo(
    oauthEvent,
    indexCredentialFiles([{ name: 'someone.json', auth_index: 'auth-oauth', type: 'oauth', email: 'user@example.com' }]),
  );
  assert.equal(typeOnlyOAuth.title, 'Claude', 'the title is the provider, never the word for the credential type');
  assert.equal(typeOnlyOAuth.iconId, 'Claude');
  assert.equal(oauthResolved.iconId, 'Claude');
  assert.equal(oauthResolved.accountIdentity, 'user@example.com');
  // The source-group header prints the same masked identity, while its bucket keeps the
  // raw name: a header must not merge two accounts whose masks happen to be alike.
  const oauthIdentity = eventCredentialIdentity(oauthEvent, credFiles, 'Credential not recorded');
  assert.equal(oauthIdentity.key, 'oauth-claude.json', 'the header buckets by the stored file name');
  assert.equal(oauthIdentity.label, 'us•••r@example.com', 'the account labels the credential without changing its grouping identity');
  const namedIdentity = eventCredentialIdentity(unbound, namedAfterAccount, 'Credential not recorded');
  assert.equal(namedIdentity.key, 'codex-owner@example.com.json', 'the raw name remains the bucket');
  assert.equal(namedIdentity.label, 'ow•••r@example.com', 'the header prints the masked account');

  const apiKeyEvent = {
    id: 11,
    provider: 'openai',
    auth_index: 'auth-apikey',
    tokens: { total: 100, input: 50, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
  } as UsageEvent;

  const apiKeyResolved = resolveProviderInfo(apiKeyEvent, credFiles, { 'openai': 'OpenAI' });
  assert.equal(apiKeyResolved.isOAuth, false);
  assert.equal(apiKeyResolved.title, 'openai');
  assert.equal(apiKeyResolved.credential, undefined);

  // Configured AI provider match
  const configuredProviders = [
    { id: 'custom-deepseek', name: 'DeepSeek 专线', family: 'deepseek', auth_index: 'auth-apikey' },
    { id: 'opencode-1', name: 'Opencode', family: 'openai-compatibility', auth_index: 'auth-opencode' },
  ];
  const customResolved = resolveProviderInfo(apiKeyEvent, credFiles, { 'custom-deepseek': 'DeepSeek' }, configuredProviders);
  assert.equal(customResolved.isOAuth, false);
  assert.equal(customResolved.title, 'DeepSeek 专线');
  assert.equal(customResolved.iconId, 'DeepSeek');
  assert.equal(customResolved.credential, undefined);

  // The key that served the record outranks a name match earlier in the list, and every key of a
  // provider counts, not only its first.
  const secondKeyEvent = { ...apiKeyEvent, provider: 'codex', auth_index: 'auth-codex-second' } as UsageEvent;
  const byServingKey = resolveProviderInfo(secondKeyEvent, credFiles, {}, [
    { id: 'codex-0', name: 'codex', family: 'codex', auth_index: 'auth-codex-first', auth_indexes: ['auth-codex-first'] },
    { id: 'openai-compat-0', name: 'Relay', family: 'openai-compatibility', auth_index: 'auth-relay-first', auth_indexes: ['auth-relay-first', 'auth-codex-second'] },
  ]);
  assert.equal(byServingKey.title, 'Relay');

  // Removing a provider must not transfer its history to a surviving name match.
  const relayProviders = [
    { id: 'openai-compat-0', name: 'Relay', upstream_name: 'relay', family: 'openai-compatibility', auth_indexes: ['relay-key'] },
    { id: 'openai-compat-1', name: 'Relay Pro', upstream_name: 'relay-pro', family: 'openai-compatibility', auth_indexes: ['relay-pro-key'] },
  ];
  for (const authIndex of ['relay-pro-key', '']) {
    const relayEvent = Object.freeze({
      ...apiKeyEvent,
      provider: 'openai-compatible-relay-pro',
      auth_index: authIndex,
      resource_name: 'relay-pro',
    });
    assert.equal(resolveProviderInfo(relayEvent, credFiles, {}, relayProviders).title, 'Relay Pro');
    assert.deepEqual(
      resolveProviderInfo(relayEvent, credFiles, {}, relayProviders.slice(0, 1)),
      resolveProviderInfo(relayEvent, credFiles),
      'deleting a provider must leave its request unclaimed instead of assigning a substring match',
    );
  }

  // An index is authoritative only when one provider claims it. Neither an exact
  // label nor list order can resolve a deleted or multiply claimed credential.
  const staleCredentialEvent = { ...apiKeyEvent, provider: 'openai-compatible-relay', auth_index: 'removed-key' };
  assert.deepEqual(
    resolveProviderInfo(staleCredentialEvent, credFiles, {}, relayProviders),
    resolveProviderInfo(staleCredentialEvent, credFiles),
    'a current provider label cannot substitute for a deleted credential',
  );
  const duplicateCredentials = relayProviders.map((provider) => ({ ...provider, auth_indexes: ['shared-index'] }));
  const duplicateCredentialEvent = { ...apiKeyEvent, provider: 'openai-compatible-relay', auth_index: 'shared-index' };
  for (const providers of [duplicateCredentials, [...duplicateCredentials].reverse()]) {
    assert.deepEqual(
      resolveProviderInfo(duplicateCredentialEvent, credFiles, {}, providers),
      resolveProviderInfo(duplicateCredentialEvent, credFiles),
      'an ambiguous credential must not select a provider by label or list order',
    );
  }

  // Technical driver string: openai-compatible-opencode go -> Opencode
  const opencodeEvent = {
    id: 12,
    provider: 'openai-compatible-opencode go',
    auth_index: 'auth-opencode',
    tokens: { total: 100, input: 50, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
  } as UsageEvent;
  const opencodeResolved = resolveProviderInfo(opencodeEvent, credFiles, {}, configuredProviders);
  assert.equal(opencodeResolved.isOAuth, false);
  assert.equal(opencodeResolved.title, 'Opencode');
  assert.equal(opencodeResolved.credential, undefined);

  // Unconfigured records retain the exact upstream label rather than inventing a name.
  const fallbackOpencodeEvent = {
    id: 13,
    provider: 'openai-compatible-opencode go',
    tokens: { total: 100, input: 50, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
  } as UsageEvent;
  const fallbackOpencodeResolved = resolveProviderInfo(fallbackOpencodeEvent, credFiles, {}, []);
  assert.equal(fallbackOpencodeResolved.isOAuth, false);
  assert.equal(fallbackOpencodeResolved.title, 'openai-compatible-opencode go');
  assert.equal(fallbackOpencodeResolved.credential, undefined);

  // A request answered by a plugin-registered OAuth provider carries that plugin's own
  // logo, looked up by the provider key the credential file and the record share.
  const pluginEvent = {
    id: 14,
    provider: 'codebuddy',
    auth_type: 'oauth',
    auth_index: 'auth-plugin',
    tokens: { total: 10, input: 5, output: 5, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0 },
  } as UsageEvent;
  const pluginCredFiles = indexCredentialFiles([
    { name: 'codebuddy.json', auth_index: 'auth-plugin', provider: 'codebuddy', type: 'codebuddy' },
  ]);
  const pluginLogoURL = 'https://cdn.example.test/codebuddy.svg';
  const pluginResolved = resolveProviderInfo(
    pluginEvent,
    pluginCredFiles,
    {},
    [],
    undefined,
    { codebuddy: pluginLogoURL },
  );
  assert.equal(pluginResolved.isOAuth, true);
  assert.equal(pluginResolved.logo, pluginLogoURL, 'the plugin logo is carried on the resolved row');

  // Without a plugin owning the provider there is no logo, so the row keeps the
  // console's own mark for it.
  const plainResolved = resolveProviderInfo(pluginEvent, pluginCredFiles);
  assert.equal(plainResolved.logo, undefined);
  assert.equal(oauthResolved.logo, undefined, 'a built-in provider carries no plugin logo');



  // Provider-key to configured-name resolution for the request filter.
  //
  // The reported value is CPA's stored provider key, so the label has to come from
  // the operator's configuration. Guessing it from the key (stripping a prefix,
  // capitalising, or matching a substring) would print a name the operator never
  // chose and would disagree with the providers page for the same line.
  const nameResolver = createProviderNameResolver([
    { id: 'openai-compat-0', name: 'CommandCode GOAT', upstream_name: 'commandcode goat', family: 'openai-compatibility' },
    { id: 'custom-deepseek', name: 'DeepSeek 专线', upstream_name: 'deepseek', family: 'openai-compatibility' },
    { id: 'claude-1', name: 'Claude relay', family: 'claude' },
  ]);
  // The key CPA stores is the prefix plus the upstream name, so the lookup is exact.
  assert.equal(nameResolver('openai-compatible-commandcode goat'), 'CommandCode GOAT');
  assert.equal(nameResolver('openai-compatible-deepseek'), 'DeepSeek 专线');
  // The local provider id resolves too, for a key that carries one.
  assert.equal(nameResolver('openai-compat-0'), 'CommandCode GOAT');
  assert.equal(nameResolver('custom-deepseek'), 'DeepSeek 专线');
  assert.equal(nameResolver('claude-1'), 'Claude relay');
  // Case never decides identity, and surrounding whitespace is not a difference.
  assert.equal(nameResolver('OPENAI-COMPATIBLE-COMMANDCODE GOAT'), 'CommandCode GOAT');
  assert.equal(nameResolver('  openai-compatible-commandcode goat  '), 'CommandCode GOAT');
  // The custom name is not an identity: a key that merely resembles part of it
  // proves nothing, and must not be matched.
  assert.equal(nameResolver('openai-compatible-commandcode'), 'openai-compatible-commandcode');
  assert.equal(nameResolver('openai-compatible-goat'), 'openai-compatible-goat');
  // A deleted or renamed provider keeps the raw key: still true, never fabricated.
  assert.equal(nameResolver('openai-compatible-vanished-line'), 'openai-compatible-vanished-line');
  assert.equal(nameResolver('codex'), 'codex');
  assert.equal(nameResolver(''), '');
  assert.equal(nameResolver(null), '');
  assert.equal(nameResolver(undefined), '');
  // An identity two providers both claim stays unresolved rather than being handed
  // to whichever happened to be listed first.
  const duplicateUpstream = createProviderNameResolver([
    { id: 'a', name: 'Relay One', upstream_name: 'relay' },
    { id: 'b', name: 'Relay Two', upstream_name: 'relay' },
  ]);
  assert.equal(duplicateUpstream('openai-compatible-relay'), 'openai-compatible-relay');
  // A custom name differing from the upstream name still resolves through the
  // upstream identity, which is the whole point of recording it separately.
  const customName = createProviderNameResolver([
    { id: 'openai-compat-3', name: '我的专线', upstream_name: 'vendor-x' },
  ]);
  assert.equal(customName('openai-compatible-vendor-x'), '我的专线');
  // The custom name alone must not resolve, because it is not what CPA stores.
  assert.equal(customName('openai-compatible-我的专线'), 'openai-compatible-我的专线');
  const upstreamOnlyEvent = { ...apiKeyEvent, provider: 'openai-compatible-vendor-x', auth_index: '' };
  assert.equal(resolveProviderInfo(upstreamOnlyEvent, credFiles, {}, [
    { id: 'openai-compat-3', name: '我的专线', upstream_name: 'vendor-x' },
  ]).title, customName(upstreamOnlyEvent.provider), 'rows and facets resolve the same exact upstream identity');
  // CPA's compatibility namespace distinguishes an upstream named "codex" from
  // the native family's indexless records; the bare family is not its identity.
  const familyNamedRelay = [{ id: 'openai-compat-0', name: 'Codex relay', upstream_name: 'codex', family: 'openai-compatibility' }];
  const familyOnlyEvent = { ...upstreamOnlyEvent, provider: 'codex' };
  assert.deepEqual(
    resolveProviderInfo(familyOnlyEvent, credFiles, {}, familyNamedRelay),
    resolveProviderInfo(familyOnlyEvent, credFiles),
    'an upstream name in a different CPA namespace cannot claim a family label',
  );
  assert.equal(createProviderNameResolver(familyNamedRelay)('codex'), 'codex');
  assert.equal(createProviderNameResolver(familyNamedRelay)('openai-compatible-codex'), 'Codex relay');
  const duplicateNames = [
    { id: 'openai-compat-0', name: 'Relay', upstream_name: 'relay' },
    { id: 'openai-compat-1', name: 'Relay', upstream_name: 'relay' },
  ];
  const duplicateNameEvent = { ...upstreamOnlyEvent, provider: 'openai-compatible-relay' };
  assert.equal(createProviderNameResolver(duplicateNames)(duplicateNameEvent.provider), duplicateNameEvent.provider);
  assert.deepEqual(
    resolveProviderInfo(duplicateNameEvent, credFiles, {}, duplicateNames),
    resolveProviderInfo(duplicateNameEvent, credFiles),
    'identical display names do not make two provider identities unambiguous',
  );
  // An empty configuration resolves nothing and never throws.
  const emptyResolver = createProviderNameResolver([]);
  assert.equal(emptyResolver('openai-compatible-anything'), 'openai-compatible-anything');
  assert.equal(providerFacetLabel('CommandCode GOAT', 42), 'CommandCode GOAT (42)');


  // Timing visibility and request mode do not depend on a guessed throughput threshold.
  assert.equal(hasMeasurableTTFT(undefined), false);
  for (const [latency_ms, ttft_ms, expected] of [[31251, 4423, true], [61275, 61258, true], [10000, 10000, false], [10000, 10500, false]] as const) {
    assert.equal(hasMeasurableTTFT({ latency_ms, ttft_ms }), expected);
  }
  // A WebSocket executor names the transport whatever the stream flag says; the server's
  // `transport` filter applies the same rule.
  for (const [executor_type, stream, expected] of [
    ['CodexWebsocketsExecutor', false, 'websocket'],
    ['XAIWebsocketsExecutor', null, 'websocket'],
    ['CodexExecutor', true, 'sse'],
    ['CodexExecutor', false, 'http'],
    ['', null, null],
    [undefined, undefined, null],
  ] as const) {
    assert.equal(requestTransport({ executor_type, stream }), expected, `${String(executor_type)}/${String(stream)}`);
  }

  // The mark consumes the backend's provider-aware evidence, not the response alone.
  assert.equal(isFastTierEvent({ resolved_service_tier: 'priority' }), true);
  assert.equal(isFastTierEvent({ resolved_service_tier: 'fast' }), true);
  assert.equal(isFastTierEvent({ resolved_service_tier: ' Priority ' }), true);
  for (const tier of ['default', 'auto', 'flex', 'scale', '', undefined]) {
    assert.equal(isFastTierEvent({ resolved_service_tier: tier }), false, `${String(tier)} is not the fast lane`);
  }
  assert.equal(isFastTierEvent({ provider: 'codex', service_tier: 'priority', response_service_tier: 'default', resolved_service_tier: 'priority' } as Partial<UsageEvent>), true);
  assert.equal(isFastTierEvent({ provider: 'openai', service_tier: 'priority', response_service_tier: 'default', resolved_service_tier: 'default' } as Partial<UsageEvent>), false);
  assert.equal(fastTierHintKey({ resolved_service_tier_source: 'request' }), 'events.fast_tier_requested_hint');
  assert.equal(fastTierHintKey({ resolved_service_tier_source: 'outbound' }), 'events.fast_tier_outbound_hint');
  assert.equal(fastTierHintKey({ resolved_service_tier_source: 'response' }), 'events.fast_tier_hint');
  assert.equal(isFastTierEvent(undefined), false);



  // Request columns tests
  assert.equal(USAGE_EVENTS_COLUMNS_PREFERENCE, 'usage_events_columns');
  assert.equal(REQUEST_COLUMNS.length, 12);

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

  // buildGridTemplateColumns: the two name columns share the spare room; every figure is a rigid track
  const defaultGrid = buildGridTemplateColumns({});
  assert.ok(defaultGrid.includes('minmax(140px, 1.6fr)'));
  assert.ok(defaultGrid.includes('minmax(130px, 1.3fr)'));
  assert.equal(defaultGrid.split(' ').filter((track) => track.startsWith('minmax(')).length, 2);
  assert.ok(defaultGrid.startsWith('20px ')); // selection track
  assert.ok(defaultGrid.endsWith('14px')); // chevron track
  // An exported sheet has no checkbox to tick and no record to open, so it has neither track.
  const sheetGrid = buildGridTemplateColumns({}, SHEET_GRID_CHROME);
  assert.equal(sheetGrid.split(' ').filter((track) => track === '20px' || track === '14px').length, 0);
  assert.ok(defaultGrid.includes(sheetGrid));

  // Manual overrides lock specified tracks to exact px
  const manualGrid = buildGridTemplateColumns({ provider: 250, model: 200 });
  assert.ok(manualGrid.includes('250px'));
  assert.ok(manualGrid.includes('200px'));
  assert.ok(manualGrid.endsWith('14px'));

  // computeGridMinWidth: fixed defaults + flexible mins + the two fixed tracks + 13 gaps + inline padding
  // 96 + 88 + 140 + 130 + 84 + 76 + 78 + 132 + 64 + 64 + 124 + 76 = 1152; selection 20 + chevron 14 = 34;
  // gaps 13*16 = 208; padding 24 = 1418
  const baseMin = 1152 + 34;
  assert.equal(computeGridMinWidth({}), baseMin + 208 + 24);
  // A manual override replaces the flexible minimum with the requested width
  assert.equal(computeGridMinWidth({ provider: 300 }), baseMin - 140 + 300 + 208 + 24);
  // Out-of-range overrides are clamped exactly as the template builder clamps them
  assert.equal(computeGridMinWidth({ provider: 9999 }), baseMin - 140 + 480 + 208 + 24);
  // The sheet drops both fixed tracks and the two gaps that separated them from the data.
  assert.equal(computeGridMinWidth({}, 16, 12, SHEET_GRID_CHROME), 1152 + 176 + 24);
  assert.ok(computeGridMinWidth({}, 8, 12) < computeGridMinWidth({}, 12, 12));

  // foldRequestColumns: a list too narrow for every column leaves the least-scanned ones out, in order.
  const foldedAt = (width: number | null, widths = {}) => [...foldRequestColumns(width, widths)];
  assert.deepEqual(foldedAt(null), [], 'nothing folds before the list is measured');
  assert.deepEqual(foldedAt(1418), [], 'every column fits at the grid floor');
  assert.deepEqual(foldedAt(2400), []);
  assert.deepEqual(foldedAt(1417), ['ua'], 'one pixel short folds the first column only');
  assert.deepEqual(foldedAt(1326), ['ua']);
  assert.deepEqual(foldedAt(1325), ['ua', 'key']);
  assert.deepEqual(foldedAt(1140), ['ua', 'key', 'tps'], 'a 1440px window with the rail open keeps the cache rate and the mode');
  assert.deepEqual(foldedAt(921), ['ua', 'key', 'tps', 'cache', 'mode']);
  // A stacked record labels every field, so the card width folds nothing.
  assert.deepEqual(foldedAt(REQUEST_STACK_WIDTH), []);
  assert.deepEqual(foldedAt(400), []);
  // What stays always fits above the stacked width, so the default layout never scrolls sideways.
  const allFolded = foldRequestColumns(REQUEST_STACK_WIDTH + 1);
  assert.ok(computeGridMinWidth({}, 16, 12, undefined, allFolded) <= REQUEST_STACK_WIDTH + 1);
  for (let width = REQUEST_STACK_WIDTH + 1; width <= 1500; width += 1) {
    assert.ok(
      computeGridMinWidth({}, 16, 12, undefined, foldRequestColumns(width)) <= width,
      `the default columns fit a ${width}px list without scrolling sideways`,
    );
  }
  // A width the operator dragged out counts against the room, and folds sooner.
  assert.deepEqual(foldedAt(1418, { provider: 300 }), ['ua', 'key']);
  // The folded columns have no track, and the floor shrinks by their width and gap.
  const foldedGrid = buildGridTemplateColumns({}, undefined, new Set(['ua', 'key']));
  assert.equal(foldedGrid.split(' ').length, defaultGrid.split(' ').length - 2);
  assert.equal(computeGridMinWidth({}, 16, 12, undefined, new Set(['ua'])), baseMin + 208 + 24 - 76 - 16);



  // successRateTone: the console's one published band, read by every surface that shows a success
  // rate - the dashboard's request tile and its provider rows. Three fixed colours, so the same rate
  // cannot be green in one place and amber in another.
  assert.equal(successRateTone(null), 'neutral', 'a null rate carries no verdict');
  assert.equal(successRateTone(undefined), 'neutral', 'a missing rate carries no verdict');
  assert.equal(successRateTone(Number.NaN), 'neutral', 'an unreadable rate carries no verdict');
  assert.equal(successRateTone(Number.POSITIVE_INFINITY), 'neutral', 'an infinite rate carries no verdict');
  // The healthy boundary, and both sides of it.
  assert.equal(
    successRateTone(SUCCESS_RATE_HEALTHY_PERCENT),
    'success',
    'the healthy boundary itself is green',
  );
  assert.equal(successRateTone(SUCCESS_RATE_HEALTHY_PERCENT + 0.01), 'success', 'just above healthy');
  assert.equal(successRateTone(100), 'success', 'a clean window is green');
  assert.equal(successRateTone(99.99), 'success', 'routine upstream noise stays green');
  assert.equal(
    successRateTone(SUCCESS_RATE_HEALTHY_PERCENT - 0.01),
    'warn',
    'just below the healthy boundary is amber',
  );
  // The degraded boundary, and both sides of it.
  assert.equal(
    successRateTone(SUCCESS_RATE_DEGRADED_PERCENT),
    'warn',
    'the degraded boundary itself is amber',
  );
  assert.equal(
    successRateTone(SUCCESS_RATE_DEGRADED_PERCENT - 0.01),
    'danger',
    'just below the degraded boundary is red',
  );
  assert.equal(successRateTone(0), 'danger', 'a measured total outage is red, not neutral');
  // A measured zero is an outage; an absent rate is not a measurement at all. They must not paint
  // the same colour, which is what defaulting the rate to zero would do.
  assert.notEqual(successRateTone(0), successRateTone(null), 'an outage is not the same as no traffic');
  // The bands are ordered, so a rate can never fall through the scale.
  assert.ok(
    SUCCESS_RATE_HEALTHY_PERCENT > SUCCESS_RATE_DEGRADED_PERCENT &&
      SUCCESS_RATE_DEGRADED_PERCENT > 0,
    'the healthy band sits above the degraded band',
  );
});
