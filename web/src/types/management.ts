export interface ManagementOverviewCounts {
  management_keys: number | null;
  provider_keys: number | null;
  credentials: number | null;
  models: number | null;
}

export interface ManagementOverviewBucket {
  time?: string;
  success: number;
  failed: number;
}

export interface ManagementOverviewTraffic {
  bucket_minutes: number;
  window_minutes: number;
  buckets: ManagementOverviewBucket[];
  total_success: number;
  total_failure: number;
  total: number;
  success_rate: number | null;
}

export interface ManagementOverviewProvider {
  id: string;
  credentials: number;
  success: number;
  failure: number;
  total: number;
  success_rate: number | null;
  buckets: ManagementOverviewBucket[];
}

export interface ManagementOverviewTypeCount {
  type: string;
  count: number;
  /** How many of `count` the gateway reports disabled. */
  disabled: number;
}

export interface ManagementOverviewCredentials {
  total: number;
  active: number;
  disabled: number;
  unavailable: number;
  by_type: ManagementOverviewTypeCount[];
}

export interface ManagementOverview {
  status: 'unconfigured' | 'disconnected' | 'degraded' | 'connected' | string;
  cpa_connected: boolean;
  cpa_base_url?: string;
  cpa_instance_id?: string;
  cpa_instance_name?: string;
  omc_version?: string;
  cpa_version?: string;
  cpa_build_date?: string;
  counts: ManagementOverviewCounts;
  traffic: ManagementOverviewTraffic | null;
  providers: ManagementOverviewProvider[];
  credentials: ManagementOverviewCredentials | null;
  partial_errors: string[];
}
