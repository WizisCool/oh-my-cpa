/**
 * The Trends page's wire shapes: the three read-only management reads behind `/trends`.
 *
 * Insights answers "how is this window divided"; Trends answers "where is it heading". The quota read
 * replays each OAuth window's cycle as cumulative burn with a forecast to its reset, the usage read
 * carries the window's cumulative net-token trajectory against the previous period and the groups that
 * moved most, and the telemetry read carries streaming speed, latency percentiles and the failures and
 * silent model substitutions per bucket.
 */
import type { QuotaWindowCapacity, QuotaWindowUsage } from './quota';
import type { InsightsCompareWindow, InsightsWindow } from './insights';

export type TrendsQuotaStatus = 'normal' | 'limit_reached' | 'projected_exhaust' | 'underutilized';

export interface TrendsQuotaSummary {
  active_credentials: number;
  is_membership_unknown?: boolean;
  observable_windows: number;
  healthy_windows: number;
  limit_reached_windows: number;
  projected_exhaust_windows: number;
  underutilized_windows: number;
}

export interface TrendsQuotaBucket {
  start_ms: number;
  end_ms: number;
  /** Cumulative share of the window used at the bucket's end. */
  used_percent: number;
  delta_percent: number;
  requests: number;
  net_tokens: number;
  total_tokens: number;
  /** The bucket lies after the last observation and is projected from the burn rate. */
  is_forecast: boolean;
}

export interface TrendsQuotaCycle {
  cycle_start_ms: number;
  cycle_reset_ms: number;
  is_current: boolean;
  used_percent: number;
  actual_requests: number;
  actual_net_tokens: number;
  actual_total_tokens: number;
  /** What a whole window would hold at this cycle's measured rate; absent when it cannot be scaled. */
  full_requests?: number;
  full_net_tokens?: number;
  full_total_tokens?: number;
  full_cost_nanos?: number;
  is_approximate?: boolean;
}

export interface TrendsQuotaWindow {
  window_id: string;
  label?: string;
  kind?: string;
  scope?: string;
  model?: string;
  period_hours: number | null;
  cycle_start_ms: number;
  cycle_reset_ms: number;
  used_percent: number;
  remaining_percent: number;
  status: TrendsQuotaStatus;
  exhausted_at_ms?: number;
  /** When the current burn rate would reach 100%; may fall after the reset, which is no exhaustion this cycle. */
  projected_exhaust_at_ms?: number;
  projected_end_percent?: number;
  burn_rate_per_hour?: number;
  current_requests: number;
  current_net_tokens: number;
  current_total_tokens: number;
  current_cost_nanos: number;
  is_approximate?: boolean;
  is_physical_unavailable?: boolean;
  current_usage?: QuotaWindowUsage;
  capacity?: QuotaWindowCapacity;
  capacity_unavailable?: string;
  buckets: TrendsQuotaBucket[];
  cycles: TrendsQuotaCycle[];
}

export interface TrendsQuotaCredential {
  auth_index: string;
  provider: string;
  oauth_provider?: string;
  display_name?: string;
  /** Already masked by the server. */
  account_label: string;
  status: string;
  plan_type?: string;
  plan_tier?: string;
  observed_at_ms: number;
  windows: TrendsQuotaWindow[];
}

export interface TrendsQuotaResponse {
  as_of_ms: number;
  summary: TrendsQuotaSummary;
  items: TrendsQuotaCredential[];
}

/** A group's identity as the server names it: the id the filters take, a label, and a key's alias and mask. */
export interface TrendsGroupName {
  id: string;
  label: string;
  alias?: string;
  mask?: string;
  filter_disabled?: boolean;
}

export interface TrendsUsageMeasures {
  requests: number;
  net_tokens: number;
  total_tokens: number;
  cost_nanos: number;
}

export interface TrendsUsageTotals extends TrendsUsageMeasures {
  failures: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Percent, 0–99.9 (`55.78` is 55.78%). */
  cache_rate: number | null;
  /** Percent of completion tokens spent reasoning, 0–100. */
  reasoning_share: number | null;
  priced_requests: number;
  costed_requests: number;
}

/** The previous period: its own measures, and its robust baseline scaled to the current window's progress. */
export interface TrendsUsageCompareTotals extends TrendsUsageMeasures {
  baseline_requests: number;
  baseline_net_tokens: number;
  baseline_total_tokens: number;
  baseline_cost_nanos: number;
}

export interface TrendsUsageBucket extends TrendsUsageMeasures {
  start_ms: number;
  cum_net_tokens: number;
  cum_total_tokens: number;
  cum_requests: number;
  cum_cost_nanos: number;
  compare_net_tokens?: number;
  compare_cum_net_tokens?: number;
  compare_total_tokens?: number;
  compare_cum_total_tokens?: number;
  compare_requests?: number;
  compare_cum_requests?: number;
  /** Percent, 0–99.9; absent where the bucket had no input. */
  cache_rate?: number;
  /** Percent, 0–100; absent where the bucket had no completion. */
  reasoning_share?: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
}

export interface TrendsUsageGroupBucket extends TrendsUsageMeasures {
  start_ms: number;
}

export interface TrendsUsageSeries extends TrendsGroupName, TrendsUsageMeasures {
  folded: boolean;
  buckets: TrendsUsageGroupBucket[];
}

export type TrendsMoverStatus = 'rising' | 'falling' | 'new' | 'quiet';

export interface TrendsMoverItem extends TrendsGroupName {
  net_tokens: number;
  requests: number;
  baseline_net_tokens: number;
  baseline_requests: number;
  delta_net_tokens: number;
  delta_requests: number;
  /** Percent (`363.7` is +363.7%); absent without a baseline. */
  delta_percent?: number;
  z_score: number;
  status: TrendsMoverStatus;
}

export interface TrendsMovers {
  metric: 'net_tokens' | 'requests';
  risers: TrendsMoverItem[];
  fallers: TrendsMoverItem[];
}

export interface TrendsUsageGroupOption extends TrendsGroupName {
  requests: number;
}

export interface TrendsUsageResponse {
  window: InsightsWindow;
  compare_window: InsightsCompareWindow | null;
  group_by: string;
  totals: TrendsUsageTotals;
  compare_totals?: TrendsUsageCompareTotals;
  buckets: TrendsUsageBucket[];
  groups?: TrendsUsageGroupOption[];
  series: TrendsUsageSeries[];
  movers: TrendsMovers;
  coverage: { fact_requests: number; detail_requests: number };
}

export interface TrendsTelemetrySummary {
  total_requests: number;
  success_requests: number;
  failed_requests: number;
  rate_limited_429: number;
  upstream_5xx: number;
  stream_truncated: number;
  force_cooldown: number;
  other_failures: number;
  model_substituted: number;
  tps_mean: number | null;
  tps_p50: number | null;
  tps_samples: number;
  ttft_p50_ms: number | null;
  ttft_p95_ms: number | null;
  ttft_samples: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_samples: number;
}

export interface TrendsTelemetryBucket extends TrendsTelemetrySummary {
  start_ms: number;
}

export interface TrendsTelemetrySeries extends TrendsGroupName, TrendsTelemetrySummary {
  buckets: TrendsTelemetryBucket[];
}

export interface TrendsScatterPoint {
  timestamp_ms: number;
  group_id: string;
  model: string;
  provider: string;
  ttft_ms: number | null;
  latency_ms: number | null;
  tps: number | null;
  output_tokens: number;
  failed: boolean;
  model_substituted: boolean;
}

export interface TrendsSubstitutionPair {
  requested_model: string;
  served_model: string;
  provider: string;
  requested_id?: string;
  served_id?: string;
  provider_id?: string;
  drill_disabled?: boolean;
  count: number;
}

export interface TrendsTelemetryResponse {
  window: InsightsWindow;
  tps_mode: 'exclude_ttft' | 'include_ttft';
  group_by: string;
  summary: TrendsTelemetrySummary;
  buckets: TrendsTelemetryBucket[];
  groups?: TrendsGroupName[];
  series: TrendsTelemetrySeries[];
  scatter: TrendsScatterPoint[];
  substitution_pairs: TrendsSubstitutionPair[];
  coverage: {
    fact_requests: number;
    retained_requests: number;
    retention_start_ms?: number;
    is_truncated_by_retention: boolean;
  };
}
