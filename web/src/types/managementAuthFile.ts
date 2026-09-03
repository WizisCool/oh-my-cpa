export interface ManagementAuthFileRequestBucket {
  time?: string;
  success: number;
  failed: number;
}

export interface ManagementQuotaObservation {
  observed_at?: string;
  signals?: Record<string, string>;
}

export interface ManagementAuthFileModel {
  id: string;
  display_name?: string;
}

export interface ManagementAuthFile {
  name: string;
  auth_index?: string;
  type?: string;
  provider?: string;
  status?: string;
  status_message?: string;
  disabled: boolean;
  unavailable: boolean;
  runtime_only: boolean;
  email?: string;
  project_id?: string;
  success: number;
  failed: number;
  recent_requests?: ManagementAuthFileRequestBucket[];
  quota?: ManagementQuotaObservation;
  model_quotas?: Record<string, ManagementQuotaObservation>;
  models?: ManagementAuthFileModel[];
  priority?: number;
  weight?: number;
  note?: string;
}

export interface ManagementAuthFilesResponse {
  files: ManagementAuthFile[];
  total: number;
}

export interface ManagementAuthFileMutationResponse {
  status: string;
  disabled?: boolean;
  uploaded?: number;
  deleted?: number;
  files?: string[];
}
