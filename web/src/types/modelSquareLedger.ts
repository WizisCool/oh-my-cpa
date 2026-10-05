import type { ModelPrice, PricingResponse } from './pricing';
import type { UsageFacetsResponse } from './usageEvents';
import { EVENT_PRESETS } from './usageEventQuery';

/**
 * The one place Model Square meets the price book and the request records.
 *
 * All three surfaces name a model by the same string: the client-visible call name CPA
 * advertises, which is the price book's `model` and the request records' `model_alias`. That
 * shared key is the whole contract. It is joined here, once, so the page renders a result and a
 * change to either neighbour has one module - and one test file - to answer to.
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
  /** Requests in the recent window; `undefined` when the count is not known. */
  recentRequests?: number;
}

export interface ModelLedger {
  entryFor: (identity: string) => ModelLedgerEntry;
}

const UNKNOWN_ENTRY: ModelLedgerEntry = { price: { status: 'unknown' } };

export function buildModelLedger(identities: readonly string[], pricing?: PricingResponse, facets?: UsageFacetsResponse): ModelLedger {
  const priced = new Map((pricing?.models ?? []).map(model => [model.model, model]));
  const aliases = facets?.facets.model_aliases;
  const requests = new Map((aliases ?? []).map(facet => [facet.value, facet.requests]));
  const isRequestListComplete = aliases !== undefined && aliases.length < USAGE_FACET_VALUE_CAP;

  const entries = new Map<string, ModelLedgerEntry>();
  for (const identity of identities) {
    const price = priced.get(identity);
    const entry: ModelLedgerEntry = { price: { status: 'unknown' } };
    if (pricing) {
      // A name the book does not list has no price row, which is exactly what unpriced means.
      entry.price = price ? { status: 'priced', price } : { status: 'unpriced' };
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
