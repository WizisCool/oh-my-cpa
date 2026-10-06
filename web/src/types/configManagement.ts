export interface ConfigScalars {
  proxy_url: string;
  ws_auth: boolean;
  force_model_prefix: boolean;
  debug: boolean;
  request_log: boolean;
  logging_to_file: boolean;
  logs_max_total_size_mb: number;
  error_logs_max_files: number;
  routing_strategy: 'round-robin' | 'weighted-round-robin' | 'fill-first' | string;
  request_retry: number;
  max_retry_interval: number;
  max_retry_credentials: number;
  usage_statistics_enabled: boolean;
}

/**
 * Whether the gateway's stored file is still in the pre-v8 layout. The editor
 * always reads and writes the v8 layout; a legacy file is converted by CPA on
 * the first save, after Oh My CPA keeps an encrypted copy of it.
 */
export type StoredConfigLayout = 'v8' | 'legacy' | 'unknown';

export interface ConfigScalarsResponse {
  scalars: ConfigScalars;
  supported_keys: string[];
  revision: string;
  safe_yaml?: string;
  stored_layout?: StoredConfigLayout;
}

export interface ConfigSourceResponse {
  yaml: string;
  size_bytes: number;
  revision: string;
}

/**
 * One edited setting, addressed by its v8 path. `remove` deletes the setting so
 * CPA falls back to its default; otherwise `value` replaces it.
 */
export interface ConfigChange {
  path: string[];
  value?: unknown;
  remove?: boolean;
}

/** The answer to a save: the new baseline, absent when CPA could not be re-read. */
export interface ConfigPatchResponse {
  status: string;
  revision?: string;
  safe_yaml?: string;
}

export interface ConfigSourceSaveResponse {
  status: string;
  revision?: string;
  yaml?: string;
  size_bytes?: number;
}

/** The kind of write a configuration backup was kept before. */
export type ConfigBackupReason =
  | 'config_changes'
  | 'config_source'
  | 'provider_keys'
  | 'client_keys'
  | 'oauth_aliases'
  | 'oauth_excluded_models'
  | 'plugin_settings'
  | 'plugin_install'
  | 'plugin_delete'
  | 'credential_status'
  | 'restore'
  | 'manual'
  | 'legacy_conversion';

/**
 * The stored configuration file as it was before one write. Only a `v8` copy
 * can be restored in place; a `legacy` one is the pre-v8 file, kept for download.
 */
export interface ConfigBackup {
  id: number;
  created_at_ms: number;
  revision: string;
  size_bytes: number;
  layout: 'v8' | 'legacy';
  reason: ConfigBackupReason | string;
}

export interface ConfigBackupSettings {
  retention: number;
  retention_min: number;
  retention_max: number;
  legacy_retention: number;
}

export interface ConfigBackupList {
  backups: ConfigBackup[];
  settings: ConfigBackupSettings;
}
