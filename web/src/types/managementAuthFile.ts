import type { ManagementOAuthModelAlias } from './managementOAuthModelAlias';
import type { ProviderErrorRule } from './providers';

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

export interface ManagementAuthFileMutationFailure {
  name: string;
  error?: string;
}

export interface ManagementAuthFileMutationResponse {
  status: string;
  disabled?: boolean;
  uploaded?: number;
  deleted?: number;
  files?: string[];
  failed?: ManagementAuthFileMutationFailure[];
  file?: ManagementAuthFile;
  fields?: ManagementAuthFileSafeFields;
}

export interface ManagementAuthFileSafeFields {
  name: string;
  priority?: number;
  weight?: number;
  prefix?: string;
  proxy_url?: string;
  expired?: string;
  disable_cooling: boolean;
  websockets: boolean;
  using_api: boolean;
  note?: string;
  excluded_models?: string[];
  /** Absent when the credential inherits the retry count. */
  request_retry?: number;
  /** The credential's own error rules, which replace its channel's while the list is not empty. */
  request_scoped_errors?: ProviderErrorRule[];
  /** The credential's own model aliases, resolved before its provider's. */
  model_aliases?: ManagementOAuthModelAlias[];
  /** Vertex service accounts only. Absent while CPA detects partner models by name. */
  openapi?: boolean;
  /** Vertex service accounts only: the location for OpenAPI requests, when not the credential's own. */
  openapi_location?: string;
  /** Vertex service accounts only: model IDs registered from the credential. */
  openapi_models?: string[];
  /** Names CPA also registers from the credential's `models` key; reported, never written. */
  openapi_legacy_models?: string[];
}

/** What the gateway stored for an imported Vertex service account; never the key. */
export interface VertexImportResult {
  status: string;
  name: string;
  project_id: string;
  email?: string;
  location: string;
}
