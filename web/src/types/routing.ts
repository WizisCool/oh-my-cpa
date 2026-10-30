/** Wire shapes of `/management/routing`: CPA's priority tiers, weights and routing settings. */

export type RoutingStrategy = 'round-robin' | 'weighted-round-robin' | 'fill-first';

export interface RoutingSettings {
  strategy: RoutingStrategy;
  session_affinity: boolean;
  session_affinity_ttl: string;
  request_retry: number;
  max_retry_credentials: number;
  max_retry_interval: number;
  disable_cooling: boolean;
  transient_error_cooldown_seconds: number;
  /** Read for model eligibility; the board does not edit it. */
  force_model_prefix: boolean;
}

/** The settings a routing plan may change. */
export type RoutingSettingKey = Exclude<keyof RoutingSettings, 'force_model_prefix'>;

export interface RoutingWeight {
  index: number;
  auth_index?: string;
  /** Absent weight: CPA runs the key as 1. */
  weight: number | null;
}

export type RoutingMemberKind = 'provider' | 'credential';

export interface RoutingMember {
  key: string;
  kind: RoutingMemberKind;
  id: string;
  family: string;
  name: string;
  prefix?: string;
  priority: number;
  weights: RoutingWeight[];
  key_count: number;
  is_disabled: boolean;
  is_unavailable: boolean;
  is_runtime_only: boolean;
}

export interface RoutingBoard {
  revision: string;
  settings: RoutingSettings;
  members: RoutingMember[];
  partial: string[];
}

export interface RoutingMemberEdit {
  key: string;
  priority?: number;
  weights?: { index: number; weight: number | null }[];
}

export interface RoutingPlanRequest {
  revision: string;
  settings?: Partial<Record<RoutingSettingKey, RoutingSettings[RoutingSettingKey]>>;
  members?: RoutingMemberEdit[];
}

export type RoutingResultStatus = 'applied' | 'failed' | 'uncertain' | 'not_attempted';

export interface RoutingOutcome {
  is_complete: boolean;
  results: { key: string; status: RoutingResultStatus; code?: string }[];
  board?: RoutingBoard;
}

export interface RoutingModels {
  /** Known callable names by member key; a missing member is unknown, not ineligible. */
  models: Record<string, string[]>;
  /** Members whose models could not be read: neither eligible nor ineligible. */
  unknown: string[];
}
