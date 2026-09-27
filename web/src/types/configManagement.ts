export interface ConfigScalars {
  proxy_url: string;
  ws_auth: boolean;
  force_model_prefix: boolean;
  debug: boolean;
  request_log: boolean;
  logging_to_file: boolean;
  logs_max_total_size_mb: number;
  error_logs_max_files: number;
  routing_strategy: 'round-robin' | 'least-load' | string;
  request_retry: number;
  max_retry_interval: number;
  max_retry_credentials: number;
  usage_statistics_enabled: boolean;
}

/** One CPA v8 relocation: a legacy dotted path and its v8 dotted path. */
export interface ConfigLayoutRule {
  legacy: string;
  current: string;
  /** 'sequence' when the legacy spelling only counts as a list (root api-keys). */
  legacy_kind?: string;
}

export interface ConfigLayoutInfo {
  /** The gateway's Management API: 'v8' also serves v0; 'unknown' when the probe got no answer. */
  management_api: 'v8' | 'v0' | 'unknown';
  layout: 'legacy' | 'v8' | 'mixed';
  has_provider_groups: boolean;
  rules: ConfigLayoutRule[];
}

export interface ConfigScalarsResponse {
  scalars: ConfigScalars;
  supported_keys: string[];
  revision: string;
  safe_yaml?: string;
  layout?: ConfigLayoutInfo;
}

export interface ConfigSourceResponse {
  yaml: string;
  size_bytes: number;
  revision: string;
}
