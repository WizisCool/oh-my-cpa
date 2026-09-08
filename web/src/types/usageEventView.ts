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

export const USAGE_EVENTS_VIEW_PREFERENCE = 'usage_events_view';

export const EVENT_GROUPING_VALUES = ['time', 'provider', 'credential'] as const;
export type EventGrouping = (typeof EVENT_GROUPING_VALUES)[number];

export interface UsageEventsViewPreference {
  preset?: string;
  from?: number;
  to?: number;
  result?: UsageResultFilter;
  limit?: number;
  model?: string;
  provider?: string;
  auth_index?: string;
  source?: string;
  api_key?: string;
  executor?: string;
  auth_type?: string;
  model_alias?: string;
  request_id?: string;
  grouping?: EventGrouping;
  advanced?: boolean;
}

export const DEFAULT_USAGE_EVENTS_VIEW: UsageEventsViewPreference = {
  preset: '1h',
  result: 'all',
  limit: 100,
  grouping: 'time',
  advanced: false,
};

/**
 * parseUsageEventsView validates a stored view preference document.
 * Unwhitelisted fields, out-of-range limits, invalid presets or malformed
 * timestamps are sanitized or dropped so stale storage cannot crash the UI.
 */
export function parseUsageEventsView(raw: unknown): UsageEventsViewPreference | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const val = raw as Record<string, unknown>;

  const grouping = (EVENT_GROUPING_VALUES as readonly string[]).includes(String(val.grouping))
    ? (String(val.grouping) as EventGrouping)
    : 'time';

  const advanced = typeof val.advanced === 'boolean' ? val.advanced : false;

  const resultVal = String(val.result ?? '');
  const result: UsageResultFilter = resultVal === 'success' || resultVal === 'failed' ? resultVal : 'all';

  const limitNum = Number(val.limit);
  const limit = Number.isInteger(limitNum) && limitNum > 0 ? Math.min(Math.max(limitNum, 1), 500) : 100;

  const pref: UsageEventsViewPreference = {
    result,
    limit,
    grouping,
    advanced,
  };

  const from = Number(val.from);
  const to = Number(val.to);
  if (val.from !== undefined && Number.isSafeInteger(from) && from >= 0) {
    pref.from = from;
    if (val.to !== undefined && Number.isSafeInteger(to) && to > from) {
      pref.to = to;
    }
  } else {
    const presetStr = String(val.preset ?? '1h');
    pref.preset = Object.prototype.hasOwnProperty.call(EVENT_PRESETS, presetStr) ? presetStr : '1h';
  }

  for (const key of EVENT_FILTER_KEYS) {
    const str = typeof val[key] === 'string' ? (val[key] as string).trim() : '';
    if (str) {
      pref[key] = str;
    }
  }

  return pref;
}

/** Check if the given URL search parameters contain any explicit event query keys */
export function hasExplicitEventQuery(params: URLSearchParams): boolean {
  if (params.has('preset') || params.has('from') || params.has('to') || params.has('result') || params.has('limit')) {
    return true;
  }
  for (const key of EVENT_FILTER_KEYS) {
    if (params.has(key)) return true;
  }
  return false;
}

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

export type CredentialFile = {
  name: string;
  auth_index?: string;
  provider?: string;
  type?: string;
  email?: string;
  project_id?: string;
};
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

export const KNOWN_PROVIDER_ICONS: Record<string, string> = {
  claude: 'Claude',
  anthropic: 'Claude',
  antigravity: 'Antigravity',
  codex: 'Codex',
  xai: 'XAI',
  grok: 'XAI',
  kimi: 'Kimi',
  moonshot: 'Kimi',
  openai: 'OpenAI',
  gemini: 'Gemini',
  google: 'Gemini',
  vertex: 'Google',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  minimax: 'Minimax',
  stepfun: 'Stepfun',
  baichuan: 'Baichuan',
  zhipu: 'Zhipu',
  doubao: 'Doubao',
  spark: 'Spark',
};

export interface EventCacheRateResult {
  rate: number;
  formatted: string;
  cached: number;
  hasData: boolean;
}

/**
 * eventCacheRate calculates the prompt cache hit percentage matching the dashboard's
 * cacheRateParts convention:
 * - OpenAI style: input tokens already includes cached prefix (cache_read <= input)
 * - Anthropic style: input tokens counts only new tokens, prompt = input + cache_read
 * Returns rate (0..100), formatted string (e.g. "85%" or "—" if no prompt data), and cached tokens.
 */
export function eventCacheRate(tokens?: UsageEvent['tokens']): EventCacheRateResult {
  if (!tokens) {
    return { rate: 0, formatted: '—', cached: 0, hasData: false };
  }
  const cached = Math.max(0, tokens.cache_read || tokens.cached || 0);
  if (cached === 0) {
    return { rate: 0, formatted: '0%', cached: 0, hasData: true };
  }
  let prompt = Math.max(0, tokens.input || (tokens.total - tokens.output));
  if (prompt <= 0 && tokens.total > 0) {
    prompt = tokens.total;
  }
  let denominator = prompt;
  if (cached > prompt) {
    denominator = prompt + cached;
  }
  if (denominator <= 0) {
    return { rate: 0, formatted: '—', cached: 0, hasData: false };
  }
  const rate = Math.min(100, Math.max(0, (cached / denominator) * 100));
  return {
    rate: Math.round(rate),
    formatted: `${Math.round(rate)}%`,
    cached,
    hasData: true,
  };
}

export interface EventTokensPerSecondResult {
  tps: number | null;
  formatted: string;
  hasTTFT: boolean;
}

/**
 * eventTokensPerSecond estimates output generation throughput in tokens per second:
 * - When valid TTFT (0 <= ttft_ms < latency_ms) is available: output * 1000 / (latency_ms - ttft_ms)
 * - Fallback when TTFT is missing: output * 1000 / latency_ms (end-to-end average)
 * - Returns formatted string (e.g. "109.21 t/s") or "—" when not measurable (non-generation, zero output, invalid latency).
 */
export function eventTokensPerSecond(
  event?: Partial<Pick<UsageEvent, 'generate' | 'latency_ms' | 'ttft_ms' | 'tokens'>>,
): EventTokensPerSecondResult {
  if (!event || event.generate === false) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }
  const output = Number(event.tokens?.output);
  if (!Number.isFinite(output) || output <= 0) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }
  const latency = Number(event.latency_ms);
  if (!Number.isFinite(latency) || latency <= 0) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }

  const ttft = event.ttft_ms != null ? Number(event.ttft_ms) : null;
  let durationMs: number;
  let hasTTFT = false;

  if (ttft !== null && Number.isFinite(ttft) && ttft >= 0 && ttft < latency) {
    durationMs = latency - ttft;
    hasTTFT = true;
  } else {
    durationMs = latency;
    hasTTFT = false;
  }

  if (durationMs <= 0) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }

  const tps = (output * 1000) / durationMs;
  return {
    tps,
    formatted: `${tps.toFixed(2)} t/s`,
    hasTTFT,
  };
}

export interface ProviderLookupEntry {
  id: string;
  name: string;
  family?: string;
  auth_index?: string;
  base_url?: string;
}

export interface ResolvedProviderInfo {
  isOAuth: boolean;
  iconId: string;
  title: string;
  subtitle?: string;
  authFile?: string;
  accountIdentity?: string;
}

export function resolveProviderInfo(
  event: UsageEvent,
  credentials: CredentialIndex,
  providerIcons: Record<string, string> = {},
  configuredProviders: ProviderLookupEntry[] = [],
  fallbackIconResolver?: (family: string, name?: string, url?: string) => string,
): ResolvedProviderInfo {
  const file = event.auth_index ? credentials.get(event.auth_index) : undefined;
  const isOAuth =
    event.auth_type?.toLowerCase() === 'oauth' ||
    file?.type?.toLowerCase() === 'oauth' ||
    Boolean(file?.email || file?.project_id);

  const resolveIcon = (family: string, name?: string, url?: string): string => {
    if (fallbackIconResolver) return fallbackIconResolver(family, name, url);
    const key = (family || '').toLowerCase().trim();
    return KNOWN_PROVIDER_ICONS[key] || 'CloudServerOutlined';
  };

  if (isOAuth) {
    const providerFamily = (file?.provider || file?.type || event.provider || 'oauth').toLowerCase();
    const iconId = resolveIcon(providerFamily, file?.name);
    const account = file?.email || file?.project_id;
    const credIdentity = resolveCredential(event, credentials);
    const fileName = credIdentity.name || file?.name || event.source || '';

    // For OAuth: display account identity prominently (e.g. email / project_id / file name)
    const displayName = account || fileName || event.resource_name || event.auth_index || providerFamily;
    const providerLabel = providerFamily ? providerFamily.charAt(0).toUpperCase() + providerFamily.slice(1) : 'OAuth';
    const secondary = account && fileName && fileName !== account ? `${providerLabel} OAuth · ${fileName}` : `${providerLabel} OAuth`;

    return {
      isOAuth: true,
      iconId,
      title: displayName,
      subtitle: secondary,
      authFile: fileName,
      accountIdentity: account || undefined,
    };
  }

  // AI Provider flow
  // 1. Try exact matches first: auth_index, resource_id, resource_name, id, or name
  let matched = configuredProviders.find(
    (p) =>
      (event.auth_index && p.auth_index === event.auth_index) ||
      (event.resource_id && p.id === event.resource_id) ||
      (event.resource_name && p.name.toLowerCase() === event.resource_name.toLowerCase()) ||
      (p.id && p.id.toLowerCase() === (event.provider || '').toLowerCase()) ||
      (p.name && p.name.toLowerCase() === (event.provider || '').toLowerCase()),
  );

  // 2. If no exact match, check if any unique configured provider's name is contained in event.provider or event.resource_name
  if (!matched && configuredProviders.length > 0) {
    const candidateText = `${event.provider || ''} ${event.resource_name || ''}`.toLowerCase();
    const candidateMatches = configuredProviders.filter(
      (p) => p.name && candidateText.includes(p.name.toLowerCase()),
    );
    if (candidateMatches.length === 1) {
      matched = candidateMatches[0];
    }
  }

  const credIdentity = resolveCredential(event, credentials);
  const fileName = credIdentity.name || event.source || '';

  // Determine clean display name: configured name -> resource name -> cleaned provider text
  let providerName = matched?.name;
  if (!providerName && event.resource_name?.trim()) {
    providerName = event.resource_name.trim();
  }
  if (!providerName && event.provider) {
    // Strip technical prefixes like openai-compatible- and trailing -go/ go
    let cleaned = event.provider.trim().replace(/^openai-compat(ibility|ible)?[-/_\s]*/i, '');
    cleaned = cleaned.replace(/[-_\s]+go$/i, '');
    if (cleaned) {
      providerName = cleaned === cleaned.toLowerCase() ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : cleaned;
    } else {
      providerName = event.provider;
    }
  }
  if (!providerName) {
    providerName = 'Unknown';
  }

  const providerFamily = (matched?.family || event.provider || '').toLowerCase();
  const iconId =
    (matched && (providerIcons[matched.id] || providerIcons[matched.name])) ||
    providerIcons[event.provider] ||
    providerIcons[providerName] ||
    resolveIcon(providerFamily, providerName, matched?.base_url);

  // For AI Providers, show only the clean Name (no technical driver subtitle)
  return {
    isOAuth: false,
    iconId,
    title: providerName,
    subtitle: undefined,
    authFile: fileName,
  };
}

/** api_group_label is a grouping category, NOT a user-assigned API key name.
 *  An api_key group resolves to its display mask, never to the stored
 *  fingerprint: records from before the mask column existed have no readable
 *  key form at all and resolve to undefined. */
export function requestGroupName(event: UsageEvent): string | undefined {
  const category = event.api_group_label?.trim().toLowerCase();
  if (category === 'api_key' || category === 'apikey') {
    return event.api_key_mask?.trim() || undefined;
  }
  const key = event.api_group_key?.trim();
  return key && key !== 'unknown' ? key : undefined;
}

/** Result-capsule label key for one record: the stored failed flag is the only
 *  success signal, so the capsule can never disagree with the filter counts. */
export function eventResultLabelKey(event: Pick<UsageEvent, 'failed'>): string {
  return event.failed ? 'events.filter_failed' : 'events.filter_success';
}

/** The client label for the list's UA column. The stored value is the one the
 *  ingestion/persistence path already reduced to a short product label, so the
 *  list shows it verbatim; a record captured without one reads as an em dash. */
export function eventUserAgentLabel(event: Pick<UsageEvent, 'user_agent'>): string {
  const value = event.user_agent?.trim();
  return value || '—';
}

/** The caller key for the list's Key column.
 *
 *  Only an `api_key` group is a caller key, and the only readable form of it we
 *  hold is the stored display mask; records ingested before the mask column
 *  existed show an em dash rather than a fingerprint. `provider` and `endpoint`
 *  groups carry a provider name or a public URL, which is not a key, so they
 *  fall through to the source fingerprint instead. */
export function eventKeyLabel(event: UsageEvent): string {
  const category = event.api_group_label?.trim().toLowerCase();
  if (category === 'api_key' || category === 'apikey') {
    return event.api_key_mask?.trim() || '—';
  }
  return event.source?.trim() || '—';
}

/** One filter-dropdown label. Key-shaped facets carry a mask so the list reads
 *  as caller keys instead of stored fingerprints. */
export function usageFacetLabel(value: { value: string; requests: number; mask?: string }): string {
  return `${value.mask?.trim() || value.value} (${value.requests})`;
}
