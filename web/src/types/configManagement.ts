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

export interface ConfigScalarsResponse {
  scalars: ConfigScalars;
  supported_keys: string[];
  revision: string;
  safe_yaml?: string;
}

export interface ConfigSourceResponse {
  yaml: string;
  size_bytes: number;
  revision: string;
}
