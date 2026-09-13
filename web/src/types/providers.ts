export interface ClientAPIKeyItem {
  index: number;
  key: string;
  fingerprint: string;
  length: number;
}

export interface ProviderKeyEntry {
  index: number;
  api_key: string;
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
  /** The name this provider carries in CPA's own configuration, before any local
   *  custom name replaced it. CPA labels the usage queue with
   *  "openai-compatible-<upstream name>", so a stored request record joins on this
   *  rather than on the custom name. Absent for the families CPA labels by family. */
  upstream_name?: string;
  protocol: string;
  base_url?: string;
  /** The provider's own homepage. Oh My CPA management metadata rather than a CPA
   *  field, so it is stored beside the display name and always an absolute
   *  http/https URL or absent. */
  website?: string;
  prefix?: string;
  priority?: number;
  disable_cooling?: boolean;
  auth_index?: string;
  models?: string[];
  model_entries?: ProviderModelItem[];
  disabled: boolean;
  key_configured: boolean;
  api_key?: string;
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
  /** Absent leaves the stored website alone; an empty string clears it. */
  website?: string;
}
