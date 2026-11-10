export type OutboundProxyMode = 'environment' | 'direct' | 'proxy';

export interface OutboundProxySettings {
  mode: OutboundProxyMode;
  address: string;
  has_credentials: boolean;
  no_proxy: string;
  revision: number;
  cpa_revision: string;
  cpa_in_sync: boolean;
}

export interface OutboundProxyInput {
  mode: OutboundProxyMode;
  url?: string;
  no_proxy: string;
  revision: number;
  cpa_revision: string;
}
