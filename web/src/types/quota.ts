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
  has_mid_cycle_reset?: boolean;
  has_incomplete_history?: boolean;
  used?: number;
  limit?: number;
  used_percent?: number;
  remaining_percent?: number;
  reset_at_ms?: number;
  reset_label?: string;
  period_hours?: number;
  reset_accuracy?: 'exact' | 'derived' | 'approximate';
  /** What this deployment recorded for the credential in the window's current cycle, up to the observation. */
  usage?: QuotaWindowUsage;
  /** The estimated size of the whole window; absent when `capacity_unavailable` says why. */
  capacity?: QuotaWindowCapacity;
  capacity_unavailable?: QuotaCapacityUnavailableReason;
}

export interface QuotaWindowUsage {
  from_ms: number;
  to_ms: number;
  requests: number;
  priced_requests: number;
  tokens: number;
  cost_nanos: number;
}

export interface QuotaWindowCapacity {
  basis?: 'current_cycle' | 'previous_cycle';
  observed_at_ms?: number;
  from_ms?: number;
  reset_at_ms?: number;
  tokens: number;
  /** Absent when too much of the cycle's usage carries no price. */
  cost_nanos?: number;
  /** Relative uncertainty, in percent, from upstream reporting the used share in whole points. */
  error_percent: number;
}

export type QuotaCapacityUnavailableReason =
  | 'boundary_unknown'
  | 'expired'
  | 'stale'
  | 'no_reading'
  | 'low_usage'
  | 'no_traffic'
  | 'reset_mid_cycle'
  | 'scope_unknown'
  | 'history_unavailable'
  | 'usage_unavailable';

export interface QuotaExtraUsage {
  is_enabled: boolean;
  monthly_limit_cents: number;
  used_credits_cents: number;
  utilization_percent?: number;
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

export interface ActiveCooldown {
  is_active: boolean;
  reason?: string;
  recover_at_ms?: number;
  retry_after_seconds?: number;
  correlated_at_ms?: number;
}

export interface QuotaRecommendation {
  status: 'healthy' | 'warning' | 'exhausted' | 'cooldown' | 'needs_reauth' | 'credits_available' | 'idle';
  priority: 'critical' | 'high' | 'medium' | 'low' | 'none';
  action: 'refresh' | 'clear_cooldown' | 'redeem_credit' | 'reauth' | 'none';
  reason: string;
}

export interface QuotaCapabilities {
  refresh_supported: boolean;
  clear_cooldown_supported: boolean;
  reset_credit_supported: boolean;
}

export interface QuotaItem {
  auth_index: string;
  name: string;
  type: string;
  provider: string;
  disabled: boolean;
  status: 'idle' | 'loading' | 'healthy' | 'warning' | 'exhausted' | 'cooldown' | 'error' | 'stale';
  observed_at_ms: number;
  plan?: QuotaPlan;
  windows: QuotaWindow[];
  reset_credits?: CodexResetCreditsInfo;
  active_cooldown?: ActiveCooldown;
  recommendation: QuotaRecommendation;
  capabilities: QuotaCapabilities;
  raw_signals?: Record<string, string>;
  error?: string;

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
}
