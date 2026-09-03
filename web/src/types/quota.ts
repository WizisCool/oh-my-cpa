import { ManagementQuotaObservation } from './managementAuthFile';

export interface QuotaItem {
  auth_index: string;
  name: string;
  type: string;
  provider: string;
  quota?: ManagementQuotaObservation;
  model_quotas?: Record<string, ManagementQuotaObservation>;
  quota_exceeded: boolean;
  quota_reason?: string;
  next_recover_at_ms?: number;
  next_retry_after_ms?: number;
}

export interface QuotaOverviewResponse {
  quotas: QuotaItem[];
  total: number;
}
