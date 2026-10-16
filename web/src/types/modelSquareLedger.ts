import type { ModelPrice, PricingResponse } from './pricing';
import type { ModelSquareRoute } from './modelSquare';
import type { UsageFacetsResponse } from './usageEvents';
import { EVENT_PRESETS } from './usageEventQuery';

/**
 * The one place Model Square meets the price book and the request records.
 *
 * Requests are counted by the client-visible call name. Prices belong to the routed upstream
 * and channel. Keeping both identities here prevents a prefix or alias becoming a price key.
 *
 * The directory stays authoritative: both neighbours are optional inputs, and a read that failed
 * or has not arrived is `unknown`, never a price of nothing or a count of zero.
 */

/** The window the directory counts recent requests over; a key of the request list's presets. */
export const MODEL_REQUEST_PRESET = '24h';

/**
 * The request records return at most this many values per facet, busiest first. A full list
 * therefore says nothing about a model it leaves out, and its count stays unknown.
 */
const USAGE_FACET_VALUE_CAP = 200;

export type ModelPriceState =
  | { status: 'unknown' }
  | { status: 'unpriced' }
  | { status: 'priced'; price: ModelPrice };

export interface ModelLedgerEntry {
  price: ModelPriceState;
  pricingTargets: ModelPricingTarget[];
  /** Requests in the recent window; `undefined` when the count is not known. */
  recentRequests?: number;
}

export interface ModelLedger {
  entryFor: (identity: string) => ModelLedgerEntry;
}

export interface ModelPricingTarget {
  model: string;
  channel?: string;
  channelLabel?: string;
  price?: ModelPrice;
}

const UNKNOWN_ENTRY: ModelLedgerEntry = { price: { status: 'unknown' }, pricingTargets: [] };

export function modelPricingTargets(identity: string, pricing: PricingResponse, routes: readonly ModelSquareRoute[]): ModelPricingTarget[] {
  const targets = new Map<string, ModelPricingTarget>();
  const matching = routes.filter(route => route.call_point === identity);
  for (const route of matching) {
    const provider = pricing.providers?.find(provider => provider.id === route.provider_id);
    if (!provider?.channel || !route.upstream_model || !provider.models.includes(route.upstream_model)) continue;
    const model = route.upstream_model;
    const channel = provider.channel;
    const price = pricing.channel_models?.find(price => price.channel === channel && price.model === model)
      ?? pricing.models.find(price => price.model === model);
    targets.set(JSON.stringify([channel, model]), { model, channel, channelLabel: provider.name, price });
  }
  // A directory entry without route provenance can still edit an exact shared catalog identity.
  if (targets.size === 0 && matching.length === 0 && [...pricing.models, ...pricing.unpriced].some(row => row.model === identity)) {
    targets.set(identity, { model: identity, price: pricing.models.find(price => price.model === identity) });
  }
  return [...targets.values()];
}

export function buildModelLedger(identities: readonly string[], pricing?: PricingResponse, facets?: UsageFacetsResponse, routes: readonly ModelSquareRoute[] = []): ModelLedger {
  const priced = new Map((pricing?.models ?? []).map(model => [model.model, model]));
  const aliases = facets?.facets.model_aliases;
  const requests = new Map((aliases ?? []).map(facet => [facet.value, facet.requests]));
  const isRequestListComplete = aliases !== undefined && aliases.length < USAGE_FACET_VALUE_CAP;

  const entries = new Map<string, ModelLedgerEntry>();
  for (const identity of identities) {
    const pricingTargets = pricing ? modelPricingTargets(identity, pricing, routes) : [];
    const price = pricingTargets.length === 1 ? pricingTargets[0].price : priced.get(identity);
    const entry: ModelLedgerEntry = { price: { status: 'unknown' }, pricingTargets };
    if (pricing) {
      // A name the book does not list has no price row, which is exactly what unpriced means.
      entry.price = price ? { status: 'priced', price } : { status: 'unpriced' };
      if (pricingTargets.length > 1) entry.price = { status: 'unknown' };
    }
    entry.recentRequests = requests.get(identity) ?? (isRequestListComplete ? 0 : undefined);
    entries.set(identity, entry);
  }
  return { entryFor: identity => entries.get(identity) ?? UNKNOWN_ENTRY };
}

/** The request records narrowed to one call name over the window the directory counts. */
export function modelRequestsLink(identity: string): string {
  if (!Object.prototype.hasOwnProperty.call(EVENT_PRESETS, MODEL_REQUEST_PRESET)) throw new Error(`unknown request preset: ${MODEL_REQUEST_PRESET}`);
  const params = new URLSearchParams({ preset: MODEL_REQUEST_PRESET });
  params.set('model_alias', identity);
  return `/usage/events?${params.toString()}`;
}

/** The query the 24-hour request count is read with. */
export const MODEL_REQUEST_FACET_QUERY = new URLSearchParams({ preset: MODEL_REQUEST_PRESET }).toString();
