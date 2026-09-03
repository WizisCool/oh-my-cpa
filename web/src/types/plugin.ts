export interface PluginItem {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  enabled: boolean;
  permissions?: string[];
  config?: Record<string, unknown>;
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
