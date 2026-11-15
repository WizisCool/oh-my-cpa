import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildModelLedger, modelRequestsLink, routePricingTarget, MODEL_REQUEST_FACET_QUERY } from '../../src/types/modelSquareLedger.ts';
import { readEventQuery } from '../../src/types/usageEventQuery.ts';
import { USAGE_MULTI_FILTER_KEYS, type UsageFacetsResponse } from '../../src/types/usageEvents.ts';
import type { PricingResponse } from '../../src/types/pricing.ts';

const USAGE = { requests: 12, priced_requests: 12, cost_usd: 0.5 };
const PRICE = { model: 'gpt-5', prompt_price_per_1m: 1.25, completion_price_per_1m: 10, cache_read_price_per_1m: 0, cache_write_price_per_1m: 0, price_multiplier: 1, tiers: null, source: 'openrouter', upstream_id: 'openai/gpt-5', match_kind: 'exact', synced_at_ms: 0, updated_at_ms: 0, usage_30d: USAGE } as const;
const PRICING = { source: 'openrouter', models: [PRICE], unpriced: [{ model: 'team/fast', usage_30d: { requests: 3, priced_requests: 0, cost_usd: null }, suggestions: [] }], channels: [], upstream_count: 0, sync: { known: false, running: false, state: {} } } as unknown as PricingResponse;
const facets = (aliases: { value: string; requests: number }[]): UsageFacetsResponse => ({ window: { from: 0, to: 1, bucket_ms: 1 }, facets: { model_aliases: aliases } } as unknown as UsageFacetsResponse);
const IDENTITIES = ['gpt-5', 'team/fast', 'runtime-only'];

test('a price and a request count are joined by the advertised call name', () => {
  const ledger = buildModelLedger(IDENTITIES, PRICING, facets([{ value: 'gpt-5', requests: 40 }, { value: 'upstream/gpt-5', requests: 9 }]));
  const priced = ledger.entryFor('gpt-5');
  assert.equal(priced.price.status, 'priced');
  assert.equal(priced.price.status === 'priced' && priced.price.price.completion_price_per_1m, 10);
  assert.equal(priced.recentRequests, 40);
  assert.equal(ledger.entryFor('team/fast').price.status, 'unpriced');
  assert.equal(ledger.entryFor('team/fast').recentRequests, 0);
});
test('a name the book does not list is unpriced, and only advertised names are answered', () => {
  const ledger = buildModelLedger(IDENTITIES, PRICING, facets([]));
  assert.equal(ledger.entryFor('runtime-only').price.status, 'unpriced');
  assert.equal(ledger.entryFor('not-advertised').price.status, 'unknown');
});
test('an unread neighbour is unknown, never a missing price or a zero', () => {
  const ledger = buildModelLedger(IDENTITIES, undefined, undefined);
  for (const identity of IDENTITIES) {
    assert.equal(ledger.entryFor(identity).price.status, 'unknown');
    assert.equal(ledger.entryFor(identity).recentRequests, undefined);
  }
  assert.equal(buildModelLedger(IDENTITIES, PRICING, undefined).entryFor('gpt-5').recentRequests, undefined);
  assert.equal(buildModelLedger(IDENTITIES, undefined, facets([])).entryFor('gpt-5').recentRequests, 0);
});
test('a capped request list leaves an absent model unknown instead of zero', () => {
  const full = facets(Array.from({ length: 200 }, (_, index) => ({ value: `busy-${index}`, requests: 500 - index })));
  assert.equal(buildModelLedger(['gpt-5', 'busy-3'], PRICING, full).entryFor('gpt-5').recentRequests, undefined);
  assert.equal(buildModelLedger(['gpt-5', 'busy-3'], PRICING, full).entryFor('busy-3').recentRequests, 497);
});
test('the request link is one the request list itself accepts', () => {
  const link = modelRequestsLink('team/fast & co');
  const params = new URL(link, 'http://console.test').searchParams;
  assert.equal(new URL(link, 'http://console.test').pathname, '/usage/events');
  assert.equal(params.get('model_alias'), 'team/fast & co');
  assert.ok((USAGE_MULTI_FILTER_KEYS as readonly string[]).includes('model_alias'));
  assert.equal(readEventQuery(params).preset, '24h');
  assert.equal(readEventQuery(new URLSearchParams(MODEL_REQUEST_FACET_QUERY)).preset, '24h');
});
test('each connection of a name priced apart finds its own channel target and price', () => {
  const routes = [
    { provider_id: 'deepseek', upstream_model: 'deepseek-flash', call_point: 'deepseek-v4.1-flash' },
    { provider_id: 'opencode', upstream_model: 'deepseek-v4.1-flash', call_point: 'deepseek-v4.1-flash' },
    { provider_id: 'opencode', upstream_model: 'unlisted', call_point: 'deepseek-v4.1-flash' },
  ];
  const provider = (id: string, channel: string, models: string[]) => ({ id, family: 'openai-compatibility', name: id, channel, priority: 0, is_oauth: false, models });
  const pricing = {
    ...PRICING,
    providers: [provider('deepseek', 'ds', ['deepseek-flash']), provider('opencode', 'oc', ['deepseek-v4.1-flash'])],
    channel_models: [{ ...PRICE, model: 'deepseek-v4.1-flash', channel: 'oc', prompt_price_per_1m: 0.3 }],
  } as unknown as PricingResponse;
  const { pricingTargets } = buildModelLedger(['deepseek-v4.1-flash'], pricing, undefined, routes).entryFor('deepseek-v4.1-flash');
  assert.equal(pricingTargets.length, 2);
  const alias = routePricingTarget(routes[0], pricing, pricingTargets);
  assert.deepEqual([alias?.channel, alias?.model, alias?.price], ['ds', 'deepseek-flash', undefined]);
  const direct = routePricingTarget(routes[1], pricing, pricingTargets);
  assert.deepEqual([direct?.channel, direct?.model, direct?.price?.prompt_price_per_1m], ['oc', 'deepseek-v4.1-flash', 0.3]);
  // A route its provider does not list, or an unread price book, has no target of its own.
  assert.equal(routePricingTarget(routes[2], pricing, pricingTargets), undefined);
  assert.equal(routePricingTarget(routes[1], undefined, pricingTargets), undefined);
});
