/**
 * The pricing reads' cache keys, shared so a save anywhere refreshes every surface that shows a
 * price: the book, the navigation's attention mark, and the editor's own read.
 */
export const PRICING_QUERY_KEYS = {
  book: ['pricing'] as const,
  attention: ['pricing-attention'] as const,
  catalog: ['pricing-catalog'] as const,
  model: (model: string) => ['pricing-model', model] as const,
};
