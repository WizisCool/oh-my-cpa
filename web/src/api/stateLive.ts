import { getAppConfig } from '../types/config';
import type { ConfigScalars } from '../types/configManagement';
import type { ManagementOAuthModelAlias } from '../types/managementOAuthModelAlias';
import { UNAVAILABLE_RETRY_MS, type LiveChannelState } from './liveChannel';

export type StateLiveEventType = 'ready' | 'state_sync' | 'sync_error';

export interface SafeProviderStatusItem {
  id: string;
  family: string;
  disabled: boolean;
}

export interface SafeAuthFileStatusItem {
  name: string;
  auth_index?: string;
  disabled: boolean;
}

export interface SafeProjectedStateSnapshot {
  revision: string;
  stored_layout: string;
  scalars: ConfigScalars;
  supported_keys: string[];
  client_keys_total: number;
  provider_statuses: SafeProviderStatusItem[];
  auth_file_statuses: SafeAuthFileStatusItem[];
  oauth_model_aliases: Record<string, ManagementOAuthModelAlias[]>;
  oauth_excluded_models: Record<string, string[]>;
}

export interface StateEnvelope<T> {
  version: number;
  data: T;
}

export interface StateSyncEvent {
  type: StateLiveEventType;
  version: number;
  scopes?: string[];
  code?: string;
  error?: string;
  data?: SafeProjectedStateSnapshot;
  timestamp_ms?: number;
}

export interface StateLiveListener {
  onEvent: (event: StateSyncEvent) => void;
  onState?: (state: LiveChannelState) => void;
}

export interface MinimalEventSource {
  readonly readyState: number;
  addEventListener: (type: string, listener: (event: MessageEvent<string> | Event) => void) => void;
  close: () => void;
}

export interface StateLiveChannelDeps {
  createSource: (url: string) => MinimalEventSource;
  url: () => string;
  isVisible: () => boolean;
  onVisibilityChange: (handler: () => void) => () => void;
  setTimer: (handler: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

const EVENT_SOURCE_CLOSED = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseSafeSnapshot(raw: unknown): SafeProjectedStateSnapshot | undefined {
  if (!isRecord(raw) || !isRecord(raw.scalars)) return undefined;
  const statuses: SafeProviderStatusItem[] = [];
  if (Array.isArray(raw.provider_statuses)) {
    for (const item of raw.provider_statuses) {
      if (isRecord(item) && typeof item.id === 'string' && typeof item.family === 'string' && typeof item.disabled === 'boolean') {
        statuses.push({ id: item.id, family: item.family, disabled: item.disabled });
      }
    }
  }
  const oauthAliases: Record<string, ManagementOAuthModelAlias[]> = {};
  if (isRecord(raw.oauth_model_aliases)) {
    for (const [provider, entries] of Object.entries(raw.oauth_model_aliases)) {
      if (Array.isArray(entries)) {
        oauthAliases[provider] = entries.filter(
          (entry): entry is ManagementOAuthModelAlias =>
            isRecord(entry) && typeof entry.name === 'string' && typeof entry.alias === 'string',
        );
      }
    }
  }
  const oauthExcluded: Record<string, string[]> = {};
  if (isRecord(raw.oauth_excluded_models)) {
    for (const [provider, rules] of Object.entries(raw.oauth_excluded_models)) {
      if (isStringArray(rules)) {
        oauthExcluded[provider] = rules;
      }
    }
  }
  const authStatuses: SafeAuthFileStatusItem[] = [];
  if (Array.isArray(raw.auth_file_statuses)) {
    for (const item of raw.auth_file_statuses) {
      if (isRecord(item) && typeof item.name === 'string' && typeof item.disabled === 'boolean') {
        authStatuses.push({
          name: item.name,
          ...(typeof item.auth_index === 'string' && item.auth_index !== ''
            ? { auth_index: item.auth_index }
            : {}),
          disabled: item.disabled,
        });
      }
    }
  }
  return {
    revision: typeof raw.revision === 'string' ? raw.revision : '',
    stored_layout: typeof raw.stored_layout === 'string' ? raw.stored_layout : 'unknown',
    scalars: raw.scalars as unknown as ConfigScalars,
    supported_keys: isStringArray(raw.supported_keys) ? raw.supported_keys : [],
    client_keys_total: typeof raw.client_keys_total === 'number' ? raw.client_keys_total : 0,
    provider_statuses: statuses,
    auth_file_statuses: authStatuses,
    oauth_model_aliases: oauthAliases,
    oauth_excluded_models: oauthExcluded,
  };
}

/**
 * Parses a raw SSE MessageEvent payload into a strongly typed StateSyncEvent.
 * Malformed frames return null rather than throwing inside the EventSource callback.
 */
export function parseStateSyncEvent(fallbackType: StateLiveEventType, rawData: unknown): StateSyncEvent | null {
  if (typeof rawData !== 'string' || rawData.trim() === '') {
    return { type: fallbackType, version: 0 };
  }
  try {
    const parsed: unknown = JSON.parse(rawData);
    if (!isRecord(parsed)) return null;
    const rawType = parsed.type;
    const type: StateLiveEventType =
      rawType === 'ready' || rawType === 'state_sync' || rawType === 'sync_error'
        ? rawType
        : fallbackType;
    const version = typeof parsed.version === 'number' && Number.isFinite(parsed.version) ? parsed.version : 0;
    const scopes = isStringArray(parsed.scopes) ? parsed.scopes : undefined;
    const code = typeof parsed.code === 'string' ? parsed.code : undefined;
    const error = typeof parsed.error === 'string' ? parsed.error : undefined;
    const timestampMs = typeof parsed.timestamp_ms === 'number' ? parsed.timestamp_ms : undefined;
    const data = parsed.data !== undefined ? parseSafeSnapshot(parsed.data) : undefined;
    return {
      type,
      version,
      ...(scopes ? { scopes } : {}),
      ...(code ? { code } : {}),
      ...(error ? { error } : {}),
      ...(data ? { data } : {}),
      ...(timestampMs !== undefined ? { timestamp_ms: timestampMs } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a state SSE endpoint path (such as '/api/events') against OMCPA_BASE_PATH.
 */
export function resolveStateEventsURL(endpoint = '/api/events'): string {
  const { apiBaseUrl } = getAppConfig();
  const baseRoot = apiBaseUrl.replace(/\/api\/v1\/?$/, '') || '';
  if (endpoint.startsWith('/api/')) {
    return `${baseRoot}${endpoint}`;
  }
  const clean = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return clean.startsWith(apiBaseUrl) ? clean : `${apiBaseUrl}${clean}`;
}

/**
 * Builds a shared, visibility-aware SSE state channel over injectable browser primitives
 * so unit tests can exercise reconnects, hidden-tab suspension, and sync_error parsing
 * deterministically without a real DOM.
 */
export function createStateLiveChannel(deps: StateLiveChannelDeps) {
  const listeners = new Set<StateLiveListener>();
  let source: MinimalEventSource | null = null;
  let state: LiveChannelState = 'connecting';
  let retryTimer: unknown = null;
  let detachVisibility: (() => void) | null = null;

  const setState = (next: LiveChannelState) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener.onState?.(next);
  };

  const emit = (event: StateSyncEvent) => {
    for (const listener of listeners) listener.onEvent(event);
  };

  const close = () => {
    if (retryTimer !== null) {
      deps.clearTimer(retryTimer);
      retryTimer = null;
    }
    if (source) {
      source.close();
      source = null;
    }
  };

  const bindEventType = (opened: MinimalEventSource, eventType: StateLiveEventType) => {
    opened.addEventListener(eventType, (rawEvent) => {
      if (source !== opened) return;
      if (eventType === 'ready') {
        setState('live');
      }
      const dataField = 'data' in rawEvent ? (rawEvent as MessageEvent<string>).data : '{}';
      const parsed = parseStateSyncEvent(eventType, dataField);
      if (parsed) {
        emit(parsed);
      }
    });
  };

  const open = () => {
    if (source || retryTimer !== null || listeners.size === 0 || !deps.isVisible()) return;
    setState('connecting');
    let opened: MinimalEventSource;
    try {
      opened = deps.createSource(deps.url());
    } catch {
      setState('unavailable');
      retryTimer = deps.setTimer(() => {
        retryTimer = null;
        open();
      }, UNAVAILABLE_RETRY_MS);
      return;
    }
    source = opened;
    bindEventType(opened, 'ready');
    bindEventType(opened, 'state_sync');
    bindEventType(opened, 'sync_error');
    opened.addEventListener('error', () => {
      if (source !== opened) return;
      if (opened.readyState === EVENT_SOURCE_CLOSED) {
        source = null;
        setState('unavailable');
        retryTimer = deps.setTimer(() => {
          retryTimer = null;
          open();
        }, UNAVAILABLE_RETRY_MS);
      } else {
        setState('connecting');
      }
    });
  };

  const handleVisibility = () => {
    if (deps.isVisible()) {
      open();
    } else {
      close();
      setState('connecting');
    }
  };

  return {
    subscribe(listener: StateLiveListener): () => void {
      listeners.add(listener);
      listener.onState?.(state);
      if (!detachVisibility) {
        detachVisibility = deps.onVisibilityChange(handleVisibility);
      }
      open();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size > 0) return;
        close();
        detachVisibility?.();
        detachVisibility = null;
        state = 'connecting';
      };
    },
    getState: () => state,
  };
}

const sharedChannels = new Map<string, ReturnType<typeof createStateLiveChannel>>();

/**
 * Returns the tab-wide singleton SSE channel for the given endpoint.
 */
export function stateLiveChannel(endpoint = '/api/events') {
  const resolvedUrl = resolveStateEventsURL(endpoint);
  let channel = sharedChannels.get(resolvedUrl);
  if (!channel) {
    channel = createStateLiveChannel({
      createSource: (url) => new EventSource(url, { withCredentials: true }),
      url: () => resolvedUrl,
      isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      onVisibilityChange: (handler) => {
        if (typeof document === 'undefined') return () => undefined;
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
      },
      setTimer: (handler, ms) => window.setTimeout(handler, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
    });
    sharedChannels.set(resolvedUrl, channel);
  }
  return channel;
}
