import type { PluginItem } from './plugin';

export interface IdentityProviderItem {
  id: string;
  family: string;
  name: string;
  upstream_name?: string;
  protocol: string;
  base_url?: string;
  prefix?: string;
  priority?: number;
  auth_index?: string;
  auth_indexes?: string[];
  disabled: boolean;
  key_configured: boolean;
}

export interface IdentityCredentialItem {
  name: string;
  auth_index?: string;
  type?: string;
  provider?: string;
  oauth_provider?: string;
  email?: string;
  project_id?: string;
  display_name?: string;
  disabled: boolean;
}

export interface ArchivedCredentialItem {
  auth_index: string;
  kind: 'oauth' | 'apikey';
  provider_key?: string;
  oauth_provider?: string;
  provider_family?: string;
  provider_name?: string;
  upstream_name?: string;
  base_url?: string;
  icon_id?: string;
  file_name?: string;
  display_name?: string;
  masked_account?: string;
  key_mask?: string;
  is_ambiguous?: boolean;
  updated_at_ms?: number;
}

export interface ArchivedProviderItem {
  provider_key: string;
  kind: 'ai_provider' | 'oauth_plugin';
  name?: string;
  upstream_name?: string;
  family?: string;
  base_url?: string;
  icon_id?: string;
  logo?: string;
  is_multi_portal?: boolean;
  is_plugin_owned?: boolean;
  is_ambiguous?: boolean;
  updated_at_ms?: number;
}

export interface IdentityCatalogStatus {
  providers_known: boolean;
  credentials_known: boolean;
  plugins_known: boolean;
}

export interface IdentityDirectoryResponse {
  providers: IdentityProviderItem[];
  credentials: IdentityCredentialItem[];
  plugins: PluginItem[];
  provider_icons: Record<string, string>;
  archived_credentials: ArchivedCredentialItem[];
  archived_providers: ArchivedProviderItem[];
  catalog_status: IdentityCatalogStatus;
}
