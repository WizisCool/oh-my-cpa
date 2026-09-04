export interface ClientAPIKeyItem {
  index: number;
  masked: string;
  fingerprint: string;
  length: number;
}

export interface ProviderKeyEntry {
  index: number;
  masked: string;
  proxy_url?: string;
  weight?: number;
}

export interface ThinkingSupportConfig {
  levels?: string[];
}

export interface ProviderModelItem {
  name: string;
  alias?: string;
  image?: boolean;
  thinking?: ThinkingSupportConfig;
}

export interface ProviderItem {
  id: string;
  family: string;
  name: string;
  protocol: string;
  base_url?: string;
  prefix?: string;
  priority?: number;
  disable_cooling?: boolean;
  auth_index?: string;
  models?: string[];
  model_entries?: ProviderModelItem[];
  disabled: boolean;
  key_configured: boolean;
  key_masked?: string;
  key_entries?: ProviderKeyEntry[];
  headers?: Record<string, string>;
  proxy_configured?: boolean;
}

export interface SaveProviderKeyItem {
  api_key?: string;
  proxy_url?: string;
  weight?: number;
}

export interface SaveProviderModelItem {
  name: string;
  alias?: string;
  image?: boolean;
  thinking?: ThinkingSupportConfig;
}

export interface SaveProviderPayload {
  family: string;
  name: string;
  base_url?: string;
  prefix?: string;
  priority?: number;
  disable_cooling?: boolean;
  api_key?: string;
  keys?: SaveProviderKeyItem[];
  models?: string[];
  model_entries?: SaveProviderModelItem[];
  headers?: Record<string, string>;
  disabled?: boolean;
}
