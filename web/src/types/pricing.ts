/**
 * Pricing types: the price book the server keeps per CPA model, priced from
 * OpenRouter by default, plus the per-channel multipliers. Rates are USD per 1M
 * tokens; the server locks each request's cost at its own timestamp, so nothing
 * here ever reprices recorded traffic.
 */

/** Who last wrote a price. `modelsdev` survives only on rows written before OpenRouter became the source. */
export type PricingSource = 'manual' | 'openrouter' | 'modelsdev';

/** How a model is priced: matched automatically, pinned to one OpenRouter model, or set by hand. */
export type PricingMode = 'auto' | 'linked' | 'custom';

export type PricingMatchKind = '' | 'exact' | 'canonical' | 'normalized' | 'date_stripped' | 'alias' | 'linked';

/**
 * One conditional rate override. It applies when every condition it carries holds: a prompt of at
 * least `min_prompt_tokens` (cached tokens included) and/or a request stamped inside the UTC window
 * `[utc_start, utc_end)` in HHMM, which wraps past midnight when the end is not after the start.
 * A rate left out inherits the base price.
 */
export interface PriceTier {
  min_prompt_tokens?: number;
  utc_start?: number;
  utc_end?: number;
  prompt_price_per_1m?: number;
  completion_price_per_1m?: number;
  cache_read_price_per_1m?: number;
  cache_write_price_per_1m?: number;
}

export interface ModelPrice {
  model: string;
  prompt_price_per_1m: number;
  completion_price_per_1m: number;
  cache_read_price_per_1m: number;
  cache_write_price_per_1m: number;
  price_multiplier: number;
  tiers: PriceTier[] | null;
  source: PricingSource;
  upstream_id: string;
  match_kind: PricingMatchKind;
  mode?: PricingMode;
  synced_at_ms: number;
  updated_at_ms: number;
}

/** Recorded traffic over the book's window. `cost_usd` is absent — not zero — when nothing was priced. */
export interface PricingUsage {
  requests: number;
  priced_requests: number;
  cost_usd?: number | null;
}

/** One OpenRouter model as the server stored it; rates already resolved to per 1M tokens. */
export interface UpstreamModel {
  id: string;
  canonical_slug: string;
  name: string;
  author: string;
  context_length: number;
  prompt_price_per_1m: number;
  completion_price_per_1m: number;
  cache_read_price_per_1m: number;
  cache_write_price_per_1m: number;
  tiers: PriceTier[] | null;
}

export interface PricedModel extends ModelPrice {
  usage_30d: PricingUsage;
}

export interface UnpricedModel {
  model: string;
  usage_30d: PricingUsage;
  suggestions: UpstreamModel[];
}

export interface PricingChannel {
  channel: string;
  multiplier: number;
  note: string;
  updated_at_ms: number;
  /** False for a channel seen in traffic that has no multiplier yet (it is 1×). */
  is_configured: boolean;
  usage_30d: PricingUsage;
}

export interface PricingSyncState {
  source: string;
  last_error: string;
  last_matched: number;
  last_unmatched: number;
  last_success_at_ms?: number | null;
  updated_at_ms: number;
  auto_sync_interval_hours?: number;
  catalog_updated_at_ms?: number;
  next_sync_at_ms?: number | null;
}

export interface PricingProvider {
  endpoint_host?: string;
  id: string;
  family: string;
  name: string;
  channel: string;
  priority: number;
  is_oauth: boolean;
  models: string[];
  icon_id?: string;
}

export interface PricingResponse {
  providers?: PricingProvider[];
  source: string;
  models: PricedModel[];
  unpriced: UnpricedModel[];
  channels: PricingChannel[];
  upstream_count: number;
  sync: {
    known: boolean;
    running: boolean;
    state: PricingSyncState;
  };
  partial?: string[];
}

export interface PricingAttention {
  unpriced: string[];
}

/** The price a version locked; a version carries no row bookkeeping. */
export type VersionPrice = Omit<ModelPrice, 'synced_at_ms' | 'updated_at_ms' | 'match_kind' | 'mode'>;

/** One immutable price snapshot; `available` false is the tombstone a removal writes. */
export interface PriceVersion {
  id: number;
  available: boolean;
  effective_from_ms: number;
  price: VersionPrice;
}

/** The median of a model's recent successful requests, for the editor's cost preview. */
export interface TokenProfile {
  samples: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  max_input: number;
}

export interface PricingModelDetail {
  model: string;
  price: ModelPrice | null;
  /** What auto mode would price the model at; null when nothing matches automatically. */
  automatic: { model: UpstreamModel; match_kind: PricingMatchKind } | null;
  suggestions: UpstreamModel[];
  versions: PriceVersion[];
  profile: TokenProfile;
}

export interface PricingModelUpdate {
  mode: PricingMode;
  upstream_id?: string;
  prompt_price_per_1m?: number;
  completion_price_per_1m?: number;
  cache_read_price_per_1m?: number;
  cache_write_price_per_1m?: number;
  price_multiplier?: number;
  tiers?: PriceTier[];
}

export type BreakdownBucketKind = 'prompt' | 'completion' | 'cache_read' | 'cache_write';

export interface BreakdownBucket {
  kind: BreakdownBucketKind;
  tokens: number;
  rate_per_1m: number;
  nanos: number;
}

/** The request lock's own computation, re-run from the versions it locked. */
export interface CostQuote {
  tier_index?: number;
  tier?: PriceTier;
  buckets: BreakdownBucket[];
  model_multiplier: number;
  channel_multiplier: number;
  total_nanos: number;
}

export interface ChannelVersion {
  id: number;
  channel: string;
  available: boolean;
  effective_from_ms: number;
  multiplier: number;
}

/**
 * Why a stored request cost what it did. The stored amount is authoritative; `recomputed_matches`
 * says whether re-running the lock from its versions agrees with it.
 */
export interface RequestCostBreakdown {
  status: 'priced' | 'unpriced' | 'legacy_unpriced' | 'invalid_price';
  stored_nanos?: number;
  stored_tier?: number;
  price_version?: PriceVersion;
  channel?: ChannelVersion;
  quote?: CostQuote;
  recomputed_matches: boolean;
  invalid_reason?: string;
}
