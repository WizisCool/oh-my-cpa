export interface SystemDatabaseInfo {
  status: string;
  driver: string;
  wal_mode: boolean;
}

export interface SystemCPAInfo {
  status: string;
  endpoint_masked: string;
  latency_ms: number;
}

export interface SystemCollectorInfo {
  status: string;
  mode: string;
  ingest_gaps: number;
}

export interface SystemAuditSummary {
  total_recent_events: number;
  action_counts?: Record<string, number>;
}

export interface SystemRuntimeInfo {
  go_version: string;
  os_arch: string;
  num_goroutines: number;
  alloc_mb: number;
}

export interface SystemInfoResponse {
  omc_version: string;
  cpa_version: string;
  latest_version?: string;
  update_available: boolean;
  uptime_seconds: number;
  database: SystemDatabaseInfo;
  cpa: SystemCPAInfo;
  collector: SystemCollectorInfo;
  audit_summary: SystemAuditSummary;
  runtime: SystemRuntimeInfo;
}
