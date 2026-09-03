import { getAppConfig } from '../types/config';
import {
  DiscoveredResource,
  DiscoveryResult,
  HealthStatus,
  ResourceOverridePayload,
} from '../types/resource';
import { ManagementOverview } from '../types/management';
import { ManagementAuthFilesResponse, ManagementAuthFileMutationResponse, ManagementAuthFileModel } from '../types/managementAuthFile';
import { DashboardResponse, DashboardTailResponse } from '../types/dashboard';
import { ErrorLogFile } from '../types/logs';
import { CapabilityProbeReport } from '../types/capability';
import { ConfigScalarsResponse, ConfigSourceResponse, ConfigGrantResponse } from '../types/configManagement';

/** DEFAULT_LOG_PAGE is the page size a fresh tail read asks for. */
export const DEFAULT_LOG_PAGE = 2000;

export interface LogsResponse {
  lines: string[];
  latest_after: number;
  next_cursor: string;
  cursor_reset: boolean;
  limit: number;
}

export interface LogsStatus {
  logging_to_file: boolean;
  request_log: boolean;
}
import { UsageEventPage, UsageEventDetail, UsageFacetsResponse } from '../types/usageEvents';

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | undefined;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | undefined): void {
  unauthorizedHandler = handler;
}

function apiRoot(): string {
  const { apiBaseUrl } = getAppConfig();
  return apiBaseUrl.replace(/\/api\/v1\/?$/, '') || '';
}

function authUrl(path: string): string {
  return `${apiRoot()}/api/auth${path}`;
}

async function readError(response: Response): Promise<{ data: unknown; message: string }> {
  let errorData: unknown = null;
  let message = `请求失败 [HTTP ${response.status}]`;
  try {
    errorData = await response.json();
    if (typeof errorData === 'object' && errorData !== null) {
      const errorObj = errorData as Record<string, unknown>;
      if (typeof errorObj.message === 'string') {
        message = errorObj.message;
      } else if (typeof errorObj.error === 'string') {
        message = errorObj.error;
      }
    }
  } catch {
    const text = await response.text().catch(() => '');
    if (text) message += `: ${text.slice(0, 100)}`;
  }
  return { data: errorData, message };
}

/**
 * apiErrorCode reads the machine-readable code off a failed facade call.
 *
 * The facade distinguishes "CPA cannot do this" from "CPA refused this" from
 * "CPA is unreachable", and the UI has to answer each differently: an offer to
 * flip a switch, a retry, or a connection state. Matching on the message text
 * would tie the whole page to English prose.
 */
export function apiErrorCode(err: unknown): string {
  if (err instanceof ApiError && err.data && typeof err.data === 'object') {
    const code = (err.data as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

async function downloadBlob(url: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json, text/plain, application/octet-stream' },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`网络连接失败 (${errorMsg})，请检查后端服务是否正常运行`, 0);
  }
  if (!response.ok) {
    const error = await readError(response);
    if (response.status === 401) unauthorizedHandler?.();
    throw new ApiError(error.message, response.status, error.data);
  }
  return response.blob();
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { apiBaseUrl } = getAppConfig();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const authBaseUrl = `${apiRoot()}/api/auth`;
  const url = cleanPath.startsWith(apiBaseUrl) || cleanPath.startsWith(authBaseUrl)
    ? cleanPath
    : `${apiBaseUrl}${cleanPath}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, { ...options, credentials: 'same-origin', headers });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`网络连接失败 (${errorMsg})，请检查后端服务是否正常运行`, 0);
  }
  if (!response.ok) {
    const error = await readError(response);
    if (response.status === 401) unauthorizedHandler?.();
    throw new ApiError(error.message, response.status, error.data);
  }
  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}

export interface AuthSession {
  authenticated: boolean;
}

export const api = {
  async login(password: string): Promise<AuthSession> {
    return request<AuthSession>(authUrl('/login'), {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },

  async getSession(): Promise<AuthSession> {
    let response: Response;
    try {
      response = await fetch(authUrl('/session'), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new ApiError(`网络连接失败 (${errorMsg})，请检查后端服务是否正常运行`, 0);
    }
    if (!response.ok) {
      const error = await readError(response);
      if (response.status === 401) unauthorizedHandler?.();
      throw new ApiError(error.message, response.status, error.data);
    }
    return response.json() as Promise<AuthSession>;
  },

  async logout(): Promise<void> {
    await request<unknown>(authUrl('/logout'), { method: 'POST' });
  },

  async getManagementOverview(): Promise<ManagementOverview> {
    return request<ManagementOverview>('/management/overview', { method: 'GET' });
  },

  async getDashboard(query: string): Promise<DashboardResponse> {
    return request<DashboardResponse>(`/management/dashboard${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  /**
   * getDashboardTail is the live poll: whole-window numbers, last few buckets.
   * It is the same window maths as getDashboard, so it must never be used to
   * render a series on its own — only to patch one.
   */
  async getDashboardTail(query: string): Promise<DashboardTailResponse> {
    return request<DashboardTailResponse>(`/management/dashboard/tail${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  /**
   * Stored console preferences, keyed by name. Server-side on purpose: a
   * reload, a service restart and a container rebuild all wipe browser state,
   * and the operator's working window should survive all three.
   */
  async getPreferences(): Promise<Record<string, unknown>> {
    const data = await request<{ preferences?: Record<string, unknown> }>('/preferences', { method: 'GET' });
    return data.preferences ?? {};
  },

  async putPreference(key: string, value: unknown): Promise<void> {
    await request<unknown>(`/preferences/${key}`, { method: 'PUT', body: JSON.stringify(value) });
  },

  /**
   * getLogs is one incremental read of CPA's log tail. `cursor` is preferred;
   * `after` is the fallback for builds without cursors.
   */
  async getLogs(params: { cursor?: string; after?: number; limit?: number }): Promise<LogsResponse> {
    const search = new URLSearchParams();
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.after) search.set('after', String(params.after));
    search.set('limit', String(params.limit ?? DEFAULT_LOG_PAGE));
    return request<LogsResponse>(`/management/logs?${search.toString()}`, { method: 'GET' });
  },

  async getCapability(key: string): Promise<CapabilityProbeReport> {
    return request<CapabilityProbeReport>(`/management/capabilities/${encodeURIComponent(key)}`, { method: 'GET' });
  },

  async getConfigScalars(): Promise<ConfigScalarsResponse> {
    return request<ConfigScalarsResponse>('/management/config', { method: 'GET' });
  },

  async updateConfigScalar(key: string, value: unknown): Promise<{ status: string; key: string; value: unknown }> {
    return request<{ status: string; key: string; value: unknown }>(`/management/config/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  },

  async getConfigSource(grantToken?: string): Promise<ConfigSourceResponse> {
    const headers: Record<string, string> = {};
    if (grantToken) {
      headers['X-Reveal-Grant'] = grantToken;
    }
    return request<ConfigSourceResponse>('/management/config/source', { method: 'GET', headers });
  },

  async grantConfigSourceReveal(password: string): Promise<ConfigGrantResponse> {
    return request<ConfigGrantResponse>('/management/config/source/grant', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },

  async updateConfigSource(yaml: string, revision?: string): Promise<{ status: string; size_bytes: number; revision: string }> {
    const headers: Record<string, string> = {};
    if (revision) {
      headers['If-Match'] = revision;
    }
    return request<{ status: string; size_bytes: number; revision: string }>('/management/config/source', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ yaml, revision }),
    });
  },

  /** getLogsStatus answers why a tail is empty: CPA only logs to file on demand. */
  async getLogsStatus(): Promise<LogsStatus> {
    return request<LogsStatus>('/management/logs/status', { method: 'GET' });
  },

  async clearLogs(): Promise<void> {
    await request<unknown>('/management/logs', { method: 'DELETE' });
  },

  async getRequestErrorLogs(): Promise<{ files: ErrorLogFile[] }> {
    const data = await request<{ files?: ErrorLogFile[] }>('/management/request-error-logs', { method: 'GET' });
    return { files: data.files ?? [] };
  },

  async downloadRequestErrorLog(name: string): Promise<Blob> {
    const { apiBaseUrl } = getAppConfig();
    return downloadBlob(`${apiBaseUrl}/management/request-error-logs/${encodeURIComponent(name)}`);
  },

  async getUsageEvents(query: string): Promise<UsageEventPage> {
    return request<UsageEventPage>(`/usage/events${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  async getUsageEvent(id: number): Promise<UsageEventDetail> {
    return request<UsageEventDetail>(`/usage/events/${id}`, { method: 'GET' });
  },

  async getUsageFacets(query: string): Promise<UsageFacetsResponse> {
    return request<UsageFacetsResponse>(`/usage/facets${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  async getUsageIngestStatus(): Promise<unknown> {
    return request<unknown>('/usage/ingest-status', { method: 'GET' });
  },

  /** requestLogFileUrl points at the server-side CPA request-log proxy. */
  requestLogFileUrl(id: number): string {
    return `${getAppConfig().apiBaseUrl}/usage/events/${id}/request-log`;
  },

  async getManagementAuthFiles(params?: { name?: string; auth_index?: string }): Promise<ManagementAuthFilesResponse> {
    const search = new URLSearchParams();
    if (params?.name) search.set('name', params.name);
    if (params?.auth_index) search.set('auth_index', params.auth_index);
    const query = search.toString();
    return request<ManagementAuthFilesResponse>(`/management/auth-files${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  async setManagementAuthFileStatus(name: string, disabled: boolean, authIndex?: string): Promise<ManagementAuthFileMutationResponse> {
    return request<ManagementAuthFileMutationResponse>('/management/auth-files/status', {
      method: 'PATCH',
      body: JSON.stringify({ name, disabled, ...(authIndex ? { auth_index: authIndex } : {}) }),
    });
  },

  async patchManagementAuthFileFields(name: string, fields: Record<string, unknown>): Promise<ManagementAuthFileMutationResponse> {
    return request<ManagementAuthFileMutationResponse>('/management/auth-files/fields', {
      method: 'PATCH',
      body: JSON.stringify({ name, ...fields }),
    });
  },

  async deleteManagementAuthFiles(names: string[]): Promise<ManagementAuthFileMutationResponse> {
    return request<ManagementAuthFileMutationResponse>('/management/auth-files', {
      method: 'DELETE',
      body: JSON.stringify({ names }),
    });
  },

  async uploadManagementAuthFiles(files: File[]): Promise<ManagementAuthFileMutationResponse> {
    const formData = new FormData();
    files.forEach((file) => formData.append('file', file, file.name));
    return request<ManagementAuthFileMutationResponse>('/management/auth-files', {
      method: 'POST',
      body: formData,
    });
  },

  async downloadManagementAuthFile(name: string): Promise<Blob> {
    const { apiBaseUrl } = getAppConfig();
    return downloadBlob(`${apiBaseUrl}/management/auth-files/download?name=${encodeURIComponent(name)}`);
  },

  async getManagementAuthFileModels(name: string): Promise<{ models: ManagementAuthFileModel[] }> {
    return request<{ models: ManagementAuthFileModel[] }>(`/management/auth-files/models?name=${encodeURIComponent(name)}`, { method: 'GET' });
  },

  async getHealth(): Promise<HealthStatus> {
    const { basePath } = getAppConfig();
    const normalizedBase = basePath === '/' ? '' : basePath;
    const url = `${normalizedBase}/api/healthz`;
    try {
      const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) return { status: 'unhealthy', uptime_seconds: 0, cpa_connected: false };
      return await res.json();
    } catch {
      return { status: 'offline', uptime_seconds: 0, cpa_connected: false };
    }
  },

  async discoverDefaultInstance(): Promise<DiscoveryResult> {
    return request<DiscoveryResult>('/instances/default/discover', { method: 'POST' });
  },

  async getResources(params?: { status?: string; driver?: string; query?: string }): Promise<{ resources: DiscoveredResource[]; total: number }> {
    const search = new URLSearchParams();
    if (params?.status) search.set('status', params.status);
    if (params?.driver) search.set('driver', params.driver);
    if (params?.query) search.set('q', params.query);
    const queryStr = search.toString();
    const data = await request<unknown>(`/resources${queryStr ? `?${queryStr}` : ''}`, { method: 'GET' });
    if (Array.isArray(data)) return { resources: data as DiscoveredResource[], total: data.length };
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.resources)) return { resources: obj.resources as DiscoveredResource[], total: typeof obj.total === 'number' ? obj.total : obj.resources.length };
      if (Array.isArray(obj.data)) return { resources: obj.data as DiscoveredResource[], total: typeof obj.total === 'number' ? obj.total : obj.data.length };
    }
    return { resources: [], total: 0 };
  },

  async updateResourceOverride(resourceId: string, payload: ResourceOverridePayload): Promise<{ status: string; resource?: DiscoveredResource }> {
    return request<{ status: string; resource?: DiscoveredResource }>(`/resources/${encodeURIComponent(resourceId)}/override`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
};
