import { ManagementQuotaObservation } from './managementAuthFile';

export interface QuotaWindow {
  id: string;
  label: string;
  scope: 'standard' | 'model' | 'group';
  model?: string;
  used?: number;
  limit?: number;
  used_percent?: number;
  remaining_percent?: number;
  reset_at_ms?: number;
  reset_label?: string;
  period_hours?: number;
  reset_accuracy?: 'exact' | 'derived' | 'approximate';
}

export interface QuotaExtraUsage {
  is_enabled: boolean;
  monthly_limit_cents: number;
  used_credits_cents: number;
  utilization_percent?: number;
}

export interface QuotaPlan {
  plan_type: string;
  plan_label: string;
  tier: 'elite' | 'premium' | 'standard' | 'free' | 'unknown';
  expires_at_ms?: number;
  expires_label?: string;
  extra_usage?: QuotaExtraUsage;
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
