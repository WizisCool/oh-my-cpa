import type { UsageEvent, UsageEventQuery, UsageResultFilter } from './usageEvents';

export const EVENT_PRESETS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
  '90d': 90 * 24 * 60 * 60_000,
};
export const EVENT_FILTER_KEYS = [
  'model',
  'provider',
  'auth_index',
  'source',
  'api_key',
  'executor',
  'auth_type',
  'model_alias',
  'request_id',
] as const;

/** URL is the single source of truth, including dashboard drill-downs and Back. */
export function readEventQuery(params: URLSearchParams): UsageEventQuery {
  const preset = params.get('preset') || '1h';
  const result = params.get('result');
  const limit = Number(params.get('limit') || 100);
  const query: UsageEventQuery = {
    preset: Object.prototype.hasOwnProperty.call(EVENT_PRESETS, preset) ? preset : '1h',
    result: (result === 'success' || result === 'failed' ? result : 'all') as UsageResultFilter,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100,
  };
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  if (params.has('from') && Number.isSafeInteger(from) && from >= 0) {
    if (!params.has('to')) query.from = from;
    else if (Number.isSafeInteger(to) && to > from) {
      query.from = from;
      query.to = to;
    }
  }
  for (const key of EVENT_FILTER_KEYS) {
    const value = params.get(key)?.trim();
    if (value) query[key] = value;
  }
  return query;
}

/** Freeze the window across cursor navigation to avoid moving boundaries. */
export function eventWindow(query: UsageEventQuery, now: number) {
  return query.from !== undefined
    ? { from: query.from, to: Math.min(query.to ?? now, now) }
    : { from: now - (EVENT_PRESETS[query.preset || '1h'] ?? EVENT_PRESETS['1h']), to: now };
}

export function eventPageMetrics(events: UsageEvent[]) {
  return {
    count: events.length,
    failed: events.filter((event) => event.failed).length,
    tokens: events.reduce((sum, event) => sum + event.tokens.total, 0),
    latency: events.length ? events.reduce((sum, event) => sum + event.latency_ms, 0) / events.length : null,
  };
}

export function formatEventDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export type CredentialFile = { name: string; auth_index?: string; provider?: string; type?: string };
export type CredentialIndex = ReadonlyMap<string, CredentialFile | null>;
export type CredentialIdentity = {
  name?: string;
  kind: 'resource' | 'current_file' | 'source' | 'index' | 'unknown';
};

/** Ambiguous indexes must never be guessed, even if one filename looks likely. */
export function indexCredentialFiles(files: readonly CredentialFile[]): CredentialIndex {
  const index = new Map<string, CredentialFile | null>();
  for (const file of files) {
    if (!file.auth_index || !file.name) continue;
    index.set(file.auth_index, index.has(file.auth_index) ? null : file);
  }
  return index;
}

export function resolveCredential(event: UsageEvent, files: CredentialIndex): CredentialIdentity {
  if (event.resource_name?.trim()) return { name: event.resource_name.trim(), kind: 'resource' };
  const file = event.auth_index ? files.get(event.auth_index) : undefined;
  const provider = (file?.provider || file?.type || '').toLowerCase();
  // Never assign a current file belonging to a different provider to history.
  if (file && (!provider || !event.provider || provider === event.provider.toLowerCase()))
    return { name: file.name, kind: 'current_file' };
  if (event.auth_index?.trim()) return { name: event.auth_index.trim(), kind: 'index' };
  if (event.source?.trim()) return { name: event.source.trim(), kind: 'source' };
  return { kind: 'unknown' };
}

/** api_group_label is a grouping category, NOT a user-assigned API key name. */
export function requestGroupName(event: UsageEvent): string | undefined {
  const key = event.api_group_key?.trim();
  if (!key || key === 'unknown') return undefined;
  if (event.api_group_label === 'api_key' || event.api_group_label === 'apikey') {
    return `API Key · ${key.startsWith('hmac:') ? `${key.slice(5, 17)}…` : key}`;
  }
  return key;
}
