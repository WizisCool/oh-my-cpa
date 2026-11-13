import { ManagementQuotaObservation } from './managementAuthFile';

export interface QuotaWindow {
  id: string;
  label: string;
  kind?: 'five_hour' | 'weekly' | 'daily' | 'monthly' | 'credit_usage' | 'model_scoped' | 'custom';
  /**
   * Which set of limits a window belongs to. `standard` is the credential's plan, `model` and
   * `group` are the per-model and per-family limits the provider publishes beside it, and
   * `code_review` is a separate allowance the provider meters outside the plan's windows.
   */
  scope: 'standard' | 'model' | 'group' | 'code_review';
  model?: string;
  model_families?: string[];
  used?: number;
  limit?: number;
  used_percent?: number;
  remaining_percent?: number;
  reset_at_ms?: number;
  reset_label?: string;
  period_hours?: number;
  reset_accuracy?: 'exact' | 'derived' | 'approximate';
  /** The provider's own words for the window's standing ("183 / 2,000 credits left"); a plugin's only amounts. */
  description?: string;
  /** What this deployment recorded for the credential in the window's current cycle, up to the observation. */
  usage?: QuotaWindowUsage;
  /** Remaining work conditioned on directly observed model and workload samples. */
  model_forecasts?: QuotaModelForecast[];
  forecast_unavailable?: QuotaForecastUnavailableReason;
}

export interface QuotaWindowUsage {
  from_ms: number;
  to_ms: number;
  requests: number;
  priced_requests: number;
  tokens: number;
  prompt_tokens?: number;
  cached_tokens?: number;
  cache_rate?: number;
  cost_nanos: number;
}

export interface QuotaModelForecast {
  model: string;
  service_tier?: string;
  sample_requests: number;
  sample_tokens: number;
  sample_used_percent: number;
  cache_rate?: number;
  from_ms: number;
  observed_at_ms: number;
  remaining_requests: number;
  remaining_tokens: number;
  /** Meter rounding only; not a confidence bound on future workloads. */
  rounding_error_percent: number;
}

/** One cycle of a window as the capacity details state it. */
export interface QuotaCapacityCycle {
  from_ms: number;
  reset_at_ms: number;
  /** The cycle's latest used share; for an earlier cycle, its last reading. */
  used_percent?: number;
  /** What this gateway recorded in the cycle. */
  usage?: QuotaWindowUsage;
}

/** `GET /management/quota/{authIndex}/capacity?window=`: the cycle being read, the one before it, and model-conditioned remaining-work forecasts. */
export interface QuotaCapacityHistory {
  window_id: string;
  current: QuotaCapacityCycle | null;
  previous: QuotaCapacityCycle | null;
  model_forecasts?: QuotaModelForecast[];
  forecast_unavailable?: QuotaForecastUnavailableReason;
}

export type QuotaForecastUnavailableReason =
  | 'boundary_unknown'
  | 'expired'
  | 'no_reading'
  | 'low_usage'
  | 'mixed_models'
  | 'no_traffic'
  | 'reset_mid_cycle'
  | 'scope_unknown'
  | 'history_unavailable'
  | 'usage_unavailable';

/** Paid usage beyond the plan; reported when it is off too. Amounts are in minor units. */
export interface QuotaExtraUsage {
  is_enabled: boolean;
  monthly_limit_cents: number;
  used_credits_cents: number;
  utilization_percent?: number;
  /** ISO 4217 code; absent means USD. */
  currency?: string;
  disabled_reason?: string;
  user_disabled?: boolean;
  spend_limit_reached?: boolean;
}

/** A dollar allowance beside the plan's windows; spending it does not exhaust the plan. */
export interface QuotaBalance {
  /** Upstream key; known ones have a localized name. */
  id: string;
  limit_usd?: number;
  used_usd?: number;
  remaining_usd?: number;
  utilization_percent?: number;
  reset_at_ms?: number;
}

/** One product's share of a usage total the provider meters as a whole. */
export interface QuotaUsageShare {
  name: string;
  share_percent?: number;
}

/** One figure of a plugin's quota summary; `format` says how `value` reads. */
export interface QuotaMetric {
  key: string;
  label: string;
  value: number;
  unit?: string;
  format?: string;
  currency?: string;
}

export interface QuotaPlan {
  /** Whether the provider reports an active subscription; absent when unknown. */
  subscription_active?: boolean;
  plan_type: string;
  plan_label: string;
  tier: 'elite' | 'premium' | 'standard' | 'free' | 'unknown';
  expires_at_ms?: number;
  expires_label?: string;
  /** Where the expiry came from; absent on snapshots written before provenance was tracked. */
  expires_source?: 'live_subscription' | 'credential_snapshot';
  /** Whether upstream says the plan renews; absent when the source does not expose it. */
  auto_renews?: boolean;
  extra_usage?: QuotaExtraUsage;
  /** Prepaid credit standing; absent when the provider reports none. */
  credits?: QuotaCredits;
  balances?: QuotaBalance[];
  usage_breakdown?: QuotaUsageShare[];
  /** A plugin's quota summary, in the order it lists the figures. */
  metrics?: QuotaMetric[];
}

export interface QuotaCredits {
  /** Upstream's decimal text; absent when credits are unlimited. */
  balance?: string;
  unlimited?: boolean;
}

export interface CodexResetCredit {
  id: string;
  status: string;
  granted_at_ms?: number;
  expires_at_ms?: number;
}

export interface CodexResetCreditsInfo {
  available_count: number;
  applicable_available_count: number;
  credits?: CodexResetCredit[];
  error?: string;
}

// One Anthropic rate-limit reset grant, display-only. OMC lists grants beside
// the Claude quota; claiming one spends an entitlement and is not implemented.
export interface ClaudeResetGrant {
  id: string;
  label?: string;
  resets_total: number;
  resets_left: number;
  ends_at_ms?: number;
  clears?: string[];
}

export interface ActiveCooldown {
  is_active: boolean;
  reason?: string;
  recover_at_ms?: number;
  retry_after_seconds?: number;
  correlated_at_ms?: number;
  retry_at_ms?: number;
  backoff_level?: number;
  model?: string;
}

export interface QuotaRecommendation {
  status: 'healthy' | 'warning' | 'exhausted' | 'cooldown' | 'needs_reauth' | 'credits_available' | 'idle' | 'unpublished';
  priority: 'critical' | 'high' | 'medium' | 'low' | 'none';
  action: 'refresh' | 'clear_cooldown' | 'redeem_credit' | 'reauth' | 'none';
  reason: string;
}

export interface QuotaCapabilities {
  refresh_supported: boolean;
  clear_cooldown_supported: boolean;
  reset_credit_supported: boolean;
}

/**
 * The last attempt to read a credential's quota, kept apart from the reading itself.
 *
 * A failed read never becomes an observation, so this is the only thing that can tell a page
 * "refreshed three minutes ago and it failed" while the numbers on screen are older than that.
 */
export interface QuotaRefreshAttempt {
  attempted_at_ms: number;
  outcome: 'succeeded' | 'failed';
  error?: string;
}

export interface QuotaItem {
  auth_index: string;
  name: string;
  type: string;
  provider: string;
  disabled: boolean;
  status: 'idle' | 'loading' | 'healthy' | 'warning' | 'exhausted' | 'cooldown' | 'error' | 'stale' | 'unpublished';
  observed_at_ms: number;
  plan?: QuotaPlan;
  windows: QuotaWindow[];
  reset_credits?: CodexResetCreditsInfo;
  reset_grants?: ClaudeResetGrant[];
  active_cooldown?: ActiveCooldown;
  model_cooldowns?: ActiveCooldown[];
  recommendation: QuotaRecommendation;
  capabilities: QuotaCapabilities;
  raw_signals?: Record<string, string>;
  error?: string;
  /** Absent until something has tried to read this credential; see QuotaRefreshAttempt. */
  last_refresh?: QuotaRefreshAttempt;

  // Backwards compatibility fields
  quota?: ManagementQuotaObservation;
  model_quotas?: Record<string, ManagementQuotaObservation>;
  quota_exceeded: boolean;
  quota_reason?: string;
  next_recover_at_ms?: number;
  next_retry_after_ms?: number;
}

export interface QuotaSnapshotHistoryItem {
  id: string;
  auth_index: string;
  provider: string;
  status: string;
  plan_type: string;
  plan_tier: string;
  windows_json: string;
  reset_credits_json?: string;
  observed_at_ms: number;
  created_at_ms: number;
}

export interface QuotaOverviewSummary {
  total_credentials: number;
  healthy_count: number;
  warning_count: number;
  exhausted_count: number;
  cooldown_count: number;
  attention_count: number;
  soonest_recovery_ms?: number;
}

export interface QuotaOverviewResponse {
  summary: QuotaOverviewSummary;
  quotas: QuotaItem[];
  total: number;
}

export interface CredentialQuotaDetailResponse {
  quota: QuotaItem;
  history: QuotaSnapshotHistoryItem[];
  model_quotas?: Record<string, ManagementQuotaObservation>;
  last_refresh?: QuotaRefreshAttempt;
}
