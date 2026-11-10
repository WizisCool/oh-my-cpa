import { api } from '../../api/client';
import { defineSwrQuery } from '../../performance/swrContract';

/**
 * The pricing reads' cache keys, shared so a save anywhere refreshes every surface that shows a
 * price: the book, the navigation's attention mark, and the editor's own read.
 */
export const PRICING_QUERY_KEYS = {
  book: ['pricing'] as const,
  attention: ['pricing-attention'] as const,
  catalog: ['pricing-catalog'] as const,
  model: (model: string, channel?: string) => channel ? ['pricing-model', model, channel] as const : ['pricing-model', model] as const,
};

export const pricingBookSwr = defineSwrQuery({
  scope: 'pricing',
  tags: ['pricing'],
  staleTime: 60_000,
  key: (_params: void) => PRICING_QUERY_KEYS.book,
  fetcher: () => api.getPricing(),
});

export const pricingAttentionSwr = defineSwrQuery({
  scope: 'pricing-attention',
  tags: ['pricing'],
  staleTime: 60_000,
  key: (_params: void) => PRICING_QUERY_KEYS.attention,
  fetcher: () => api.getPricingAttention(),
});
