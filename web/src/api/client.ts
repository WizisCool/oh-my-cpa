import { getAppConfig } from '../types/config';
import { isDemoMode } from '../types/demoMode';
import {
  DiscoveredResource,
  DiscoveryResult,
  HealthStatus,
  ResourceOverridePayload,
} from '../types/resource';
import { ManagementOverview, ManagementOverviewBucket } from '../types/management';
import {
  ManagementAuthFilesResponse,
  ManagementAuthFileMutationResponse,
  ManagementAuthFileModel,
  ManagementAuthFileSafeFields,
} from '../types/managementAuthFile';
import {
  ManagementOAuthModelAlias,
  ManagementOAuthModelAliasesResponse,
  ManagementOAuthModelAliasMutationResponse,
} from '../types/managementOAuthModelAlias';
import { DashboardResponse, DashboardTailResponse, DashboardWindow } from '../types/dashboard';
import { DashboardTokenHeatmap } from '../types/tokenHeatmap';
import { DashboardModelsResponse } from '../types/dashboardModels';
import { ErrorLogFile } from '../types/logs';
import { CapabilityProbeReport } from '../types/capability';
import { ConfigScalarsResponse, ConfigSourceResponse } from '../types/configManagement';
import { ClientAPIKeyItem, ClientKeyUsageItem, ProviderItem, SaveProviderPayload } from '../types/providers';
import { OAuthProviderItem, StartOAuthResponse, OAuthStatusResponse, OAuthCallbackResponse, OAuthCancelResponse } from '../types/oauth';
import { QuotaOverviewResponse, CredentialQuotaDetailResponse, QuotaItem } from '../types/quota';
import { SystemInfoResponse } from '../types/system';
import { PluginsResponse, PluginStoreResponse } from '../types/plugin';
import { PricingResponse, PricingSyncState, PricingUpdatePayload } from '../types/pricing';


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
import { UsageEventPage, UsageEventDetail, UsageFacetsResponse, parseUsageIngestRefresh, type UsageIngestRefresh } from '../types/usageEvents';

export class ApiError extends Error {
  status: number;
  data: unknown;
  /**
   * True when the server refused the call because the deployment is the public
   * demonstration. A caller distinguishes it from a permission error or from a
   * failure, because the honest answer to the operator is "the demo does not do
   * this" rather than "your request was denied".
   */
  demoBlocked: boolean;

  constructor(message: string, status: number, data?: unknown, demoBlocked = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.demoBlocked = demoBlocked;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | undefined;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | undefined): void {
  unauthorizedHandler = handler;
}

/**
 * A successful write on a demo deployment is kept in memory and lost when the
 * instance is replaced, so the console has to say so. The handler is how the API
 * layer reports it without knowing that a message API exists.
 */
type DemoEventHandler = () => void;
let demoNoticeHandler: DemoEventHandler | undefined;
let demoBlockedHandler: DemoEventHandler | undefined;

export function setDemoNoticeHandler(handler: DemoEventHandler | undefined): void {
  demoNoticeHandler = handler;
}

export function setDemoBlockedHandler(handler: DemoEventHandler | undefined): void {
  demoBlockedHandler = handler;
}

function apiRoot(): string {
  const { apiBaseUrl } = getAppConfig();
  return apiBaseUrl.replace(/\/api\/v1\/?$/, '') || '';
}

function authUrl(path: string): string {
  return `${apiRoot()}/api/auth${path}`;
}

async function readError(response: Response): Promise<{ data: unknown; message: string; demoBlocked: boolean }> {
  const demoBlocked = response.headers.get('X-OMCPA-Demo-Blocked') !== null;
  let errorData: unknown = null;
  let message = `Request failed [HTTP ${response.status}]`;
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
  return { data: errorData, message, demoBlocked };
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

/**
 * isAbortError distinguishes a request this console cancelled from a request that
 * failed. An aborted fetch rejects like a transport failure, so without this the
 * two are indistinguishable and a deliberate cancellation would be retried.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * isRetryableWriteFailure decides whether repeating a write could plausibly
 * succeed, which is a different question from whether its HTTP status looks
 * temporary.
 *
 * The facade maps several permanent CPA refusals onto 502 - a rejected body, a
 * failed management authentication, an endpoint CPA does not implement - so
 * status alone would classify them as transient. Those codes are named here
 * explicitly: retrying a refused write only repeats the refusal after making the
 * operator wait, and for a write with side effects that wait is the whole cost.
 */
export function isRetryableWriteFailure(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (!(err instanceof ApiError)) return false;
  switch (apiErrorCode(err)) {
    // The console is busy with another write and wrote nothing, so repeating the
    // request is the documented remedy rather than a gamble.
    case 'write_busy':
      return true;
    // Permanent refusals and missing capabilities, whatever status carried them.
    case 'cpa_rejected_request':
    case 'cpa_authentication_failed':
    case 'capability_missing':
      return false;
    default:
      break;
  }
  // Transport failures carry status 0. 502 without a named code is an upstream
  // failure whose cause the facade could not classify; the remaining statuses are
  // the standard temporary ones.
  return err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504;
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
    throw new ApiError(`Network request failed (${errorMsg}); check that the backend is running`, 0);
  }
  if (!response.ok) {
    const error = await readError(response);
    if (response.status === 401) unauthorizedHandler?.();
    if (error.demoBlocked) demoBlockedHandler?.();
    throw new ApiError(error.message, response.status, error.data, error.demoBlocked);
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
    // A deliberate cancellation is rethrown as itself: wrapping it in the
    // transport-failure message would hide why the request ended.
    if (isAbortError(err)) throw err;
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`Network request failed (${errorMsg}); check that the backend is running`, 0);
  }
  const method = (options.method ?? 'GET').toUpperCase();
  if (!response.ok) {
    const error = await readError(response);
    if (response.status === 401) unauthorizedHandler?.();
    if (error.demoBlocked) demoBlockedHandler?.();
    throw new ApiError(error.message, response.status, error.data, error.demoBlocked);
  }
  // A write that succeeded on a demo is stored in memory only. Reporting it here
  // rather than in each form means no write can be added later that forgets to.
  if (isDemoMode() && method !== 'GET' && method !== 'HEAD') demoNoticeHandler?.();
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
      throw new ApiError(`Network request failed (${errorMsg}); check that the backend is running`, 0);
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
   * getTokenHeatmap reads the daily token strip.
   *
   * It is a separate call from getDashboard because its span is a fixed fifty-three
   * whole weeks while the dashboard's window is not: folding it into the KPI response
   * would aggregate a year of history on every live tail poll. `timezone` is the viewer's
   * IANA zone, which decides where each local day begins - the server cannot derive it,
   * and a UTC offset would be wrong for every day on the far side of a daylight-saving
   * transition rather than only on the two transition days.
   */
  async getTokenHeatmap(timezone: string): Promise<DashboardTokenHeatmap> {
    const query = new URLSearchParams({ tz: timezone });
    return request<DashboardTokenHeatmap>(`/management/dashboard/token-heatmap?${query.toString()}`, { method: 'GET' });
  },

  /**
   * getDashboardModels reads the per-model breakdown behind the dashboard's token trend and
   * model-usage ring.
   *
   * Its own call, for the reason the heatmap has one: it answers for the window the picker selected
   * but on its own cadence, and it walks the detail rows rather than the aggregation rollup, so
   * folding it into the KPI response would pay that cost on every live tail poll. `query` carries
   * the serialized window plus the caller's grouping view (`withGroupBy` appends it), because a
   * ranking read in one grouping cannot be reused for the other.
   */
  async getDashboardModels(query: string): Promise<DashboardModelsResponse> {
    return request<DashboardModelsResponse>(`/management/dashboard/models${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  /**
   * getDashboardProviders reads per-provider request totals and sparkline buckets for the window
   * selected by the dashboard range picker.
   */
  async getDashboardProviders(query?: string): Promise<{
    window: DashboardWindow;
    providers: {
      id: string;
      total: number;
      success: number;
      failure: number;
      success_rate: number | null;
      buckets: ManagementOverviewBucket[];
    }[];
    partial_errors: string[];
  }> {
    const search = query ? (query.startsWith('?') ? query : `?${query}`) : '';
    return request(`/management/dashboard/providers${search}`, { method: 'GET' });
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

  /**
   * getConfigSource reads the raw config.yaml.
   *
   * No step-up grant is sent: the session that reaches this call already has the
   * authority the old reveal grant re-checked (see managementConfigSourceGet),
   * and the reveal is still audited server-side.
   */
  async getConfigSource(): Promise<ConfigSourceResponse> {
    return request<ConfigSourceResponse>('/management/config/source', { method: 'GET' });
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

  /**
   * `includeKeys` asks the server for the caller keys themselves, which only the key
   * page needs: it joins this list against the configuration document it edits, by the
   * key text, because neither a mask (not unique) nor an index (moves when CPA's list
   * changes) identifies a key. Every other reader renders the mask the server sends by
   * default, so reading this list never has to put a credential in a response body.
   * A caller that opts in gets it at its own cache entry - see the query keys on the
   * key page and the dashboard - because one entry cannot answer both contracts.
   */
  async getClientAPIKeys(includeKeys = false): Promise<{ keys: ClientAPIKeyItem[]; total: number }> {
    return request<{ keys: ClientAPIKeyItem[]; total: number }>(
      `/management/api-keys${includeKeys ? '?include_keys=true' : ''}`,
      { method: 'GET' },
    );
  },

  async createClientAPIKey(key: string): Promise<{ status: string; index: number; key: string }> {
    return request<{ status: string; index: number; key: string }>('/management/api-keys', {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
  },

  async deleteClientAPIKey(index: number): Promise<{ status: string; deleted: number }> {
    return request<{ status: string; deleted: number }>(`/management/api-keys/${index}`, { method: 'DELETE' });
  },

  /**
   * Names or clears one key's operator-facing alias.
   *
   * Separate from the configuration write path on purpose: an alias is Oh My CPA
   * metadata, so renaming must not rewrite CPA's `api-keys` list and rotate the
   * configuration revision for every other editor.
   */
  async setClientKeyAlias(
    keyFingerprint: string,
    alias: string,
    version: number,
  ): Promise<{ status: string; alias?: { alias: string; version: number } }> {
    return request<{ status: string; alias?: { alias: string; version: number } }>(
      '/management/client-key-aliases',
      { method: 'PUT', body: JSON.stringify({ key_fingerprint: keyFingerprint, alias, version }) },
    );
  },

  async getClientKeyUsage(
    query: string,
  ): Promise<{ window: { from: number; to: number }; usage: ClientKeyUsageItem[] }> {
    return request<{ window: { from: number; to: number }; usage: ClientKeyUsageItem[] }>(
      `/management/client-key-usage${query ? `?${query}` : ''}`,
      { method: 'GET' },
    );
  },

  async getManagementProviders(includeKeys = false): Promise<{ providers: ProviderItem[]; total: number }> {
    return request<{ providers: ProviderItem[]; total: number }>(
      `/management/providers${includeKeys ? '?include_keys=true' : ''}`,
      { method: 'GET' },
    );
  },

  /**
   * The create response names the row it added: positions are assigned
   * server-side, so the console cannot key a per-row override without it.
   */
  async createManagementProvider(payload: SaveProviderPayload): Promise<{ status: string; family: string; id: string }> {
    return request<{ status: string; family: string; id: string }>('/management/providers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async updateManagementProvider(id: string, payload: SaveProviderPayload): Promise<{ status: string; id: string }> {
    return request<{ status: string; id: string }>(`/management/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async deleteManagementProvider(id: string): Promise<{ status: string }> {
    return request<{ status: string }>(`/management/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async patchManagementProviderStatus(
    family: string,
    index: number,
    disabled: boolean,
    options: { signal?: AbortSignal; expectedAuthIndex?: string; expectedName?: string } = {},
  ): Promise<{ status: string; disabled: boolean }> {
    return request<{ status: string; disabled: boolean }>('/management/providers/status', {
      method: 'PATCH',
      body: JSON.stringify({
        family,
        index,
        disabled,
        // Sent so a retry cannot toggle a different provider if the position
        // shifted underneath it. Omitted when the row carries neither, which the
        // server treats as "no precondition" rather than as a mismatch.
        ...(options.expectedAuthIndex ? { expected_auth_index: options.expectedAuthIndex } : {}),
        ...(options.expectedName ? { expected_name: options.expectedName } : {}),
      }),
      // The console abandons a toggle write when its deadline expires; without a
      // signal the request would keep running and settle against a value the
      // operator has already replaced.
      signal: options.signal,
    });
  },

  async pullProviderModels(payload: {
    provider_id?: string;
    family?: string;
    base_url?: string;
    api_key?: string;
    proxy_url?: string;
    headers?: Record<string, string>;
  }): Promise<{ models: string[]; total: number }> {
    return request<{ models: string[]; total: number }>('/management/providers/pull-models', {
      method: 'POST',
      body: JSON.stringify(payload),
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

  async downloadUsageEventRequestLog(id: number): Promise<Blob> {
    const { apiBaseUrl } = getAppConfig();
    return downloadBlob(`${apiBaseUrl}/usage/events/${id}/request-log`);
  },

  async getUsageFacets(query: string): Promise<UsageFacetsResponse> {
    return request<UsageFacetsResponse>(`/usage/facets${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  async getUsageIngestStatus(): Promise<unknown> {
    return request<unknown>('/usage/ingest-status', { method: 'GET' });
  },

  /**
   * refreshUsageIngest asks the server to drain CPA's usage queue now and waits
   * until the captured records are queryable.
   *
   * The page's own GETs can only report what is already stored, so without this
   * a "refresh" could never show a request CPA accepted a moment ago.
   */
  async refreshUsageIngest(): Promise<UsageIngestRefresh> {
    const body = await request<unknown>('/usage/ingest/refresh', { method: 'POST' });
    return parseUsageIngestRefresh(body);
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

  async patchManagementAuthFileFields(name: string, fields: Record<string, unknown>, authIndex?: string): Promise<ManagementAuthFileMutationResponse> {
    return request<ManagementAuthFileMutationResponse>('/management/auth-files/fields', {
      method: 'PATCH',
      body: JSON.stringify({ name, ...(authIndex ? { auth_index: authIndex } : {}), ...fields }),
    });
  },

  async getManagementAuthFileSafeFields(name: string, authIndex?: string): Promise<ManagementAuthFileSafeFields> {
    const search = new URLSearchParams({ name });
    if (authIndex) search.set('auth_index', authIndex);
    return request<ManagementAuthFileSafeFields>(`/management/auth-files/safe-fields?${search.toString()}`, { method: 'GET' });
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

  async getManagementOAuthModelAliases(): Promise<ManagementOAuthModelAliasesResponse> {
    return request<ManagementOAuthModelAliasesResponse>('/management/auth-files/model-aliases', { method: 'GET' });
  },

  async patchManagementOAuthModelAliases(
    provider: string,
    aliases: ManagementOAuthModelAlias[],
  ): Promise<ManagementOAuthModelAliasMutationResponse> {
    return request<ManagementOAuthModelAliasMutationResponse>('/management/auth-files/model-aliases', {
      method: 'PATCH',
      body: JSON.stringify({ provider, aliases }),
    });
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


  // OAuth
  async getOAuthProviders(): Promise<{ providers: OAuthProviderItem[] }> {
    return request<{ providers: OAuthProviderItem[] }>('/management/oauth/providers', { method: 'GET' });
  },

  async startOAuthFlow(provider: string): Promise<StartOAuthResponse> {
    return request<StartOAuthResponse>('/management/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
  },

  async getOAuthStatus(sessionIdOrState?: string): Promise<OAuthStatusResponse> {
    const search = sessionIdOrState ? `?state=${encodeURIComponent(sessionIdOrState)}&session_id=${encodeURIComponent(sessionIdOrState)}` : '';
    return request<OAuthStatusResponse>(`/management/oauth/status${search}`, { method: 'GET' });
  },

  async handleOAuthCallback(payload: { provider: string; redirect_url: string }): Promise<OAuthCallbackResponse> {
    return request<OAuthCallbackResponse>('/management/oauth/callback', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async cancelOAuthSession(sessionId?: string): Promise<OAuthCancelResponse> {
    const search = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    return request<OAuthCancelResponse>(`/management/oauth/session${search}`, { method: 'DELETE' });
  },

  // Plugins
  async getPlugins(): Promise<PluginsResponse> {
    return request<PluginsResponse>('/management/plugins', { method: 'GET' });
  },

  async setPluginStatus(id: string, enabled: boolean): Promise<{ status: string; id: string; enabled: boolean }> {
    return request<{ status: string; id: string; enabled: boolean }>(`/management/plugins/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  },

  async deletePlugin(id: string): Promise<{ status: string; id: string }> {
    return request<{ status: string; id: string }>(`/management/plugins/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async setPluginConfig(id: string, config: Record<string, unknown>): Promise<{ status: string; id: string }> {
    return request<{ status: string; id: string }>(`/management/plugins/${encodeURIComponent(id)}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    });
  },

  async getPluginStore(): Promise<PluginStoreResponse> {
    return request<PluginStoreResponse>('/management/plugin-store', { method: 'GET' });
  },

  async installPlugin(id: string): Promise<{ status: string; id: string }> {
    return request<{ status: string; id: string }>(`/management/plugin-store/${encodeURIComponent(id)}/install`, {
      method: 'POST',
    });
  },

  // System
  async getSystemInfo(): Promise<SystemInfoResponse> {
    return request<SystemInfoResponse>('/management/system', { method: 'GET' });
  },

  async downloadSystemDiagnostics(): Promise<Blob> {
    const { apiBaseUrl } = getAppConfig();
    return downloadBlob(`${apiBaseUrl}/management/system/diagnostics`);
  },

  // Quota
  async getQuotaOverview(): Promise<QuotaOverviewResponse> {
    return request<QuotaOverviewResponse>('/management/quota', { method: 'GET' });
  },

  async refreshCredentialQuota(authIndex: string): Promise<{ status: string; quota: QuotaItem }> {
    return request<{ status: string; quota: QuotaItem }>('/management/quota/refresh', {
      method: 'POST',
      body: JSON.stringify({ auth_index: authIndex }),
    });
  },

  async batchRefreshCredentialQuotas(authIndexes: string[]): Promise<{ status: string; quotas: QuotaItem[] }> {
    return request<{ status: string; quotas: QuotaItem[] }>('/management/quota/refresh', {
      method: 'POST',
      body: JSON.stringify({ auth_indexes: authIndexes }),
    });
  },

  async clearCredentialCooldown(authIndex: string): Promise<{ status: string; auth_index: string }> {
    return request<{ status: string; auth_index: string }>('/management/quota/clear-cooldown', {
      method: 'POST',
      body: JSON.stringify({ auth_index: authIndex }),
    });
  },

  async resetCredentialQuota(authIndex: string): Promise<{ status: string; auth_index: string }> {
    return request<{ status: string; auth_index: string }>('/management/quota/reset', {
      method: 'POST',
      body: JSON.stringify({ auth_index: authIndex }),
    });
  },

  async redeemCodexResetCredit(authIndex: string): Promise<{ status: string; quota: QuotaItem }> {
    return request<{ status: string; quota: QuotaItem }>('/management/quota/redeem-credit', {
      method: 'POST',
      body: JSON.stringify({ auth_index: authIndex }),
    });
  },

  async getCredentialQuotaDetail(authIndex: string): Promise<CredentialQuotaDetailResponse> {
    return request<CredentialQuotaDetailResponse>(`/management/quota/${encodeURIComponent(authIndex)}`, {
      method: 'GET',
    });
  },

  async updateResourceOverride(resourceId: string, payload: ResourceOverridePayload): Promise<{ status: string; resource?: DiscoveredResource }> {
    return request<{ status: string; resource?: DiscoveredResource }>(`/resources/${encodeURIComponent(resourceId)}/override`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  // Pricing: one read endpoint for the page plus three operator actions.
  async getPricing(): Promise<PricingResponse> {
    return request<PricingResponse>('/pricing', { method: 'GET' });
  },

  async updatePricingModels(payload: PricingUpdatePayload): Promise<{ updated: number }> {
    return request<{ updated: number }>('/pricing/models', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async deletePricingModel(model: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(`/pricing/models/${encodeURIComponent(model)}`, {
      method: 'DELETE',
    });
  },

  async startPricingSync(): Promise<{ started: boolean }> {
    return request<{ started: boolean }>('/pricing/sync', { method: 'POST' });
  },

  async updatePricingSyncSchedule(intervalHours: number): Promise<{ interval_hours: number; state: PricingSyncState }> {
    return request<{ interval_hours: number; state: PricingSyncState }>('/pricing/sync-schedule', {
      method: 'PUT',
      body: JSON.stringify({ interval_hours: intervalHours }),
    });
  },
};
