/**
 * Pricing types: one editable USD price row per model plus the models.dev sync
 * bookkeeping. Prices are per 1M tokens, matching Keeper / CPA-Manager-Plus.
 */

export type PricingSource = 'manual' | 'modelsdev';

export interface ModelPrice {
  model: string;
  prompt_price_per_1m: number;
  completion_price_per_1m: number;
  cache_read_price_per_1m: number;
  cache_write_price_per_1m: number;
  price_multiplier: number;
  source: PricingSource;
  synced_at_ms: number;
  updated_at_ms: number;
}

export interface PricingSyncState {
  source: string;
  last_error: string;
  last_matched: number;
  last_unmatched: number;
  last_success_at_ms?: number | null;
  updated_at_ms: number;
  auto_sync_interval_hours?: number;
  next_sync_at_ms?: number | null;
}

export interface PricingResponse {
  source: string;
  models: ModelPrice[];
  unpriced: string[];
  sync: {
    known: boolean;
    running: boolean;
    state: PricingSyncState;
  };
}

export interface PricingUpdatePayload {
  models: Array<Partial<ModelPrice> & { model: string }>;
}
