export interface PluginMetadata {
  name?: string;
  version?: string;
  author?: string;
  logo?: string;
}

export interface PluginItem {
  id: string;
  name: string;
  path?: string;
  description?: string;
  version?: string;
  author?: string;
  enabled: boolean;
  effective_enabled?: boolean;
  configured?: boolean;
  registered?: boolean;
  supports_oauth?: boolean;
  oauth_provider?: string;
  logo?: string;
  permissions?: string[];
  config?: Record<string, unknown>;
  metadata?: PluginMetadata;
}

export interface StorePluginItem {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  permissions?: string[];
  installed: boolean;
}

export interface PluginsResponse {
  plugins: PluginItem[];
  total: number;
}

export interface PluginStoreResponse {
  plugins: StorePluginItem[];
  total: number;
}
