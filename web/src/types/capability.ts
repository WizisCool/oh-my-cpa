export type CapabilityStatus =
  | 'supported'
  | 'partial'
  | 'missing'
  | 'offline'
  | 'error'
  | 'not_probeable';

export interface CapabilityCheckItem {
  name: string;
  endpoint: string;
  status: 'supported' | 'missing' | 'offline' | 'error';
  http_status: number;
  latency_ms: number;
  message?: string;
}

export interface CapabilityProbeReport {
  key: string;
  status: CapabilityStatus;
  checks: CapabilityCheckItem[];
  probed_at_ms: number;
}
