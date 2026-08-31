import { getAppConfig } from '../types/config';
import {
  DiscoveredResource,
  DiscoveryResult,
  HealthStatus,
  ResourceOverridePayload,
} from '../types/resource';

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
