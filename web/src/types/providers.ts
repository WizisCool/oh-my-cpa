export interface ClientAPIKeyItem {
  index: number;
  masked: string;
  fingerprint: string;
  length: number;
}

export interface ProviderItem {
  id: string;
  family: string;
  name: string;
  protocol: string;
  base_url?: string;
  auth_index?: string;
  models?: string[];
  disabled: boolean;
  key_configured: boolean;
  key_masked?: string;
  proxy_configured?: boolean;
}

export interface SaveProviderPayload {
  family: string;
  name: string;
  base_url?: string;
  api_key?: string;
  models?: string[];
  disabled?: boolean;
}
