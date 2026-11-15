import type {
  ModelPrice,
  PricedModel,
  PricingCandidate,
  PricingMode,
  PricingProvider,
  PricingResponse,
  PricingUsage,
  UpstreamModel,
} from './pricing';
import { matchesModelSearch, modeOf } from './pricingDisplay';

/**
 * The price book as the page lists it: one row per model, whatever number of providers serve it.
 * Prices are per model, and a channel's own price is an exception to it, so the exceptions ride on
 * the row as a count instead of repeating the model once per provider.
 */

const MODEL_NAME_ORDER = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const MODEL_CASE_ORDER = new Intl.Collator('en', { numeric: true, sensitivity: 'variant', caseFirst: 'upper' });

export function compareModelNames(left: string, right: string): number {
  return MODEL_NAME_ORDER.compare(left, right) || MODEL_CASE_ORDER.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}

export function comparePricingProviders(left: PricingProvider, right: PricingProvider): number {
  return right.priority - left.priority || compareModelNames(left.name, right.name) || compareModelNames(left.id, right.id);
}

/** A row's price state: one of the pricing modes, or no price yet. */
export type BookMode = PricingMode | 'unpriced';

/**
 * `unpriced` is the models with no price yet; `unbilled` is the models whose recent requests went
 * unpriced, the ones an operator can price after the fact.
 */
export type BookFilter = 'all' | 'unpriced' | 'unbilled' | PricingMode;

export const BOOK_FILTERS: readonly BookFilter[] = ['all', 'unpriced', 'unbilled', 'custom', 'linked', 'auto'];

/** What the row offers to settle in one click: a suggested link for an unpriced model, or a new match. */
export type BookAttention =
  | { kind: 'suggestion'; upstream: UpstreamModel }
  | { kind: 'candidate'; candidate: PricingCandidate };

export interface BookRow {
  model: string;
  mode: BookMode;
  /** The shared price; null while the model has none. */
  price: PricedModel | null;
  usage: PricingUsage;
  suggestions: UpstreamModel[];
  attention: BookAttention | null;
  /** Channels whose providers serve the model, highest provider priority first. */
  channels: string[];
  /** The channels that bill the model at their own price instead of the shared one. */
  channelPrices: ModelPrice[];
}

/** Whether some of the row's requests in the book's window found no price. */
export function hasUnbilledRequests(row: BookRow): boolean {
  return row.usage.requests > row.usage.priced_requests;
}

/** Channels in provider priority order; several providers can share one channel. */
function servingChannels(providers: readonly PricingProvider[]): Map<string, string[]> {
  const byModel = new Map<string, string[]>();
  for (const provider of [...providers].sort(comparePricingProviders)) {
    if (!provider.channel) continue;
    for (const model of provider.models) {
      const channels = byModel.get(model) ?? [];
      if (!channels.includes(provider.channel)) channels.push(provider.channel);
      byModel.set(model, channels);
    }
  }
  return byModel;
}

export function buildPriceBook(response: PricingResponse): BookRow[] {
  const served = servingChannels(response.providers ?? []);
  const overrides = new Map<string, ModelPrice[]>();
  for (const price of response.channel_models ?? []) {
    overrides.set(price.model, [...(overrides.get(price.model) ?? []), price]);
  }
  const priced = response.models.map((price): BookRow => ({
    model: price.model,
    mode: modeOf(price),
    price,
    usage: price.usage_30d,
    suggestions: [],
    attention: price.candidate ? { kind: 'candidate', candidate: price.candidate } : null,
    channels: served.get(price.model) ?? [],
    channelPrices: overrides.get(price.model) ?? [],
  }));
  const unpriced = response.unpriced.map((item): BookRow => ({
    model: item.model,
    mode: 'unpriced',
    price: null,
    usage: item.usage_30d,
    suggestions: item.suggestions,
    attention: item.suggestions[0] ? { kind: 'suggestion', upstream: item.suggestions[0] } : null,
    channels: served.get(item.model) ?? [],
    channelPrices: overrides.get(item.model) ?? [],
  }));
  return [...priced, ...unpriced].sort((left, right) => compareModelNames(left.model, right.model));
}

export type BookCounts = Record<BookFilter, number>;

export function priceBookCounts(rows: readonly BookRow[]): BookCounts {
  const counts: BookCounts = { all: rows.length, unbilled: 0, auto: 0, linked: 0, custom: 0, unpriced: 0 };
  for (const row of rows) {
    counts[row.mode] += 1;
    if (hasUnbilledRequests(row)) counts.unbilled += 1;
  }
  return counts;
}

export interface BookQuery {
  filter: BookFilter;
  /** A channel the model must be served by; empty for every model. */
  channel: string;
  search: string;
}

export function filterPriceBook(rows: readonly BookRow[], { filter, channel, search }: BookQuery): BookRow[] {
  const query = search.trim();
  return rows.filter((row) => {
    if (filter === 'unbilled' ? !hasUnbilledRequests(row) : filter !== 'all' && row.mode !== filter) return false;
    if (channel && !row.channels.includes(channel) && !row.channelPrices.some((price) => price.channel === channel)) return false;
    return !query || matchesModelSearch(query, row.model, row.price?.upstream_id ?? '');
  });
}

/** One place a model's price can be set: the shared price (`channel` empty), or one channel's own. */
export interface PriceScope {
  channel: string;
  hasOwnPrice: boolean;
}

/**
 * The scopes the editor offers for a model: the shared price, then each channel serving it. A
 * channel that still holds an own price stays listed after it stops serving the model, so the
 * price can be found and removed.
 */
export function modelScopes(response: PricingResponse | undefined, model: string): PriceScope[] {
  const own = new Set((response?.channel_models ?? []).filter((price) => price.model === model).map((price) => price.channel ?? ''));
  const serving = servingChannels(response?.providers ?? []).get(model) ?? [];
  const channels = [...serving, ...[...own].filter((channel) => channel && !serving.includes(channel)).sort(compareModelNames)];
  return [{ channel: '', hasOwnPrice: false }, ...channels.map((channel) => ({ channel, hasOwnPrice: own.has(channel) }))];
}

/** A channel multiplier as a change from list price, in whole percent; null at list price. */
export function multiplierDelta(multiplier: number): number | null {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
  const percent = Math.round((multiplier - 1) * 100);
  return percent === 0 ? null : percent;
}
