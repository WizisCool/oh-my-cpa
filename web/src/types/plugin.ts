/** A setting a plugin declares in its manifest; the value lives in the plugin's settings document. */
export interface PluginConfigField {
  name: string;
  /** `string`, `number`, `integer`, `boolean`, `enum`, `array` or `object`; anything else is edited as text. */
  type: string;
  enum_values?: string[];
  description?: string;
}

export interface PluginMetadata {
  name?: string;
  version?: string;
  author?: string;
  /** Inline artwork only: the server fetches and inlines a declared logo, or drops it. */
  logo?: string;
}

export interface PluginItem {
  id: string;
  path?: string;
  configured: boolean;
  registered: boolean;
  enabled: boolean;
  /** Enabled here, registered with the running host, and the plugin system switched on. */
  effective_enabled: boolean;
  supports_oauth?: boolean;
  oauth_provider?: string;
  supports_quota?: boolean;
  logo?: string;
  repository_url?: string;
  config_fields: PluginConfigField[];
  metadata?: PluginMetadata;
}

export interface PluginsResponse {
  plugins_enabled: boolean;
  plugins_dir: string;
  plugins: PluginItem[];
  total: number;
}

export interface PluginConfigResponse {
  id: string;
  config: Record<string, unknown>;
}

export interface PluginDeleteResponse {
  status: string;
  id: string;
  file_deleted: boolean;
  configured_removed: boolean;
  restart_required: boolean;
}

export interface PluginStoreSource {
  id: string;
  name: string;
  url: string;
  is_official: boolean;
}

export interface PluginStoreSourceError {
  source_id: string;
  source_name: string;
  source_url: string;
  message: string;
}

export interface StorePluginItem {
  /** Unique across registries: two registries may list the same plugin id. */
  store_id: string;
  source_id: string;
  source_name: string;
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  repository_url?: string;
  homepage?: string;
  license?: string;
  tags: string[];
  logo?: string;
  install_type?: string;
  platforms: string[];
  /** From the built-in registry and a first-party repository; decided by the server. */
  is_official: boolean;
  auth_required: boolean;
  auth_configured: boolean;
  installed: boolean;
  installed_version?: string;
  /** `matched` when this registry supplied the installed copy, `different` when another one did. */
  install_source_status?: string;
  effective_enabled: boolean;
  update_available: boolean;
}

export interface PluginStoreResponse {
  plugins_enabled: boolean;
  plugins_dir: string;
  sources: PluginStoreSource[];
  source_errors: PluginStoreSourceError[];
  plugins: StorePluginItem[];
  total: number;
}

export interface PluginInstallResponse {
  status: string;
  id: string;
  version?: string;
  source_name?: string;
  plugins_enabled: boolean;
  restart_required: boolean;
}

export type PluginStoreAuthType = 'none' | 'bearer' | 'github-token' | 'basic' | 'header';
export type PluginStoreAuthTarget = 'registry' | 'metadata' | 'artifact';

/** A store authentication rule. It names environment variables; it never holds a secret. */
export interface PluginStoreAuthRule {
  match: string;
  apply_to: PluginStoreAuthTarget[];
  type: PluginStoreAuthType;
  token_env?: string;
  username_env?: string;
  password_env?: string;
  header_name?: string;
  header_value_env?: string;
  allow_insecure: boolean;
}

export interface PluginSettings {
  revision: string;
  enabled: boolean;
  dir: string;
  store_sources: string[];
  store_auth: PluginStoreAuthRule[];
}

export type PluginSettingsUpdate = Omit<PluginSettings, 'dir'>;

/** The name a plugin is called by in the console: its registered name, then its id. */
export function pluginDisplayName(plugin: { id: string; metadata?: { name?: string } }): string {
  return plugin.metadata?.name?.trim() || plugin.id;
}
