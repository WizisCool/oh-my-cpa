import type {
  ConfigBackup,
  ConfigBackupList,
  ConfigChange,
  ConfigScalars,
  ConfigScalarsResponse,
  ConfigSourceResponse,
} from '../types/configManagement';
import type { CustomIcon } from '../types/customIcons';
import type { InstalledFont } from '../types/fonts';
import type {
  ManagementAuthFile,
  ManagementAuthFileModel,
  ManagementAuthFilesResponse,
  ManagementAuthFileSafeFields,
  VertexImportResult,
} from '../types/managementAuthFile';
import type {
  ManagementOAuthExcludedModelsResponse,
  ManagementOAuthModelAlias,
  ManagementOAuthModelAliasesResponse,
} from '../types/managementOAuthModelAlias';
import type { ModelSquareDirectory, ModelSquareRoute } from '../types/modelSquare';
import type { OutboundProxyInput, OutboundProxySettings } from '../types/outboundProxy';
import type {
  PluginConfigResponse,
  PluginItem,
  PluginSettings,
  PluginStoreResponse,
  PluginsResponse,
  StorePluginItem,
} from '../types/plugin';
import type {
  ModelPrice,
  PricingAttention,
  PricingChannel,
  PricingModelDetail,
  PricingModelUpdate,
  PricingResponse,
  UpstreamModel,
} from '../types/pricing';
import type {
  ClientAPIKeyItem,
  ProviderItem,
  ProviderKeyEntry,
  SaveProviderModelItem,
  SaveProviderPayload,
} from '../types/providers';
import type { QuotaOverviewResponse } from '../types/quota';
import type {
  RoutingBoard,
  RoutingMember,
  RoutingModels,
  RoutingPlanRequest,
  RoutingResultStatus,
  RoutingSettings,
} from '../types/routing';
import type {
  BackupAutomation,
  BackupAutomationInput,
  BackupDestination,
  DatabaseBackupJob,
} from '../types/databaseBackup';
import type { DataRetentionResponse, SystemInfoResponse, SystemMaintenanceResponse } from '../types/system';
import type { UsageRoutingResponse } from '../types/usageRouting';
import type { WarmupRun, WarmupStateView, WarmupTask, WarmupTaskInput } from '../types/warmup';
import type { SafeProjectedStateSnapshot, StateEnvelope } from '../api/stateLive';
import type { AuditBucket, AuditEvent } from '../types/audit';
import { maskKeyText } from '../utils/maskKey';
import { lookupProviderFamily } from '../types/providerFamilies';
import { clearDemoConversationStorage } from './session';

export const DEMO_SANDBOX_STORAGE_KEY = 'omc-demo-sandbox:v1';
const SANDBOX_SCHEMA_VERSION = 1;

interface StoredApiKeyEntry {
  key: string;
  mask?: string;
  length?: number;
  fingerprint: string;
  usage_fingerprint: string;
  alias?: string;
  alias_version?: number;
}

interface DemoOAuthSessionState {
  id: string;
  provider: string;
  flow: 'redirect' | 'device';
  status: 'waiting' | 'success' | 'error' | 'cancelled';
  url: string;
  userCode?: string;
  recoveryTarget?: { name: string; auth_index?: string; verify?: boolean };
  createdAtMs: number;
}

interface DemoSiwcSessionState {
  state: string;
  name: string;
  auth_index: string;
  rebind: boolean;
  status: 'waiting' | 'ok' | 'cancelled';
  url: string;
}

interface DemoAuditEntry {
  id: number;
  occurred_at_ms: number;
  action: string;
  target_type: string;
  target_id: string;
  result: string;
  request_id: string;
  source_summary: string;
  details?: Record<string, unknown>;
}

export interface DemoSandboxState {
  version: number;
  revisionSeq: number;
  preferences: Record<string, unknown>;
  apiKeys: {
    items?: StoredApiKeyEntry[];
    aliasesByFingerprint: Record<string, { alias: string; version: number }>;
  };
  providers: {
    byId: Record<string, ProviderItem>;
    deletedIds: string[];
    statusOverrides: Record<string, boolean>;
    nameOverrides: Record<string, string>;
  };
  config: {
    revision?: string;
    scalars?: ConfigScalars;
    yaml?: string;
    safeYaml?: string;
    backups?: ConfigBackup[];
    backupYamlById: Record<number, string>;
    backupRetention?: number;
  };
  authFiles: {
    created: ManagementAuthFile[];
    deletedNames: string[];
    statusOverrides: Record<string, boolean>;
    displayNameOverrides: Record<string, { display_name: string; version: number }>;
    safeFieldsOverrides: Record<string, Partial<ManagementAuthFileSafeFields>>;
    recoveredNames: Record<string, { refreshedAt: string; verified: boolean }>;
    siwcOverrides: Record<string, { use_siwc?: boolean; siwc_bound?: boolean; siwc_status?: 'off' | 'valid' | 'invalid'; siwc_expires_at?: string }>;
    modelAliases?: Record<string, ManagementOAuthModelAlias[]>;
    excludedModels?: Record<string, string[]>;
  };
  routing: {
    revision?: string;
    settingsOverrides: Partial<RoutingSettings>;
    memberOverrides: Record<string, { priority?: number; weights?: RoutingMember['weights'] }>;
  };
  plugins: {
    enabledOverrides: Record<string, boolean>;
    deletedIds: string[];
    installed: PluginItem[];
    configs: Record<string, Record<string, unknown>>;
    settings?: PluginSettings;
  };
  pricing: {
    modelOverrides: Record<string, ModelPrice | null>;
    channelModelOverrides: Record<string, ModelPrice | null>;
    dismissedCandidates: Record<string, string[]>;
    channelOverrides: Record<string, PricingChannel | null>;
    syncIntervalHours?: number;
    lastSyncedAtMs?: number;
  };
  quota: {
    clearedCooldowns: Record<string, number>;
    refreshedAt: Record<string, number>;
    resetAt: Record<string, number>;
    redeemedCredits: Record<string, number>;
    warmupTasks?: WarmupTask[];
    warmupRunsAdded: WarmupRun[];
    warmupRunsClearedAtMs?: number;
  };
  customIcons: {
    created: CustomIcon[];
    updated: Record<string, Partial<CustomIcon>>;
    deletedIds: string[];
    dataUrls: Record<string, string>;
  };
  fonts: {
    deletedIds: string[];
  };
  system: {
    outboundProxy?: OutboundProxySettings;
    dataRetentionDays?: number;
    logsClearedAtMs?: number;
    lastMaintenanceAtMs?: number;
    lastUpdateCheckAtMs?: number;
    dbBackupAutomation?: BackupAutomation;
    dbBackupJobs?: DatabaseBackupJob[];
  };
  auditTrail: DemoAuditEntry[];
  extraLogLines: string[];
}

function emptySandboxState(): DemoSandboxState {
  return {
    version: SANDBOX_SCHEMA_VERSION,
    revisionSeq: 1,
    preferences: {},
    apiKeys: { aliasesByFingerprint: {} },
    providers: { byId: {}, deletedIds: [], statusOverrides: {}, nameOverrides: {} },
    config: { backupYamlById: {} },
    authFiles: {
      created: [],
      deletedNames: [],
      statusOverrides: {},
      displayNameOverrides: {},
      safeFieldsOverrides: {},
      recoveredNames: {},
      siwcOverrides: {},
    },
    routing: { settingsOverrides: {}, memberOverrides: {} },
    plugins: { enabledOverrides: {}, deletedIds: [], installed: [], configs: {} },
    pricing: { modelOverrides: {}, channelModelOverrides: {}, dismissedCandidates: {}, channelOverrides: {} },
    quota: { clearedCooldowns: {}, refreshedAt: {}, resetAt: {}, redeemedCredits: {}, warmupRunsAdded: [] },
    customIcons: { created: [], updated: {}, deletedIds: [], dataUrls: {} },
    fonts: { deletedIds: [] },
    system: {},
    auditTrail: [],
    extraLogLines: [],
  };
}

let memoryState: DemoSandboxState | null = null;
const baselineCache = new Map<string, unknown>();
const oauthSessions = new Map<string, DemoOAuthSessionState>();
const siwcSessions = new Map<string, DemoSiwcSessionState>();
const listeners = new Set<() => void>();
let storageListenerAttached = false;

function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function loadState(): DemoSandboxState {
  if (memoryState) return memoryState;
  if (hasLocalStorage()) {
    if (!storageListenerAttached) {
      storageListenerAttached = true;
      window.addEventListener('storage', (event) => {
        if (event.key === DEMO_SANDBOX_STORAGE_KEY) {
          memoryState = null;
          notifyListeners();
        }
      });
    }
    try {
      const raw = window.localStorage.getItem(DEMO_SANDBOX_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<DemoSandboxState>;
        if (parsed && parsed.version === SANDBOX_SCHEMA_VERSION) {
          const base = emptySandboxState();
          memoryState = {
            ...base,
            ...parsed,
            apiKeys: { ...base.apiKeys, ...parsed.apiKeys },
            providers: { ...base.providers, ...parsed.providers },
            config: { ...base.config, ...parsed.config },
            authFiles: { ...base.authFiles, ...parsed.authFiles },
            routing: { ...base.routing, ...parsed.routing },
            plugins: { ...base.plugins, ...parsed.plugins },
            pricing: { ...base.pricing, ...parsed.pricing },
            quota: { ...base.quota, ...parsed.quota },
            customIcons: { ...base.customIcons, ...parsed.customIcons },
            fonts: { ...base.fonts, ...parsed.fonts },
            system: { ...base.system, ...parsed.system },
            auditTrail: Array.isArray(parsed.auditTrail) ? parsed.auditTrail : [],
            extraLogLines: Array.isArray(parsed.extraLogLines) ? parsed.extraLogLines : [],
          };
          syncIconUrlLookup(memoryState);
          return memoryState;
        }
      }
    } catch {
      // Ignore corrupt browser storage and start from a fresh sandbox.
    }
  }
  memoryState = emptySandboxState();
  syncIconUrlLookup(memoryState);
  return memoryState;
}

function saveState(state: DemoSandboxState): void {
  memoryState = state;
  syncIconUrlLookup(state);
  syncSnapshotCache(state);
  if (hasLocalStorage()) {
    try {
      window.localStorage.setItem(DEMO_SANDBOX_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore quota errors in constrained environments; in-memory state still works.
    }
  }
  notifyListeners();
}

function syncIconUrlLookup(state: DemoSandboxState): void {
  if (typeof window === 'undefined') return;
  const target = window as unknown as { __OMCPA_DEMO_ICON_URLS__?: Record<string, string> };
  target.__OMCPA_DEMO_ICON_URLS__ = { ...state.customIcons.dataUrls };
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function subscribeDemoSandbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function countDemoSandboxChanges(state = loadState()): number {
  let count = 0;
  count += Object.keys(state.preferences).length;
  if (state.apiKeys.items) count += 1;
  count += Object.keys(state.apiKeys.aliasesByFingerprint).length;
  count += Object.keys(state.providers.byId).length;
  count += state.providers.deletedIds.length;
  count += Object.keys(state.providers.statusOverrides).length;
  count += Object.keys(state.providers.nameOverrides).length;
  if (state.config.yaml !== undefined || state.config.scalars !== undefined || state.config.backups !== undefined) count += 1;
  count += state.authFiles.created.length + state.authFiles.deletedNames.length;
  count += Object.keys(state.authFiles.statusOverrides).length;
  count += Object.keys(state.authFiles.displayNameOverrides).length;
  count += Object.keys(state.authFiles.safeFieldsOverrides).length;
  count += Object.keys(state.authFiles.recoveredNames).length;
  if (state.authFiles.modelAliases) count += Object.keys(state.authFiles.modelAliases).length;
  if (state.authFiles.excludedModels) count += Object.keys(state.authFiles.excludedModels).length;
  count += Object.keys(state.routing.settingsOverrides).length;
  count += Object.keys(state.routing.memberOverrides).length;
  count += Object.keys(state.plugins.enabledOverrides).length;
  count += state.plugins.deletedIds.length + state.plugins.installed.length;
  count += Object.keys(state.plugins.configs).length;
  if (state.plugins.settings) count += 1;
  count += Object.keys(state.pricing.modelOverrides).length;
  count += Object.keys(state.pricing.channelModelOverrides ?? {}).length;
  count += Object.keys(state.pricing.dismissedCandidates).length;
  count += Object.keys(state.pricing.channelOverrides).length;
  if (state.pricing.syncIntervalHours !== undefined) count += 1;
  count += Object.keys(state.quota.clearedCooldowns).length;
  count += Object.keys(state.quota.resetAt).length;
  count += Object.keys(state.quota.redeemedCredits).length;
  if (state.quota.warmupTasks) count += 1;
  count += state.quota.warmupRunsAdded.length;
  count += state.customIcons.created.length + state.customIcons.deletedIds.length + Object.keys(state.customIcons.updated).length;
  count += state.fonts.deletedIds.length;
  if (state.system.outboundProxy || state.system.dataRetentionDays !== undefined || state.system.logsClearedAtMs !== undefined || state.system.dbBackupAutomation || (state.system.dbBackupJobs?.length ?? 0) > 0) count += 1;
  return count;
}

let cachedSnapshot: { changeCount: number; revisionSeq: number } = { changeCount: 0, revisionSeq: 1 };

function syncSnapshotCache(state: DemoSandboxState): void {
  const changeCount = countDemoSandboxChanges(state);
  if (
    cachedSnapshot.changeCount !== changeCount ||
    cachedSnapshot.revisionSeq !== state.revisionSeq
  ) {
    cachedSnapshot = { changeCount, revisionSeq: state.revisionSeq };
  }
}

export function getDemoSandboxSnapshot(): { changeCount: number; revisionSeq: number } {
  const state = loadState();
  syncSnapshotCache(state);
  return cachedSnapshot;
}

export function resetDemoSandbox(): void {
  const fresh = emptySandboxState();
  oauthSessions.clear();
  siwcSessions.clear();
  baselineCache.clear();
  clearDemoConversationStorage();
  if (hasLocalStorage()) {
    try {
      window.localStorage.removeItem(DEMO_SANDBOX_STORAGE_KEY);
    } catch {
      // Ignore storage removal errors.
    }
  }
  saveState(fresh);
}

function nextRevision(state: DemoSandboxState, prefix = 'demo-rev'): string {
  state.revisionSeq += 1;
  return `${prefix}-${state.revisionSeq}`;
}

function recordSandboxAudit(
  state: DemoSandboxState,
  action: string,
  targetType: string,
  targetID: string,
  details?: Record<string, unknown>,
): void {
  const now = Date.now();
  const id = 900_000 + state.auditTrail.length + 1;
  state.auditTrail.unshift({
    id,
    occurred_at_ms: now,
    action,
    target_type: targetType,
    target_id: targetID,
    result: 'success',
    request_id: `req_sandbox_${id}`,
    source_summary: 'sandbox=browser session=isolated',
    details,
  });
  if (state.auditTrail.length > 60) state.auditTrail.length = 60;
  state.extraLogLines.unshift(
    `${new Date(now).toISOString()} level=info msg="sandbox operation recorded" action=${action} target=${targetID}`,
  );
  if (state.extraLogLines.length > 80) state.extraLogLines.length = 80;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-OMCPA-Demo': 'active',
      'X-OMCPA-Demo-Sandbox': 'browser',
    },
  });
}

function errorResponse(error: string, code: string, status = 400): Response {
  return jsonResponse({ error, code }, status);
}

type FetchBaselineFn = (pathWithQuery: string, options?: RequestInit) => Promise<Response>;

async function ensureBaseline<T>(cacheKey: string, pathWithQuery: string, fetchBaseline: FetchBaselineFn): Promise<T | null> {
  if (baselineCache.has(cacheKey)) {
    return structuredClone(baselineCache.get(cacheKey)) as T;
  }
  try {
    const res = await fetchBaseline(pathWithQuery, { method: 'GET' });
    if (!res.ok) return null;
    const data = (await res.json()) as T;
    baselineCache.set(cacheKey, structuredClone(data));
    return data;
  } catch {
    return null;
  }
}

async function readBaselineJson<T>(cacheKey: string, res: Response): Promise<T> {
  const data = (await res.json()) as T;
  baselineCache.set(cacheKey, structuredClone(data));
  return data;
}

function parseJsonBody<T>(options?: RequestInit): T | null {
  if (!options?.body || typeof options.body !== 'string') return null;
  try {
    return JSON.parse(options.body) as T;
  } catch {
    return null;
  }
}

function fnvHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function deriveKeyFingerprints(key: string): { fingerprint: string; usage_fingerprint: string } {
  return {
    fingerprint: `demo-fp-${fnvHex(`client:${key}`)}`,
    usage_fingerprint: `hmac:${fnvHex(`usage:${key}`).repeat(2)}`,
  };
}

// ---------------------------------------------------------------------------
// API Keys & Aliases
// ---------------------------------------------------------------------------

function mergeApiKeys(
  baseline: { keys: ClientAPIKeyItem[]; total: number },
  state: DemoSandboxState,
  includeKeys: boolean,
): { keys: ClientAPIKeyItem[]; total: number } {
  const source: ClientAPIKeyItem[] = state.apiKeys.items
    ? state.apiKeys.items.map((entry, index) => ({
        index,
        key: entry.key,
        fingerprint: entry.fingerprint,
        usage_fingerprint: entry.usage_fingerprint,
        length: entry.length ?? entry.key.length,
        alias: entry.alias,
        alias_version: entry.alias_version ?? 0,
      }))
    : baseline.keys.map((item, index) => ({ ...item, index }));

  const keys = source.map((item, index) => {
    const storedEntry = state.apiKeys.items?.[index];
    const aliasOverride =
      (item.usage_fingerprint && state.apiKeys.aliasesByFingerprint[item.usage_fingerprint]) ||
      state.apiKeys.aliasesByFingerprint[item.fingerprint];
    const alias = aliasOverride ? aliasOverride.alias || undefined : item.alias;
    const aliasVersion = aliasOverride ? aliasOverride.version : item.alias_version;
    const masked = storedEntry?.mask ?? maskKeyText(item.key) ?? item.key;
    return {
      ...item,
      index,
      alias,
      alias_version: aliasVersion,
      key: includeKeys ? item.key : masked,
    };
  });
  return { keys, total: keys.length };
}

function syntheticSandboxApiKey(fingerprint: string): string {
  return `omc-demo-sandbox-${fingerprint.replace(/^demo-fp-/, '').slice(0, 12)}`;
}

async function ensureApiKeyEntries(state: DemoSandboxState, fetchBaseline: FetchBaselineFn): Promise<StoredApiKeyEntry[]> {
  if (state.apiKeys.items) return state.apiKeys.items;
  const baseline = await ensureBaseline<{ keys: ClientAPIKeyItem[]; total: number }>(
    'api-keys-with-keys',
    '/management/api-keys?include_keys=true',
    fetchBaseline,
  );
  const keys: StoredApiKeyEntry[] = (baseline?.keys ?? []).map((item) => {
    const derived = deriveKeyFingerprints(item.key);
    return {
      key: item.key,
      fingerprint: item.fingerprint || derived.fingerprint,
      usage_fingerprint: item.usage_fingerprint || derived.usage_fingerprint,
      alias: item.alias,
      alias_version: item.alias_version,
    };
  });
  state.apiKeys.items = keys;
  return keys;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function maskProviderSecrets(provider: ProviderItem): ProviderItem {
  const maskedKeys: ProviderKeyEntry[] | undefined = provider.key_entries?.map((entry) => ({
    ...entry,
    api_key: maskKeyText(entry.api_key) || '••••',
  }));
  return {
    ...provider,
    api_key: provider.api_key ? maskKeyText(provider.api_key) : undefined,
    key_entries: maskedKeys,
  };
}

function mergeProviders(
  baseline: { providers: ProviderItem[]; total: number },
  state: DemoSandboxState,
  includeKeys: boolean,
): { providers: ProviderItem[]; total: number } {
  const deleted = new Set(state.providers.deletedIds);
  const seen = new Set<string>();
  const list: ProviderItem[] = [];

  for (const base of baseline.providers) {
    if (deleted.has(base.id)) continue;
    seen.add(base.id);
    const current = state.providers.byId[base.id] ?? base;
    list.push(applyProviderOverlays(current, state, includeKeys));
  }

  for (const [id, created] of Object.entries(state.providers.byId)) {
    if (seen.has(id) || deleted.has(id)) continue;
    list.push(applyProviderOverlays(created, state, includeKeys));
  }

  return { providers: list, total: list.length };
}

function applyProviderOverlays(provider: ProviderItem, state: DemoSandboxState, includeKeys: boolean): ProviderItem {
  const disabled = Object.prototype.hasOwnProperty.call(state.providers.statusOverrides, provider.id)
    ? state.providers.statusOverrides[provider.id]
    : provider.disabled;
  const customName = Object.prototype.hasOwnProperty.call(state.providers.nameOverrides, provider.id)
    ? state.providers.nameOverrides[provider.id]
    : undefined;
  const name = customName !== undefined ? (customName || provider.upstream_name || provider.name) : provider.name;
  const next: ProviderItem = {
    ...provider,
    disabled,
    name,
  };
  return includeKeys ? next : maskProviderSecrets(next);
}

function sanitizeHeadersForSandbox(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (/^(authorization|x-api-key|api-key|x-auth-token|cookie)$/i.test(key.trim()) || /token|secret|key|auth/i.test(key)) {
      out[key] = maskKeyText(val) || '••••';
    } else {
      out[key] = val;
    }
  }
  return out;
}

function buildProviderFromPayload(
  id: string,
  payload: SaveProviderPayload,
  existing?: ProviderItem,
): ProviderItem {
  const meta = lookupProviderFamily(payload.family);
  const keyEntries: ProviderKeyEntry[] = (payload.keys ?? []).map((entry, idx) => {
    const prev = entry.source_index !== undefined
      ? existing?.key_entries?.find((k) => k.index === entry.source_index)
      : existing?.key_entries?.[idx];
    const resolvedKey = !entry.api_key
      ? (prev?.api_key ?? '')
      : maskKeyText(entry.api_key) || '••••';
    return {
      index: idx,
      api_key: resolvedKey,
      proxy_url: entry.proxy_url,
      weight: entry.weight ?? 1,
      connection_pool: entry.connection_pool ?? prev?.connection_pool ?? null,
      effective_connection_pool: entry.connection_pool ?? prev?.effective_connection_pool ?? null,
    };
  });
  const modelSource: SaveProviderModelItem[] = payload.model_entries ?? (payload.models ?? []).map((name) => ({ name }));
  const modelEntries = modelSource.map((m) => ({
    name: m.name,
    alias: m.alias || undefined,
    image: m.image,
    thinking: m.thinking,
    options: m.options,
  }));
  const models = modelEntries.map((m) => m.alias || m.name);
  const authIndexes = existing?.auth_indexes?.length
    ? existing.auth_indexes
    : keyEntries.map((_, idx) => `demo-${id}-${idx + 1}`);
  const upstreamName = payload.family === 'openai-compatibility'
    ? (existing?.upstream_name || payload.name)
    : existing?.upstream_name;
  return {
    id,
    family: payload.family,
    name: payload.name || existing?.name || meta?.id || payload.family,
    upstream_name: upstreamName,
    protocol: existing?.protocol || payload.family || 'OpenAI Compatible',
    base_url: payload.base_url ?? existing?.base_url,
    website: payload.website !== undefined ? payload.website : existing?.website,
    prefix: payload.prefix ?? existing?.prefix,
    priority: payload.priority ?? existing?.priority ?? 0,
    disabled: payload.disabled ?? existing?.disabled ?? false,
    api_key: keyEntries[0]?.api_key,
    key_configured: keyEntries.some((k) => Boolean(k.api_key)),
    key_entries: keyEntries,
    auth_index: authIndexes[0],
    auth_indexes: authIndexes,
    models,
    model_entries: modelEntries,
    test_model: payload.test_model ?? existing?.test_model,
    headers: sanitizeHeadersForSandbox(payload.headers) ?? existing?.headers,
    connection_pool: payload.connection_pool !== undefined
      ? {
          group_name: existing?.connection_pool?.group_name || id,
          group_size: keyEntries.length,
          defaults: payload.connection_pool,
        }
      : existing?.connection_pool,
    runtime_policy: payload.runtime_policy
      ? {
          cooling: payload.runtime_policy.cooling,
          request_retry: payload.runtime_policy.request_retry,
          error_rules: payload.runtime_policy.error_rules,
          supports_error_rules: existing?.runtime_policy?.supports_error_rules ?? true,
        }
      : existing?.runtime_policy,
    behavior: payload.behavior ?? existing?.behavior,
  };
}

function nextProviderID(family: string, existingProviders: ProviderItem[], deletedIds: string[] = []): string {
  const prefix = family === 'openai-compatibility' ? 'openai-compat-' : `${family}-`;
  let maxIndex = -1;
  for (const p of existingProviders) {
    if (p.id.startsWith(prefix)) {
      const n = Number.parseInt(p.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > maxIndex) maxIndex = n;
    }
  }
  for (const id of deletedIds) {
    if (id.startsWith(prefix)) {
      const n = Number.parseInt(id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > maxIndex) maxIndex = n;
    }
  }
  return `${prefix}${maxIndex + 1}`;
}

function simulatedModelsForProvider(family: string, baseUrl?: string): string[] {
  const hint = `${family} ${baseUrl ?? ''}`.toLowerCase();
  if (hint.includes('deepseek')) return ['deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-flash'];
  if (hint.includes('z.ai') || hint.includes('bigmodel') || hint.includes('zhipu')) return ['glm-5.3-flash', 'glm-5.3', 'glm-5.3-prime'];
  if (hint.includes('mimo') || hint.includes('xiaomi')) return ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.5'];
  if (hint.includes('dashscope') || hint.includes('qwen') || hint.includes('aliyun')) return ['qwen3.8-omni-flash', 'qwen3.8-max-0902', 'qwen3.8-27b'];
  if (hint.includes('minimax')) return ['minimax-m3.1-flash', 'minimax-m3'];
  if (hint.includes('anthropic') || hint.includes('claude')) return ['claude-fable-5.2', 'claude-opus-5.5', 'claude-sonnet-5.5', 'claude-haiku-5.5'];
  if (hint.includes('gemini') || hint.includes('google') || hint.includes('generativelanguage')) return ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash'];
  if (hint.includes('kimi') || hint.includes('moonshot')) return ['kimi-k3.1-pro', 'kimi-k3'];
  if (hint.includes('x.ai') || hint.includes('grok') || hint.includes('xai')) return ['grok-4.7', 'grok-4.6'];
  return ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'];
}

// ---------------------------------------------------------------------------
// Config & Backups
// ---------------------------------------------------------------------------

const SCALAR_PATH_TO_KEY: Array<{ path: string[]; key: keyof ConfigScalars }> = [
  { path: ['requests', 'proxy-url'], key: 'proxy_url' },
  { path: ['oauth', 'providers', 'aistudio', 'ws-auth'], key: 'ws_auth' },
  { path: ['routing', 'force-model-prefix'], key: 'force_model_prefix' },
  { path: ['observability', 'logs', 'debug'], key: 'debug' },
  { path: ['observability', 'logs', 'request-log'], key: 'request_log' },
  { path: ['observability', 'logs', 'logging-to-file'], key: 'logging_to_file' },
  { path: ['observability', 'logs', 'logs-max-total-size-mb'], key: 'logs_max_total_size_mb' },
  { path: ['observability', 'logs', 'error-logs-max-files'], key: 'error_logs_max_files' },
  { path: ['routing', 'strategy'], key: 'routing_strategy' },
  { path: ['routing', 'retry', 'request-retry'], key: 'request_retry' },
  { path: ['routing', 'retry', 'max-retry-interval'], key: 'max_retry_interval' },
  { path: ['routing', 'retry', 'max-retry-credentials'], key: 'max_retry_credentials' },
  { path: ['observability', 'usage', 'usage-statistics-enabled'], key: 'usage_statistics_enabled' },
];

function syncScalarsFromDoc(doc: { getIn(path: string[]): unknown }, current: ConfigScalars): ConfigScalars {
  const next = { ...current };
  for (const entry of SCALAR_PATH_TO_KEY) {
    const val = doc.getIn(entry.path);
    if (val !== undefined) {
      (next as Record<string, unknown>)[entry.key] = val;
    }
  }
  return next;
}

async function ensureConfigState(state: DemoSandboxState, fetchBaseline: FetchBaselineFn): Promise<{
  scalarsRes: ConfigScalarsResponse;
  sourceRes: ConfigSourceResponse;
}> {
  const scalarsBase = (await ensureBaseline<ConfigScalarsResponse>('config', '/management/config', fetchBaseline))!;
  const sourceBase = (await ensureBaseline<ConfigSourceResponse>('config-source', '/management/config/source', fetchBaseline))!;
  const scalarsRes: ConfigScalarsResponse = {
    ...scalarsBase,
    scalars: state.config.scalars ?? scalarsBase.scalars,
    revision: state.config.revision ?? scalarsBase.revision,
    safe_yaml: state.config.safeYaml ?? scalarsBase.safe_yaml,
  };
  const yaml = state.config.yaml ?? sourceBase.yaml;
  const sourceRes: ConfigSourceResponse = {
    yaml,
    size_bytes: new TextEncoder().encode(yaml).byteLength,
    revision: state.config.revision ?? sourceBase.revision,
  };
  return { scalarsRes, sourceRes };
}

async function ensureConfigBackups(state: DemoSandboxState, fetchBaseline: FetchBaselineFn): Promise<ConfigBackupList> {
  const base = await ensureBaseline<ConfigBackupList>('config-backups', '/management/config/backups', fetchBaseline);
  const list: ConfigBackupList = base ?? {
    backups: [],
    settings: { retention: 20, retention_min: 5, retention_max: 100, legacy_retention: 10 },
  };
  return {
    backups: state.config.backups ?? list.backups,
    settings: {
      ...list.settings,
      retention: state.config.backupRetention ?? list.settings.retention,
    },
  };
}

function pushConfigBackup(
  state: DemoSandboxState,
  backupsList: ConfigBackupList,
  yamlSnapshot: string,
  revision: string,
  reason: string,
): ConfigBackup {
  const nextId = Math.max(0, ...backupsList.backups.map((b) => b.id)) + 1;
  const backup: ConfigBackup = {
    id: nextId,
    created_at_ms: Date.now(),
    revision,
    size_bytes: new TextEncoder().encode(yamlSnapshot).byteLength,
    layout: 'v8',
    reason,
  };
  state.config.backupYamlById[nextId] = yamlSnapshot;
  const limit = state.config.backupRetention ?? backupsList.settings.retention;
  state.config.backups = [backup, ...backupsList.backups].slice(0, limit);
  return backup;
}

// ---------------------------------------------------------------------------
// Auth files, OAuth rules, Quota & Warmup
// ---------------------------------------------------------------------------

function mergeAuthFiles(baseline: ManagementAuthFilesResponse, state: DemoSandboxState): ManagementAuthFilesResponse {
  const deleted = new Set(state.authFiles.deletedNames);
  const all = [...baseline.files, ...state.authFiles.created];
  const files = all
    .filter((f) => !deleted.has(f.name))
    .map((file) => {
      let next = { ...file };
      if (Object.prototype.hasOwnProperty.call(state.authFiles.statusOverrides, file.name)) {
        const disabled = state.authFiles.statusOverrides[file.name];
        next.disabled = disabled;
        next.status = disabled ? 'disabled' : file.status === 'disabled' ? 'ready' : file.status;
      }
      const rename = state.authFiles.displayNameOverrides[file.name];
      if (rename) {
        next.display_name = rename.display_name || undefined;
        next.display_name_version = rename.version;
      }
      const recovered = state.authFiles.recoveredNames[file.name];
      if (recovered) {
        next = {
          ...next,
          unavailable: false,
          requires_sign_in: false,
          refresh_error: undefined,
          next_action: undefined,
          access_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
          next_refresh_after: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
          renewal_state: 'renewal_verified',
          recovery_stage: recovered.verified ? 'renewal_verified' : 'loaded',
          renewal_verified: true,
          inference_verified: recovered.verified || next.inference_verified,
          status: next.disabled ? 'disabled' : 'ready',
          status_message: undefined,
        };
      }
      const siwc = state.authFiles.siwcOverrides[file.name];
      if (siwc) {
        next = { ...next, ...siwc };
      }
      const safeFields = state.authFiles.safeFieldsOverrides[file.name];
      if (safeFields) {
        if (safeFields.priority !== undefined) next.priority = safeFields.priority;
        if (safeFields.weight !== undefined) next.weight = safeFields.weight;
        if (safeFields.note !== undefined) next.note = safeFields.note;
      }
      return next;
    });
  return { files, total: files.length };
}

function defaultSafeFieldsFor(file: ManagementAuthFile): ManagementAuthFileSafeFields {
  return {
    name: file.name,
    priority: file.priority,
    weight: file.weight,
    disable_cooling: false,
    websockets: false,
    using_api: false,
    note: file.note,
    use_siwc: file.use_siwc,
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function mergeRoutingBoard(
  baseline: RoutingBoard,
  state: DemoSandboxState,
  mergedProviders?: ProviderItem[],
  mergedAuthFiles?: ManagementAuthFile[],
): RoutingBoard {
  const deletedProviderIds = new Set(state.providers.deletedIds);
  const deletedAuthNames = new Set(state.authFiles.deletedNames);

  const settings: RoutingSettings = {
    ...baseline.settings,
    ...(state.config.scalars
      ? {
          strategy: state.config.scalars.routing_strategy as RoutingSettings['strategy'],
          request_retry: state.config.scalars.request_retry,
          max_retry_credentials: state.config.scalars.max_retry_credentials,
          max_retry_interval: state.config.scalars.max_retry_interval,
          force_model_prefix: state.config.scalars.force_model_prefix,
        }
      : {}),
    ...state.routing.settingsOverrides,
  };

  const providerById = new Map((mergedProviders ?? []).map((p) => [p.id, p]));
  const authByName = new Map((mergedAuthFiles ?? []).map((a) => [a.name, a]));

  const members: RoutingMember[] = [];
  const seenKeys = new Set<string>();

  for (const base of baseline.members) {
    if (base.kind === 'provider' && deletedProviderIds.has(base.id)) continue;
    if (base.kind === 'credential' && deletedAuthNames.has(base.id)) continue;
    seenKeys.add(base.key);
    const override = state.routing.memberOverrides[base.key];
    let member: RoutingMember = {
      ...base,
      priority: override?.priority ?? base.priority,
      weights: override?.weights ?? base.weights,
    };
    if (base.kind === 'provider') {
      const p = providerById.get(base.id);
      if (p) {
        member = {
          ...member,
          name: p.name,
          prefix: p.prefix,
          priority: override?.priority ?? p.priority ?? member.priority,
          is_disabled: p.disabled,
          key_count: p.key_entries?.length ?? member.key_count,
        };
      } else if (Object.prototype.hasOwnProperty.call(state.providers.statusOverrides, base.id)) {
        member.is_disabled = state.providers.statusOverrides[base.id];
      }
      if (Object.prototype.hasOwnProperty.call(state.providers.nameOverrides, base.id)) {
        const nextName = state.providers.nameOverrides[base.id];
        if (nextName) member.name = nextName;
      }
    } else if (base.kind === 'credential') {
      const f = authByName.get(base.id);
      if (f) {
        member = {
          ...member,
          name: f.display_name || f.name,
          priority: override?.priority ?? f.priority ?? member.priority,
          is_disabled: f.disabled,
          is_unavailable: f.unavailable,
        };
      } else if (Object.prototype.hasOwnProperty.call(state.authFiles.statusOverrides, base.id)) {
        member.is_disabled = state.authFiles.statusOverrides[base.id];
      }
    }
    members.push(member);
  }

  for (const p of mergedProviders ?? []) {
    const key = `provider:${p.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const override = state.routing.memberOverrides[key];
    members.push({
      key,
      kind: 'provider',
      id: p.id,
      family: p.family,
      name: p.name,
      prefix: p.prefix,
      priority: override?.priority ?? p.priority ?? 0,
      weights: override?.weights ?? (p.key_entries ?? []).map((entry, idx) => ({
        index: idx,
        auth_index: p.auth_indexes?.[idx],
        weight: entry.weight ?? 1,
      })),
      key_count: p.key_entries?.length ?? 1,
      is_disabled: p.disabled,
      is_unavailable: false,
      is_runtime_only: false,
    });
  }

  for (const f of state.authFiles.created) {
    const key = `credential:${f.name}`;
    if (seenKeys.has(key) || deletedAuthNames.has(f.name)) continue;
    seenKeys.add(key);
    const override = state.routing.memberOverrides[key];
    members.push({
      key,
      kind: 'credential',
      id: f.name,
      family: f.provider || f.type || 'oauth',
      oauth_provider: f.oauth_provider,
      name: f.display_name || f.name,
      priority: override?.priority ?? f.priority ?? 0,
      weights: override?.weights ?? [{ index: 0, auth_index: f.auth_index, weight: f.weight ?? 1 }],
      key_count: 1,
      is_disabled: f.disabled,
      is_unavailable: f.unavailable,
      is_runtime_only: false,
    });
  }

  return {
    ...baseline,
    revision: state.routing.revision ?? baseline.revision,
    settings,
    members,
  };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function mergePlugins(baseline: PluginsResponse, state: DemoSandboxState): PluginsResponse {
  const deleted = new Set(state.plugins.deletedIds);
  const pluginsEnabled = state.plugins.settings?.enabled ?? baseline.plugins_enabled;
  const seen = new Set<string>();
  const list: PluginItem[] = [];

  for (const plugin of [...baseline.plugins, ...state.plugins.installed]) {
    if (deleted.has(plugin.id) || seen.has(plugin.id)) continue;
    seen.add(plugin.id);
    const enabled = Object.prototype.hasOwnProperty.call(state.plugins.enabledOverrides, plugin.id)
      ? state.plugins.enabledOverrides[plugin.id]
      : plugin.enabled;
    list.push({
      ...plugin,
      enabled,
      effective_enabled: pluginsEnabled && enabled && plugin.registered,
      configured: plugin.configured || Boolean(state.plugins.configs[plugin.id]),
    });
  }

  return {
    plugins_enabled: pluginsEnabled,
    plugins_dir: state.plugins.settings?.dir ?? baseline.plugins_dir,
    plugins: list,
    total: list.length,
  };
}

function mergePluginStore(baseline: PluginStoreResponse, state: DemoSandboxState, pluginsState?: PluginsResponse): PluginStoreResponse {
  const installedIds = new Set(pluginsState?.plugins.map((p) => p.id) ?? []);
  const installedById = new Map((pluginsState?.plugins ?? []).map((p) => [p.id, p]));
  const deleted = new Set(state.plugins.deletedIds);
  const plugins: StorePluginItem[] = baseline.plugins.map((item) => {
    const isDeleted = deleted.has(item.id) && !installedIds.has(item.id);
    const installedPlugin = installedById.get(item.id);
    if (isDeleted) {
      return {
        ...item,
        installed: false,
        installed_version: undefined,
        effective_enabled: false,
        update_available: false,
      };
    }
    if (installedPlugin) {
      const version = installedPlugin.metadata?.version || item.installed_version || item.version;
      return {
        ...item,
        installed: true,
        installed_version: version,
        effective_enabled: installedPlugin.effective_enabled,
        update_available: Boolean(item.version && version && item.version !== version),
      };
    }
    return item;
  });
  return {
    ...baseline,
    plugins_enabled: state.plugins.settings?.enabled ?? baseline.plugins_enabled,
    plugins_dir: state.plugins.settings?.dir ?? baseline.plugins_dir,
    plugins,
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function mergePricing(baseline: PricingResponse, state: DemoSandboxState): PricingResponse {
  const now = Date.now();
  const modelsMap = new Map(baseline.models.map((m) => [m.model, { ...m }]));
  const unpricedMap = new Map(baseline.unpriced.map((u) => [u.model, { ...u }]));

  for (const [model, override] of Object.entries(state.pricing.modelOverrides)) {
    if (override === null) {
      const prev = modelsMap.get(model);
      modelsMap.delete(model);
      if (prev) {
        unpricedMap.set(model, {
          model,
          usage_30d: prev.usage_30d,
          suggestions: [],
        });
      }
    } else {
      const prevUsage = modelsMap.get(model)?.usage_30d ?? unpricedMap.get(model)?.usage_30d ?? {
        requests: 0,
        priced_requests: 0,
        cost_usd: null,
      };
      unpricedMap.delete(model);
      modelsMap.set(model, {
        ...override,
        usage_30d: prevUsage,
      });
    }
  }

  for (const [model, dismissed] of Object.entries(state.pricing.dismissedCandidates)) {
    const entry = modelsMap.get(model);
    if (entry?.candidate && dismissed.includes(entry.candidate.model.id)) {
      entry.candidate = undefined;
    }
  }

  const channelsMap = new Map(baseline.channels.map((ch) => [ch.channel, { ...ch }]));
  for (const [chName, override] of Object.entries(state.pricing.channelOverrides)) {
    if (override === null) {
      const prev = channelsMap.get(chName);
      if (prev) {
        channelsMap.set(chName, { ...prev, is_configured: false, multiplier: 1, note: '', updated_at_ms: now });
      }
    } else {
      const prev = channelsMap.get(chName);
      channelsMap.set(chName, {
        ...override,
        usage_30d: prev?.usage_30d ?? override.usage_30d,
      });
    }
  }

  const channelModelsMap = new Map((baseline.channel_models ?? []).map((cm) => [`${cm.channel ?? ''}\0${cm.model}`, { ...cm }]));
  for (const [scopeKey, override] of Object.entries(state.pricing.channelModelOverrides ?? {})) {
    if (override === null) {
      channelModelsMap.delete(scopeKey);
    } else {
      channelModelsMap.set(scopeKey, override);
    }
  }

  const models = [...modelsMap.values()];
  const unpriced = [...unpricedMap.values()];
  return {
    ...baseline,
    models,
    unpriced,
    channel_models: [...channelModelsMap.values()],
    channels: [...channelsMap.values()],
    sync: {
      ...baseline.sync,
      state: {
        ...baseline.sync.state,
        auto_sync_interval_hours: state.pricing.syncIntervalHours ?? baseline.sync.state.auto_sync_interval_hours,
        last_success_at_ms: state.pricing.lastSyncedAtMs ?? baseline.sync.state.last_success_at_ms,
        last_matched: models.filter((m) => m.mode !== 'custom').length,
        last_unmatched: unpriced.length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Custom Icons
// ---------------------------------------------------------------------------

function mergeCustomIcons(baseline: { icons: CustomIcon[] }, state: DemoSandboxState): { icons: CustomIcon[] } {
  const deleted = new Set(state.customIcons.deletedIds);
  const icons = [...baseline.icons, ...state.customIcons.created]
    .filter((icon) => !deleted.has(icon.id))
    .map((icon) => {
      const patch = state.customIcons.updated[icon.id];
      return patch ? { ...icon, ...patch } : icon;
    });
  return { icons };
}

function decodeBase64Bytes(encoded: string): Uint8Array | null {
  try {
    if (typeof atob !== 'function') return null;
    const bin = atob(encoded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function sniffIconMimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG signature: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP signature: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // SVG text check
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
    if (text.startsWith('<svg') || (text.startsWith('<') && /<svg[\s>]/i.test(text))) {
      if (/<\s*script|<\s*foreignObject|\bon[a-z]+\s*=|javascript:/i.test(text)) return null;
      return 'image/svg+xml';
    }
  } catch {
    return null;
  }
  return null;
}

function validateCustomIconData(raw: string): { mime_type: string; data_url: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('<svg')) {
    if (/<\s*script|<\s*foreignObject|\bon[a-z]+\s*=|javascript:/i.test(trimmed)) return null;
    const encoded = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(trimmed))) : '';
    if (!encoded) return null;
    return { mime_type: 'image/svg+xml', data_url: `data:image/svg+xml;base64,${encoded}` };
  }
  let declaredMime = '';
  let base64Payload = trimmed;
  if (trimmed.toLowerCase().startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
    if (!match) return null;
    declaredMime = match[1].toLowerCase();
    base64Payload = match[2].replace(/\s+/g, '');
  } else if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return null;
  } else {
    base64Payload = trimmed.replace(/\s+/g, '');
  }
  const bytes = decodeBase64Bytes(base64Payload);
  if (!bytes || bytes.length > 512 * 1024) return null;
  const detectedMime = sniffIconMimeFromBytes(bytes);
  if (!detectedMime) return null;
  if (declaredMime && declaredMime !== detectedMime) return null;
  return { mime_type: detectedMime, data_url: `data:${detectedMime};base64,${base64Payload}` };
}

// ---------------------------------------------------------------------------
// Main interceptor
// ---------------------------------------------------------------------------

export async function interceptDemoRequest(
  cleanPathWithQuery: string,
  options: RequestInit,
  fetchBaseline: FetchBaselineFn,
): Promise<Response | null> {
  const state = loadState();
  const method = (options.method ?? 'GET').toUpperCase();
  const parsedUrl = new URL(cleanPathWithQuery, 'https://demo.local');
  // Strip /api/v1 prefix if caller passed a full path.
  const pathname = parsedUrl.pathname.replace(/^\/api\/v1(?=\/|$)/, '') || '/';
  const search = parsedUrl.search;
  const pathWithQuery = `${pathname}${search}`;

  // ── 1. Reads (GET / HEAD) ─────────────────────────────────────────────────
  if (method === 'GET' || method === 'HEAD') {
    // Sandbox-created custom icon SVG/image bytes
    const iconContentMatch = /^\/custom-icons\/([^/]+)\/content$/.exec(pathname);
    if (iconContentMatch) {
      const iconId = decodeURIComponent(iconContentMatch[1]);
      const dataUrl = state.customIcons.dataUrls[iconId];
      if (dataUrl) {
        const res = await fetch(dataUrl);
        return res;
      }
      return fetchBaseline(pathWithQuery, options);
    }

    // Custom icons metadata
    if (pathname === '/custom-icons') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<{ icons: CustomIcon[] }>('custom-icons', res);
      return jsonResponse(mergeCustomIcons(base, state));
    }

    // Fonts
    if (pathname === '/fonts') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<{ fonts: InstalledFont[] }>('fonts', res);
      const deleted = new Set(state.fonts.deletedIds);
      return jsonResponse({ fonts: base.fonts.filter((f) => !deleted.has(f.id)) });
    }

    // Preferences
    if (pathname === '/preferences') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<{ preferences?: Record<string, unknown>; time_zone?: { server_timezone: string } }>('preferences', res);
      return jsonResponse({
        ...base,
        preferences: { ...(base.preferences ?? {}), ...state.preferences },
      });
    }

    // API Keys
    if (pathname === '/management/api-keys') {
      const includeKeys = parsedUrl.searchParams.get('include_keys') === 'true';
      const baseRes = await fetchBaseline('/management/api-keys?include_keys=true', { method: 'GET' });
      if (!baseRes.ok) return baseRes;
      const base = await readBaselineJson<{ keys: ClientAPIKeyItem[]; total: number }>('api-keys-with-keys', baseRes);
      return jsonResponse(mergeApiKeys(base, state, includeKeys));
    }

    // Providers
    if (pathname === '/management/providers') {
      const includeKeys = parsedUrl.searchParams.get('include_keys') === 'true';
      const baseRes = await fetchBaseline('/management/providers?include_keys=true', { method: 'GET' });
      if (!baseRes.ok) return baseRes;
      const base = await readBaselineJson<{ providers: ProviderItem[]; total: number }>('providers-with-keys', baseRes);
      return jsonResponse(mergeProviders(base, state, includeKeys));
    }

    // Config & Config Source & Config Backups
    if (pathname === '/management/config') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<ConfigScalarsResponse>('config', res);
      return jsonResponse({
        ...base,
        scalars: state.config.scalars ?? base.scalars,
        revision: state.config.revision ?? base.revision,
        safe_yaml: state.config.safeYaml ?? base.safe_yaml,
      });
    }

    if (pathname === '/management/config/source') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<ConfigSourceResponse>('config-source', res);
      const yaml = state.config.yaml ?? base.yaml;
      return jsonResponse({
        yaml,
        size_bytes: new TextEncoder().encode(yaml).byteLength,
        revision: state.config.revision ?? base.revision,
      });
    }

    if (pathname === '/management/config/backups') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<ConfigBackupList>('config-backups', res);
      return jsonResponse({
        backups: state.config.backups ?? base.backups,
        settings: {
          ...base.settings,
          retention: state.config.backupRetention ?? base.settings.retention,
        },
      });
    }

    const backupDetailMatch = /^\/management\/config\/backups\/(\d+)$/.exec(pathname);
    if (backupDetailMatch) {
      const backupId = Number(backupDetailMatch[1]);
      if (state.config.backupYamlById[backupId] !== undefined) {
        const list = await ensureConfigBackups(state, fetchBaseline);
        const backup = list.backups.find((b) => b.id === backupId);
        if (backup) {
          return jsonResponse({ backup, yaml: state.config.backupYamlById[backupId] });
        }
      }
      const res = await fetchBaseline(pathWithQuery, options);
      if (res.ok) return res;
      const { sourceRes } = await ensureConfigState(state, fetchBaseline);
      const list = await ensureConfigBackups(state, fetchBaseline);
      const backup = list.backups.find((b) => b.id === backupId);
      if (!backup) return errorResponse('backup not found', 'not_found', 404);
      return jsonResponse({ backup, yaml: sourceRes.yaml });
    }

    // Auth files & OAuth rules & OAuth session status
    if (pathname === '/management/auth-files') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<ManagementAuthFilesResponse>('auth-files', res);
      return jsonResponse(mergeAuthFiles(base, state));
    }

    if (pathname === '/management/auth-files/safe-fields') {
      const name = parsedUrl.searchParams.get('name') ?? '';
      const authFiles = await ensureBaseline<ManagementAuthFilesResponse>('auth-files', '/management/auth-files', fetchBaseline);
      const merged = authFiles ? mergeAuthFiles(authFiles, state) : null;
      const file = merged?.files.find((f) => f.name === name);
      const res = await fetchBaseline(pathWithQuery, options);
      if (res.ok) {
        const base = (await res.json()) as ManagementAuthFileSafeFields;
        const overlay = state.authFiles.safeFieldsOverrides[name];
        const siwc = state.authFiles.siwcOverrides[name];
        return jsonResponse({
          ...base,
          ...(overlay ?? {}),
          ...(siwc?.use_siwc !== undefined ? { use_siwc: siwc.use_siwc } : {}),
        });
      }
      if (file) {
        return jsonResponse({
          ...defaultSafeFieldsFor(file),
          ...(state.authFiles.safeFieldsOverrides[name] ?? {}),
        });
      }
      return res;
    }

    if (pathname === '/management/auth-files/models') {
      const name = parsedUrl.searchParams.get('name') ?? '';
      const created = state.authFiles.created.find((f) => f.name === name);
      if (created?.models?.length) {
        return jsonResponse({ models: created.models });
      }
      const res = await fetchBaseline(pathWithQuery, options);
      if (res.ok) return res;
      return jsonResponse({ models: [] satisfies ManagementAuthFileModel[] });
    }

    if (pathname === '/management/auth-files/model-aliases') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<ManagementOAuthModelAliasesResponse>('auth-files-model-aliases', res);
      return jsonResponse({
        aliases: {
          ...base.aliases,
          ...(state.authFiles.modelAliases ?? {}),
        },
      });
    }

    if (pathname === '/management/auth-files/excluded-models') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<ManagementOAuthExcludedModelsResponse>('auth-files-excluded-models', res);
      return jsonResponse({
        excluded_models: {
          ...base.excluded_models,
          ...(state.authFiles.excludedModels ?? {}),
        },
      });
    }

    if (pathname === '/management/oauth/status') {
      const id = parsedUrl.searchParams.get('state') || parsedUrl.searchParams.get('session_id') || '';
      const session = oauthSessions.get(id);
      if (session) {
        if (session.status === 'waiting' && session.flow === 'device' && Date.now() - session.createdAtMs > 1800) {
          session.status = 'success';
          if (session.recoveryTarget) {
            state.authFiles.recoveredNames[session.recoveryTarget.name] = {
              refreshedAt: new Date().toISOString(),
              verified: session.recoveryTarget.verify === true,
            };
          } else {
            const idx = state.authFiles.created.length + 1;
            const name = `${session.provider}-sandbox-${idx}.json`;
            if (!state.authFiles.created.some((f) => f.name === name)) {
              state.authFiles.created.push({
                name,
                auth_index: `auth-${session.provider}-sbx-${idx}`,
                type: 'oauth',
                provider: session.provider,
                email: `sandbox-${idx}@acme-labs.example`,
                status: 'ready',
                disabled: false,
                unavailable: false,
                runtime_only: false,
                success: 0,
                failed: 0,
                priority: 5,
                weight: 2,
                renewal_state: 'renewal_verified',
                recovery_stage: 'renewal_verified',
                renewal_verified: true,
                inference_verified: true,
                access_token_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                note: 'Connected via Demo Sandbox OAuth',
                models: simulatedModelsForProvider(session.provider).map((m) => ({ id: m, display_name: m })),
              });
              recordSandboxAudit(state, 'oauth.connect_sandbox', 'oauth_provider', session.provider, { name });
              saveState(state);
            }
          }
        }
        return jsonResponse({
          status: session.status,
          ...(session.status === 'error' ? { error: 'Sandbox authorization cancelled' } : {}),
        });
      }
      return fetchBaseline(pathWithQuery, options);
    }

    if (pathname === '/management/oauth/siwc/status') {
      const id = parsedUrl.searchParams.get('state') || '';
      const session = siwcSessions.get(id);
      if (session) {
        if (session.status === 'ok') {
          const authRes = await ensureBaseline<ManagementAuthFilesResponse>('auth-files', '/management/auth-files', fetchBaseline);
          const file = authRes
            ? mergeAuthFiles(authRes, state).files.find((f) => f.name === session.name)
            : undefined;
          return jsonResponse({ status: 'ok', url: session.url, file });
        }
        return jsonResponse({ status: session.status, url: session.url });
      }
      return jsonResponse({ status: 'idle' });
    }

    // Routing
    if (pathname === '/management/routing') {
      const [res, provRes, authRes] = await Promise.all([
        fetchBaseline(pathWithQuery, options),
        ensureBaseline<{ providers: ProviderItem[]; total: number }>('providers-with-keys', '/management/providers?include_keys=true', fetchBaseline),
        ensureBaseline<ManagementAuthFilesResponse>('auth-files', '/management/auth-files', fetchBaseline),
      ]);
      if (!res.ok) return res;
      const base = await readBaselineJson<RoutingBoard>('routing', res);
      const providers = provRes ? mergeProviders(provRes, state, false).providers : undefined;
      const authFiles = authRes ? mergeAuthFiles(authRes, state).files : undefined;
      return jsonResponse(mergeRoutingBoard(base, state, providers, authFiles));
    }

    if (pathname === '/management/routing/models') {
      const [res, provRes, authRes] = await Promise.all([
        fetchBaseline(pathWithQuery, options),
        ensureBaseline<{ providers: ProviderItem[]; total: number }>('providers-with-keys', '/management/providers?include_keys=true', fetchBaseline),
        ensureBaseline<ManagementAuthFilesResponse>('auth-files', '/management/auth-files', fetchBaseline),
      ]);
      if (!res.ok) return res;
      const base = await readBaselineJson<RoutingModels>('routing-models', res);
      const models = { ...base.models };
      if (provRes) {
        for (const p of mergeProviders(provRes, state, false).providers) {
          models[`provider:${p.id}`] = p.models ?? [];
        }
      }
      if (authRes) {
        for (const f of mergeAuthFiles(authRes, state).files) {
          if (f.models?.length) {
            models[`credential:${f.name}`] = f.models.map((m) => m.id);
          }
        }
      }
      return jsonResponse({ ...base, models });
    }

    // Plugins
    if (pathname === '/management/plugins') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<PluginsResponse>('plugins', res);
      return jsonResponse(mergePlugins(base, state));
    }

    if (pathname === '/management/plugins/settings') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<PluginSettings>('plugins-settings', res);
      return jsonResponse(state.plugins.settings ?? base);
    }

    if (pathname === '/management/plugin-store') {
      const [res, pluginsBase] = await Promise.all([
        fetchBaseline(pathWithQuery, options),
        ensureBaseline<PluginsResponse>('plugins', '/management/plugins', fetchBaseline),
      ]);
      if (!res.ok) return res;
      const base = await readBaselineJson<PluginStoreResponse>('plugin-store', res);
      const pluginsState = pluginsBase ? mergePlugins(pluginsBase, state) : undefined;
      return jsonResponse(mergePluginStore(base, state, pluginsState));
    }

    const pluginConfigMatch = /^\/management\/plugins\/([^/]+)\/config$/.exec(pathname);
    if (pluginConfigMatch) {
      const pluginId = decodeURIComponent(pluginConfigMatch[1]);
      if (state.plugins.configs[pluginId]) {
        return jsonResponse({ id: pluginId, config: state.plugins.configs[pluginId] } satisfies PluginConfigResponse);
      }
      const res = await fetchBaseline(pathWithQuery, options);
      if (res.ok) return res;
      return jsonResponse({ id: pluginId, config: {} } satisfies PluginConfigResponse);
    }

    // Pricing
    if (pathname === '/pricing') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<PricingResponse>('pricing', res);
      return jsonResponse(mergePricing(base, state));
    }

    if (pathname === '/pricing/attention') {
      const [res, pricingBase] = await Promise.all([
        fetchBaseline(pathWithQuery, options),
        ensureBaseline<PricingResponse>('pricing', '/pricing', fetchBaseline),
      ]);
      if (!res.ok) return res;
      const base = await readBaselineJson<PricingAttention>('pricing-attention', res);
      if (pricingBase) {
        const merged = mergePricing(pricingBase, state);
        return jsonResponse({
          ...base,
          unpriced: merged.unpriced.map((u) => u.model),
          candidates: merged.models.filter((m) => Boolean(m.candidate)).length,
        });
      }
      return jsonResponse(base);
    }

    const pricingModelMatch = /^\/pricing\/models\/(.+)$/.exec(pathname);
    if (pricingModelMatch && !pathname.endsWith('/dismiss-candidate')) {
      const model = decodeURIComponent(pricingModelMatch[1]);
      const channel = (parsedUrl.searchParams.get('channel') ?? '').trim();
      const channelKey = channel ? `${channel}\0${model}` : '';
      const override = channel
        ? state.pricing.channelModelOverrides?.[channelKey]
        : state.pricing.modelOverrides[model];
      const res = await fetchBaseline(pathWithQuery, options);
      if (res.ok) {
        const base = (await res.json()) as PricingModelDetail;
        const dismissed = state.pricing.dismissedCandidates[model] ?? [];
        const fallbackGlobal = channel ? state.pricing.modelOverrides[model] : undefined;
        const resolvedPrice = override !== undefined
          ? override
          : (channel && base.is_inherited && fallbackGlobal !== undefined ? fallbackGlobal : base.price);
        return jsonResponse({
          ...base,
          ...(channel ? { channel, is_inherited: override === undefined } : {}),
          price: resolvedPrice,
          candidate: base.candidate && !dismissed.includes(base.candidate.model.id) ? base.candidate : null,
        });
      }
      if (override !== undefined) {
        return jsonResponse({
          model,
          ...(channel ? { channel, is_inherited: false } : {}),
          price: override,
          automatic: null,
          candidate: null,
          suggestions: [],
          reference_prices: [],
          versions: [],
          profile: { samples: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, max_input: 0 },
        } satisfies PricingModelDetail);
      }
      return res;
    }

    // Sandbox download & diagnostic endpoints
    if (pathname === '/management/auth-files/download') {
      const name = parsedUrl.searchParams.get('name') ?? '';
      const authRes = await ensureBaseline<ManagementAuthFilesResponse>('auth-files', '/management/auth-files', fetchBaseline);
      const merged = authRes ? mergeAuthFiles(authRes, state) : null;
      const file = merged?.files.find((f) => f.name === name);
      if (!file) return errorResponse('Credential not found', 'not_found', 404);
      const doc = {
        sandbox_export: true,
        note: 'Redacted demo sandbox credential document; real tokens are never included in the public demo.',
        name: file.name,
        provider: file.provider ?? file.type ?? 'oauth',
        auth_index: file.auth_index,
        email: file.email ?? 'sandbox@acme-labs.example',
        status: file.status,
        disabled: file.disabled,
        priority: file.priority,
        weight: file.weight,
        models: file.models ?? [],
      };
      return new Response(JSON.stringify(doc, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-OMCPA-Demo': 'active',
          'X-OMCPA-Demo-Sandbox': 'browser',
        },
      });
    }

    if (pathname === '/management/system/diagnostics') {
      const sysRes = await ensureBaseline<SystemInfoResponse>('system', '/management/system', fetchBaseline);
      const bundle = {
        generated_at: new Date().toISOString(),
        sandbox: true,
        sandbox_changes: countDemoSandboxChanges(state),
        system: sysRes,
        audit_events_added: state.auditTrail.length,
      };
      return new Response(JSON.stringify(bundle, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-OMCPA-Demo': 'active',
          'X-OMCPA-Demo-Sandbox': 'browser',
        },
      });
    }

    if (pathname === '/management/system/database-backup-automation') {
      const now = Date.now();
      const stored: BackupAutomation = state.system.dbBackupAutomation ?? {
        enabled: true,
        daily_at_minute: 180,
        keep_local: 14,
        keep_remote: 14,
        has_passphrase: true,
        destinations: [{ id: 'dest-s3-1', name: 'Primary S3 Archive', provider: 's3', root: 'omc-backups', has_config: true }],
        next_run_at_ms: now + 18 * 3_600_000,
        last_run_at_ms: now - 6 * 3_600_000,
        last_success_at_ms: now - 6 * 3_600_000,
        last_error: '',
      };
      return jsonResponse(stored);
    }

    if (pathname === '/management/system/database-backups') {
      const now = Date.now();
      const items: DatabaseBackupJob[] = state.system.dbBackupJobs ?? [
        {
          id: 'backup-demo-01',
          kind: 'automatic',
          state: 'completed',
          created_at_ms: now - 6 * 3_600_000,
          expires_at_ms: now + 14 * 86_400_000,
          size_bytes: 18_420_000,
          digest: 'sha256:9f82c1e0b4a7d6f2',
          source_version: 'v0.3.26',
          source_schema_version: 20261110,
          backup_created_at_ms: now - 6 * 3_600_000,
          has_audit_error: false,
        },
      ];
      return jsonResponse({ items });
    }

    const dbBackupDownloadMatch = /^\/management\/system\/database-backups\/([^/]+)\/download$/.exec(pathname);
    if (dbBackupDownloadMatch) {
      const jobId = decodeURIComponent(dbBackupDownloadMatch[1]);
      const job = (state.system.dbBackupJobs ?? []).find((j) => j.id === jobId);
      if (!job) return errorResponse('Database backup not found', 'not_found', 404);
      const payload = JSON.stringify({
        sandbox_export: true,
        job_id: job.id,
        digest: job.digest,
        created_at_ms: job.created_at_ms,
        source_version: job.source_version,
        note: 'Redacted OMC demo sandbox backup export archive.',
      }, null, 2);
      return new Response(payload, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-OMCPA-Demo': 'active',
          'X-OMCPA-Demo-Sandbox': 'browser',
        },
      });
    }

    // Quota & Warmup
    if (pathname === '/management/quota') {
      const [res, authRes] = await Promise.all([
        fetchBaseline(pathWithQuery, options),
        ensureBaseline<ManagementAuthFilesResponse>('auth-files', '/management/auth-files', fetchBaseline),
      ]);
      if (!res.ok) return res;
      const base = await readBaselineJson<QuotaOverviewResponse>('quota', res);
      const deleted = new Set(state.authFiles.deletedNames);
      const authByIndex = new Map((authRes ? mergeAuthFiles(authRes, state).files : []).map((f) => [f.auth_index, f]));
      const quotas = base.quotas
        .filter((q) => !deleted.has(q.name))
        .map((q) => {
          const auth = authByIndex.get(q.auth_index);
          const refreshedAt = state.quota.refreshedAt[q.auth_index];
          const clearedAt = state.quota.clearedCooldowns[q.auth_index];
          const resetAt = state.quota.resetAt[q.auth_index];
          const redeemed = state.quota.redeemedCredits[q.auth_index] ?? 0;
          let next = {
            ...q,
            disabled: auth ? auth.disabled : q.disabled,
            observed_at_ms: refreshedAt ? Math.max(q.observed_at_ms, refreshedAt) : q.observed_at_ms,
          };
          if (clearedAt) {
            next.active_cooldown = undefined;
            next.quota_exceeded = false;
          }
          if (resetAt) {
            next.windows = next.windows.map((w) => ({ ...w, used_percent: 0, remaining_percent: 100 }));
          }
          if (redeemed > 0 && next.reset_credits) {
            next.windows = next.windows.map((w) => ({ ...w, used_percent: 0, remaining_percent: 100 }));
            next.active_cooldown = undefined;
            next.quota_exceeded = false;
            next.reset_credits = {
              ...next.reset_credits,
              available_count: Math.max(0, next.reset_credits.available_count - redeemed),
            };
          }
          return next;
        });
      return jsonResponse({ ...base, quotas });
    }

    if (pathname === '/management/quota/warmup/settings') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = await readBaselineJson<WarmupStateView>('warmup-settings', res);
      const tasks = state.quota.warmupTasks ?? base.tasks;
      const clearedBefore = state.quota.warmupRunsClearedAtMs ?? 0;
      const runs = [
        ...state.quota.warmupRunsAdded,
        ...base.runs.filter((r) => Date.parse(r.at) > clearedBefore),
      ];
      return jsonResponse({ ...base, tasks, runs });
    }

    // Usage routing (apply cleared cooldowns so clearing cooldown on Quota/OAuth reflects live!)
    if (pathname === '/usage/routing') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = (await res.json()) as UsageRoutingResponse;
      const now = Date.now();
      const cooldowns = base.cooldowns.filter((c) => {
        const clearedAt = state.quota.clearedCooldowns[c.auth_index];
        return !clearedAt || now - clearedAt > 120_000;
      });
      return jsonResponse({ ...base, cooldowns });
    }

    // Audit trail (prepend sandbox operations)
    if (pathname === '/management/audit/events') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = (await res.json()) as { events: AuditEvent[]; next_cursor?: string };
      if (state.auditTrail.length === 0 || parsedUrl.searchParams.has('before')) {
        return jsonResponse(base);
      }
      const q = (parsedUrl.searchParams.get('q') ?? '').trim().toLowerCase();
      const categories = parsedUrl.searchParams.getAll('category').flatMap((v) => v.split(',')).filter(Boolean);
      const outcome = parsedUrl.searchParams.get('outcome') ?? '';
      const filteredLocal = state.auditTrail.filter((ev) => {
        if (outcome && outcome !== 'all' && outcome !== 'succeeded') return false;
        if (categories.length > 0 && !categories.some((c) => ev.action === c || ev.action.startsWith(`${c}.`))) return false;
        if (q && ![ev.action, ev.target_type, ev.target_id, ev.request_id].some((f) => f.toLowerCase().includes(q))) return false;
        return true;
      });
      return jsonResponse({
        ...base,
        events: [...filteredLocal, ...base.events],
      });
    }

    if (pathname === '/management/audit/export') {
      const res = await fetchBaseline('/management/audit/events', { method: 'GET' });
      if (!res.ok) return res;
      const base = (await res.json()) as { events: AuditEvent[] };
      const combined = [...state.auditTrail, ...base.events];
      return new Response(JSON.stringify({ exported_at: new Date().toISOString(), events: combined }, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-OMCPA-Demo': 'active',
          'X-OMCPA-Demo-Sandbox': 'browser',
        },
      });
    }

    if (pathname === '/management/audit/summary') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = (await res.json()) as { buckets: AuditBucket[] };
      if (state.auditTrail.length === 0) return jsonResponse(base);
      const map = new Map(base.buckets.map((b) => [`${b.prefix}\0${b.outcome}`, { ...b }]));
      for (const ev of state.auditTrail) {
        const dot = ev.action.indexOf('.');
        const prefix = dot > 0 ? ev.action.slice(0, dot) : ev.action;
        const key = `${prefix}\0succeeded`;
        const existing = map.get(key);
        if (existing) existing.count += 1;
        else map.set(key, { prefix, outcome: 'succeeded', count: 1 });
      }
      return jsonResponse({ buckets: [...map.values()] });
    }

    // Logs & Logs Status
    if (pathname === '/management/logs/status') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = (await res.json()) as { logging_to_file: boolean; request_log: boolean };
      return jsonResponse({
        logging_to_file: state.config.scalars?.logging_to_file ?? base.logging_to_file,
        request_log: state.config.scalars?.request_log ?? base.request_log,
      });
    }

    if (pathname === '/management/logs') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = (await res.json()) as { lines: string[]; latest_after: number; next_cursor: string; cursor_reset: boolean; limit: number };
      const cleared = state.system.logsClearedAtMs;
      const lines = cleared
        ? [...state.extraLogLines]
        : [...state.extraLogLines, ...base.lines];
      return jsonResponse({ ...base, lines });
    }

    const requestErrorLogMatch = /^\/management\/request-error-logs\/([^/]+)$/.exec(pathname);
    if (requestErrorLogMatch) {
      const name = decodeURIComponent(requestErrorLogMatch[1]);
      const body = [
        `=== OMC Demo Sandbox Error Log ===`,
        `File: ${name}`,
        `Generated: ${new Date().toISOString()}`,
        `Upstream: codex (auth_index=auth-codex-02)`,
        `Model: gpt-6.1-sol`,
        `Status: 429 Too Many Requests`,
        ``,
        `--- Request Headers (Redacted) ---`,
        `POST /v1/responses HTTP/1.1`,
        `Authorization: Bearer [REDACTED]`,
        `Content-Type: application/json`,
        `User-Agent: codex-cli/0.41.0`,
        ``,
        `--- Upstream Response ---`,
        `HTTP/2 429`,
        `retry-after: 28`,
        `x-ratelimit-remaining-requests: 0`,
        `{"error":{"message":"Rate limit reached for gpt-6.1-sol on primary seat; gateway rerouted attempt #2 to auth-codex-01.","type":"rate_limit_exceeded"}}`,
      ].join('\n');
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-OMCPA-Demo': 'active',
          'X-OMCPA-Demo-Sandbox': 'browser',
        },
      });
    }

    const requestLogByIdMatch = /^\/management\/request-logs\/([^/]+)$/.exec(pathname);
    if (requestLogByIdMatch) {
      const requestId = decodeURIComponent(requestLogByIdMatch[1]);
      const body = [
        `=== OMC Demo Sandbox Request Log ===`,
        `Request-ID: ${requestId}`,
        `Timestamp: ${new Date().toISOString()}`,
        `Gateway: CLIProxyAPI v8 (demo sandbox trace)`,
        ``,
        `--- Request (Redacted) ---`,
        `POST /v1/responses`,
        `Authorization: Bearer [REDACTED]`,
        `X-Request-Id: ${requestId}`,
        `{"model":"gpt-6-luna","stream":true,"reasoning":{"effort":"medium"},"input":"[redacted in public demo]"}`,
        ``,
        `--- Response Summary ---`,
        `HTTP/2 200 OK`,
        `x-resolved-provider: codex`,
        `x-auth-index: auth-codex-01`,
        `content-type: text/event-stream`,
        `[stream completed cleanly in sandbox capture]`,
      ].join('\n');
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-OMCPA-Demo': 'active',
          'X-OMCPA-Demo-Sandbox': 'browser',
        },
      });
    }

    const usageEventLogMatch = /^\/usage\/events\/(\d+)\/request-log$/.exec(pathname);
    if (usageEventLogMatch) {
      const eventId = usageEventLogMatch[1];
      let ev: Record<string, unknown> | undefined;
      try {
        const detailRes = await fetchBaseline(`/usage/events/${eventId}`, { method: 'GET' });
        if (detailRes.ok) {
          const detail = (await detailRes.json()) as { event?: Record<string, unknown> };
          ev = detail.event;
        }
      } catch {
        // Fallback to minimal trace below.
      }
      const reqId = typeof ev?.request_id === 'string' && ev.request_id ? ev.request_id : `req_demo_${eventId}`;
      const model = typeof ev?.model === 'string' && ev.model ? ev.model : 'deepseek-v4.1-flash-1017';
      const provider = typeof ev?.provider === 'string' && ev.provider ? ev.provider : 'antigravity';
      const endpoint = typeof ev?.endpoint === 'string' && ev.endpoint ? ev.endpoint : '/v1/chat/completions';
      const latency = typeof ev?.latency_ms === 'number' ? ev.latency_ms : 1420;
      const body = [
        `=== OMC Demo Sandbox Request Trace ===`,
        `Event-ID: ${eventId}`,
        `Request-ID: ${reqId}`,
        `Model: ${model}`,
        `Provider: ${provider}`,
        `Endpoint: ${endpoint}`,
        `Latency: ${latency} ms`,
        ``,
        `--- Request (Redacted) ---`,
        `Authorization: Bearer [REDACTED]`,
        `{"model":"${model}","stream":true,"messages":[{"role":"user","content":"[redacted in public demo]"}]}`,
        ``,
        `--- Response Summary ---`,
        `Status: ${ev?.failed ? '429/Error' : '200 OK'}`,
        `Response-Model: ${typeof ev?.response_model === 'string' && ev.response_model ? ev.response_model : model}`,
      ].join('\n');
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-OMCPA-Demo': 'active',
          'X-OMCPA-Demo-Sandbox': 'browser',
        },
      });
    }

    // Outbound proxy & Data retention & System
    if (pathname === '/management/outbound-proxy') {
      if (state.system.outboundProxy) return jsonResponse(state.system.outboundProxy);
      return fetchBaseline(pathWithQuery, options);
    }

    if (pathname === '/management/system/data-retention') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = (await res.json()) as DataRetentionResponse;
      if (state.system.dataRetentionDays !== undefined) {
        return jsonResponse({ ...base, request_record_days: state.system.dataRetentionDays });
      }
      return jsonResponse(base);
    }

    if (pathname === '/management/system') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = (await res.json()) as SystemInfoResponse;
      if (state.system.lastUpdateCheckAtMs) {
        return jsonResponse({
          ...base,
          omc_version: base.omc_version ? { ...base.omc_version, checked_at_ms: state.system.lastUpdateCheckAtMs } : base.omc_version,
        });
      }
      return jsonResponse(base);
    }

    if (pathname === '/management/system/maintenance') {
      const res = await fetchBaseline(pathWithQuery, options);
      if (!res.ok) return res;
      const base = (await res.json()) as SystemMaintenanceResponse;
      if (state.system.lastMaintenanceAtMs) {
        return jsonResponse({
          ...base,
          last_run_at_ms: state.system.lastMaintenanceAtMs,
          state: 'idle',
        });
      }
      return jsonResponse(base);
    }

    // Model Square & Playground Models (keep in sync with provider & alias edits!)
    if (pathname === '/management/model-square') {
      const [res, provRes, authRes] = await Promise.all([
        fetchBaseline(pathWithQuery, options),
        ensureBaseline<{ providers: ProviderItem[]; total: number }>('providers-with-keys', '/management/providers?include_keys=true', fetchBaseline),
        ensureBaseline<ManagementAuthFilesResponse>('auth-files', '/management/auth-files', fetchBaseline),
      ]);
      if (!res.ok) return res;
      const base = await readBaselineJson<ModelSquareDirectory>('model-square', res);
      if (!provRes && !authRes) return jsonResponse(base);
      const providers = provRes ? mergeProviders(provRes, state, false).providers : [];
      const authFiles = authRes ? mergeAuthFiles(authRes, state).files : [];
      const routes: ModelSquareRoute[] = [];
      const modelsSet = new Set<string>();
      for (const p of providers) {
        if (p.disabled) continue;
        for (const entry of p.model_entries ?? []) {
          const cp = entry.alias || entry.name;
          modelsSet.add(cp);
          routes.push({ provider_id: p.id, upstream_model: entry.name, call_point: cp });
        }
      }
      for (const f of authFiles) {
        if (f.disabled || f.unavailable) continue;
        for (const m of f.models ?? []) {
          modelsSet.add(m.id);
          routes.push({ provider_id: `credential:${f.name}`, upstream_model: m.id, call_point: m.id });
        }
      }
      // Keep base entries for providers not deleted, and add new ones from sandbox providers.
      const activeIds = new Set([...providers.filter((p) => !p.disabled).map((p) => p.id), ...authFiles.filter((f) => !f.disabled).map((f) => `credential:${f.name}`)]);
      const baseRoutes = base.routes.filter((r) => activeIds.has(r.provider_id));
      const routeKey = (r: ModelSquareRoute) => `${r.provider_id}\0${r.upstream_model}\0${r.call_point}`;
      const mergedRoutesMap = new Map<string, ModelSquareRoute>();
      for (const r of [...baseRoutes, ...routes]) mergedRoutesMap.set(routeKey(r), r);
      const mergedRoutes = [...mergedRoutesMap.values()];
      const callPoints = new Set(mergedRoutes.map((r) => r.call_point).filter((cp): cp is string => Boolean(cp)));
      const modelMap = new Map(
        base.models.filter((m) => m.call_point && callPoints.has(m.call_point)).map((m) => [m.call_point!, m]),
      );
      for (const cp of callPoints) {
        if (!modelMap.has(cp)) modelMap.set(cp, { id: cp, call_point: cp, vision: 'unknown' });
      }
      return jsonResponse({
        ...base,
        routes: mergedRoutes,
        models: [...modelMap.values()].sort((a, b) => (a.call_point ?? a.id).localeCompare(b.call_point ?? b.id)),
      });
    }

    if (pathname === '/management/state') {
      const [res, provRes, authRes, keysRes] = await Promise.all([
        fetchBaseline(pathWithQuery, options),
        ensureBaseline<{ providers: ProviderItem[]; total: number }>('providers-with-keys', '/management/providers?include_keys=true', fetchBaseline),
        ensureBaseline<ManagementAuthFilesResponse>('auth-files', '/management/auth-files', fetchBaseline),
        ensureBaseline<{ keys: ClientAPIKeyItem[]; total: number }>('api-keys-with-keys', '/management/api-keys?include_keys=true', fetchBaseline),
      ]);
      if (!res.ok) return res;
      const base = await readBaselineJson<StateEnvelope<SafeProjectedStateSnapshot>>('management-state', res);
      const providers = provRes ? mergeProviders(provRes, state, false).providers : undefined;
      const authFiles = authRes ? mergeAuthFiles(authRes, state).files : undefined;
      const clientKeys = keysRes ? mergeApiKeys(keysRes, state, false).keys : undefined;
      return jsonResponse({
        version: base.version + state.revisionSeq,
        data: {
          ...base.data,
          revision: state.config.revision ?? base.data.revision,
          scalars: state.config.scalars ?? base.data.scalars,
          client_keys_total: clientKeys ? clientKeys.length : base.data.client_keys_total,
          provider_statuses: providers
            ? providers.map((p) => ({ id: p.id, family: p.family, disabled: p.disabled }))
            : base.data.provider_statuses,
          auth_file_statuses: authFiles
            ? authFiles.map((f) => ({ name: f.name, auth_index: f.auth_index, disabled: f.disabled }))
            : base.data.auth_file_statuses,
          oauth_model_aliases: state.authFiles.modelAliases
            ? { ...base.data.oauth_model_aliases, ...state.authFiles.modelAliases }
            : base.data.oauth_model_aliases,
          oauth_excluded_models: state.authFiles.excludedModels
            ? { ...base.data.oauth_excluded_models, ...state.authFiles.excludedModels }
            : base.data.oauth_excluded_models,
        },
      });
    }

    return null;
  }

  // ── 2. Mutations (POST / PUT / PATCH / DELETE) ────────────────────────────

  // Preferences
  const prefMatch = /^\/preferences\/([^/]+)$/.exec(pathname);
  if (prefMatch && method === 'PUT') {
    const key = decodeURIComponent(prefMatch[1]);
    const val = parseJsonBody<unknown>(options);
    state.preferences[key] = val;
    saveState(state);
    return jsonResponse({ status: 'ok', key, value: val });
  }

  // Client API keys & aliases
  if (pathname === '/management/api-keys' && method === 'POST') {
    const body = parseJsonBody<{ key?: string }>(options);
    const key = (body?.key ?? '').trim();
    if (!key) return errorResponse('API key cannot be empty', 'invalid_request', 400);
    const items = await ensureApiKeyEntries(state, fetchBaseline);
    const derived = deriveKeyFingerprints(key);
    if (items.some((item) => item.fingerprint === derived.fingerprint || item.key === key)) {
      return errorResponse('API key already exists', 'resource_conflict', 409);
    }
    const safeKey = syntheticSandboxApiKey(derived.fingerprint);
    const mask = maskKeyText(key) || safeKey;
    items.push({ key: safeKey, mask, length: key.length, ...derived });
    recordSandboxAudit(state, 'api_key.create', 'client_api_key', derived.fingerprint);
    saveState(state);
    return jsonResponse({ status: 'ok', index: items.length - 1, key: safeKey, mask, ...derived, version: state.revisionSeq });
  }

  const apiKeyIndexMatch = /^\/management\/api-keys\/(\d+)$/.exec(pathname);
  if (apiKeyIndexMatch) {
    const index = Number(apiKeyIndexMatch[1]);
    const items = await ensureApiKeyEntries(state, fetchBaseline);
    if (index < 0 || index >= items.length) {
      return errorResponse('API key index not found', 'not_found', 404);
    }
    if (method === 'PUT') {
      const body = parseJsonBody<{ key?: string; expected_fingerprint?: string }>(options);
      const nextKey = (body?.key ?? '').trim();
      if (!nextKey) return errorResponse('API key cannot be empty', 'invalid_request', 400);
      if (body?.expected_fingerprint && items[index].fingerprint !== body.expected_fingerprint) {
        return errorResponse('Key list changed concurrently', 'key_identity_pending', 409);
      }
      const derived = deriveKeyFingerprints(nextKey);
      if (items.some((item, idx) => idx !== index && (item.fingerprint === derived.fingerprint || item.key === nextKey))) {
        return errorResponse('API key already exists', 'resource_conflict', 409);
      }
      const prevAlias = state.apiKeys.aliasesByFingerprint[items[index].usage_fingerprint] ??
        state.apiKeys.aliasesByFingerprint[items[index].fingerprint];
      const safeKey = syntheticSandboxApiKey(derived.fingerprint);
      const mask = maskKeyText(nextKey) || safeKey;
      items[index] = { key: safeKey, mask, length: nextKey.length, ...derived };
      if (prevAlias) {
        state.apiKeys.aliasesByFingerprint[derived.usage_fingerprint] = { ...prevAlias };
      }
      recordSandboxAudit(state, 'api_key.update', 'client_api_key', derived.fingerprint);
      saveState(state);
      return jsonResponse({ status: 'ok', index, key: safeKey, mask, ...derived, version: state.revisionSeq });
    }
    if (method === 'DELETE') {
      const expected = parsedUrl.searchParams.get('expected_fingerprint');
      if (expected && items[index].fingerprint !== expected) {
        return errorResponse('Key list changed concurrently', 'key_identity_pending', 409);
      }
      const removed = items.splice(index, 1)[0];
      recordSandboxAudit(state, 'api_key.delete', 'client_api_key', removed.fingerprint);
      saveState(state);
      return jsonResponse({ status: 'ok', deleted: 1, version: state.revisionSeq });
    }
  }

  if (pathname === '/management/client-key-aliases' && method === 'PUT') {
    const body = parseJsonBody<{ key_fingerprint?: string; alias?: string; version?: number }>(options);
    const fp = (body?.key_fingerprint ?? '').trim();
    if (!fp) return errorResponse('Missing key_fingerprint', 'invalid_request', 400);
    const prev = state.apiKeys.aliasesByFingerprint[fp];
    const nextVersion = (prev?.version ?? body?.version ?? 0) + 1;
    const alias = (body?.alias ?? '').trim();
    state.apiKeys.aliasesByFingerprint[fp] = { alias, version: nextVersion };
    recordSandboxAudit(state, 'client_key.alias_set', 'client_key', fp, { cleared: alias === '' });
    saveState(state);
    return jsonResponse({ status: 'ok', alias: { alias, version: nextVersion } });
  }

  // Providers
  if (pathname === '/management/providers' && method === 'POST') {
    const payload = parseJsonBody<SaveProviderPayload>(options);
    if (!payload) return errorResponse('Invalid provider payload', 'invalid_request', 400);
    const base = await ensureBaseline<{ providers: ProviderItem[]; total: number }>(
      'providers-with-keys',
      '/management/providers?include_keys=true',
      fetchBaseline,
    );
    const existing = base ? mergeProviders(base, state, true).providers : Object.values(state.providers.byId);
    const id = nextProviderID(payload.family, existing, state.providers.deletedIds);
    const created = buildProviderFromPayload(id, payload);
    state.providers.byId[id] = created;
    recordSandboxAudit(state, 'provider.create', 'provider', id, { name: created.name });
    saveState(state);
    return jsonResponse({ status: 'ok', family: payload.family, id, ids: [id] });
  }

  if (pathname === '/management/providers/status' && method === 'PATCH') {
    const body = parseJsonBody<{ family?: string; index?: number; disabled?: boolean }>(options);
    if (!body?.family || body.index === undefined || body.disabled === undefined) {
      return errorResponse('Invalid provider status payload', 'invalid_request', 400);
    }
    const base = await ensureBaseline<{ providers: ProviderItem[]; total: number }>(
      'providers-with-keys',
      '/management/providers?include_keys=true',
      fetchBaseline,
    );
    const all = base ? mergeProviders(base, state, true).providers : Object.values(state.providers.byId);
    const targetId = body.family === 'openai-compatibility'
      ? `openai-compat-${body.index}`
      : `${body.family}-${body.index}`;
    const target = all.find((p) => p.id === targetId) ?? all.filter((p) => p.family === body.family)[body.index];
    if (!target) return errorResponse('Provider not found', 'not_found', 404);
    state.providers.statusOverrides[target.id] = body.disabled;
    if (state.providers.byId[target.id]) {
      state.providers.byId[target.id] = { ...state.providers.byId[target.id], disabled: body.disabled };
    }
    recordSandboxAudit(state, body.disabled ? 'provider.disable' : 'provider.enable', 'provider', target.id);
    saveState(state);
    return jsonResponse({ status: 'ok', disabled: body.disabled });
  }

  if (pathname === '/management/providers/pull-models' && method === 'POST') {
    const body = parseJsonBody<{ family?: string; base_url?: string }>(options);
    const models = simulatedModelsForProvider(body?.family ?? 'openai-compatibility', body?.base_url);
    return jsonResponse({ models, total: models.length });
  }

  if (pathname === '/management/providers/probe' && method === 'POST') {
    const body = parseJsonBody<{ api_key?: string; model?: string }>(options);
    const key = (body?.api_key ?? '').trim();
    if (!key || /invalid|bad|fail/i.test(key)) {
      return jsonResponse({ ok: false, status_code: 401, error: 'Simulated 401 unauthorized in demo sandbox' });
    }
    return jsonResponse({ ok: true, status_code: 200 });
  }

  const providerNameMatch = /^\/management\/providers\/([^/]+)\/name$/.exec(pathname);
  if (providerNameMatch && method === 'PUT') {
    const id = decodeURIComponent(providerNameMatch[1]);
    const body = parseJsonBody<{ name?: string }>(options);
    const nextName = (body?.name ?? '').trim();
    state.providers.nameOverrides[id] = nextName;
    if (state.providers.byId[id]) {
      state.providers.byId[id] = {
        ...state.providers.byId[id],
        name: nextName || state.providers.byId[id].upstream_name || id,
      };
    }
    recordSandboxAudit(state, 'provider.rename', 'provider', id, { name: nextName });
    saveState(state);
    return jsonResponse({ status: 'ok', id, name: nextName });
  }

  const providerIdMatch = /^\/management\/providers\/([^/]+)$/.exec(pathname);
  if (providerIdMatch) {
    const id = decodeURIComponent(providerIdMatch[1]);
    const base = await ensureBaseline<{ providers: ProviderItem[]; total: number }>(
      'providers-with-keys',
      '/management/providers?include_keys=true',
      fetchBaseline,
    );
    const existing = state.providers.byId[id] ?? base?.providers.find((p) => p.id === id);
    if (method === 'PUT') {
      const payload = parseJsonBody<SaveProviderPayload>(options);
      if (!payload) return errorResponse('Invalid provider payload', 'invalid_request', 400);
      const updated = buildProviderFromPayload(id, payload, existing);
      state.providers.byId[id] = updated;
      delete state.providers.nameOverrides[id];
      state.providers.statusOverrides[id] = updated.disabled;
      recordSandboxAudit(state, 'provider.update', 'provider', id, { name: updated.name });
      saveState(state);
      return jsonResponse({ status: 'ok', id, ids: [id] });
    }
    if (method === 'DELETE') {
      delete state.providers.byId[id];
      if (!state.providers.deletedIds.includes(id)) state.providers.deletedIds.push(id);
      recordSandboxAudit(state, 'provider.delete', 'provider', id);
      saveState(state);
      return jsonResponse({ status: 'ok' });
    }
  }

  // Config & Config Source & Backups
  if (pathname === '/management/config' && method === 'PATCH') {
    const body = parseJsonBody<{ changes?: ConfigChange[]; revision?: string }>(options);
    const { scalarsRes, sourceRes } = await ensureConfigState(state, fetchBaseline);
    const backupsList = await ensureConfigBackups(state, fetchBaseline);
    const { parseDocument } = await import('yaml');
    const yamlDoc = parseDocument(sourceRes.yaml);
    const safeDoc = parseDocument(scalarsRes.safe_yaml || sourceRes.yaml);
    for (const change of body?.changes ?? []) {
      if (!Array.isArray(change.path) || change.path.length === 0) continue;
      if (change.remove) {
        yamlDoc.deleteIn(change.path);
        safeDoc.deleteIn(change.path);
      } else {
        yamlDoc.setIn(change.path, change.value);
        safeDoc.setIn(change.path, change.value);
      }
    }
    pushConfigBackup(state, backupsList, sourceRes.yaml, sourceRes.revision, 'config_changes');
    const nextYaml = yamlDoc.toString();
    const nextSafeYaml = safeDoc.toString();
    const revision = nextRevision(state);
    state.config.yaml = nextYaml;
    state.config.safeYaml = nextSafeYaml;
    state.config.scalars = syncScalarsFromDoc(yamlDoc, scalarsRes.scalars);
    state.config.revision = revision;
    recordSandboxAudit(state, 'config.patch', 'config', 'config.yaml', { count: body?.changes?.length ?? 0 });
    saveState(state);
    return jsonResponse({ status: 'ok', revision, safe_yaml: nextSafeYaml });
  }

  if (pathname === '/management/config/source' && method === 'PUT') {
    const body = parseJsonBody<{ yaml?: string }>(options);
    const nextYaml = body?.yaml ?? '';
    const { parseDocument } = await import('yaml');
    const doc = parseDocument(nextYaml);
    if (doc.errors.length > 0) {
      return errorResponse(doc.errors[0].message, 'invalid_yaml', 400);
    }
    const { scalarsRes, sourceRes } = await ensureConfigState(state, fetchBaseline);
    const backupsList = await ensureConfigBackups(state, fetchBaseline);
    pushConfigBackup(state, backupsList, sourceRes.yaml, sourceRes.revision, 'config_source');
    const revision = nextRevision(state);
    state.config.yaml = nextYaml;
    state.config.safeYaml = nextYaml;
    state.config.scalars = syncScalarsFromDoc(doc, scalarsRes.scalars);
    state.config.revision = revision;
    recordSandboxAudit(state, 'config.save_source', 'config', 'config_source_yaml', {
      bytes: new TextEncoder().encode(nextYaml).byteLength,
    });
    saveState(state);
    return jsonResponse({
      status: 'ok',
      revision,
      yaml: nextYaml,
      size_bytes: new TextEncoder().encode(nextYaml).byteLength,
    });
  }

  const configScalarMatch = /^\/management\/config\/([^/]+)$/.exec(pathname);
  if (configScalarMatch && method === 'PUT') {
    const key = decodeURIComponent(configScalarMatch[1]) as keyof ConfigScalars;
    const body = parseJsonBody<{ value?: unknown }>(options);
    const { scalarsRes, sourceRes } = await ensureConfigState(state, fetchBaseline);
    const nextScalars = { ...scalarsRes.scalars, [key]: body?.value } as ConfigScalars;
    const mapping = SCALAR_PATH_TO_KEY.find((entry) => entry.key === key);
    if (mapping) {
      const { parseDocument } = await import('yaml');
      const yamlDoc = parseDocument(sourceRes.yaml);
      const safeDoc = parseDocument(scalarsRes.safe_yaml || sourceRes.yaml);
      yamlDoc.setIn(mapping.path, body?.value);
      safeDoc.setIn(mapping.path, body?.value);
      state.config.yaml = yamlDoc.toString();
      state.config.safeYaml = safeDoc.toString();
    }
    state.config.scalars = nextScalars;
    state.config.revision = nextRevision(state);
    recordSandboxAudit(state, 'config.scalar_update', 'config', String(key));
    saveState(state);
    return jsonResponse({ status: 'ok', key, value: body?.value, version: state.revisionSeq });
  }

  if (pathname === '/management/config/backups' && method === 'POST') {
    const { sourceRes } = await ensureConfigState(state, fetchBaseline);
    const backupsList = await ensureConfigBackups(state, fetchBaseline);
    const newest = backupsList.backups[0];
    if (newest && state.config.backupYamlById[newest.id] === sourceRes.yaml) {
      return jsonResponse({ backup: newest, created: false });
    }
    const backup = pushConfigBackup(state, backupsList, sourceRes.yaml, sourceRes.revision, 'manual');
    saveState(state);
    return jsonResponse({ backup, created: true });
  }

  if (pathname === '/management/config/backups/settings' && method === 'PUT') {
    const body = parseJsonBody<{ retention?: number }>(options);
    const backupsList = await ensureConfigBackups(state, fetchBaseline);
    const retention = Math.min(
      backupsList.settings.retention_max,
      Math.max(backupsList.settings.retention_min, Math.round(body?.retention ?? backupsList.settings.retention)),
    );
    state.config.backupRetention = retention;
    if (state.config.backups && state.config.backups.length > retention) {
      state.config.backups = state.config.backups.slice(0, retention);
    }
    saveState(state);
    return jsonResponse({ settings: { ...backupsList.settings, retention } });
  }

  const restoreBackupMatch = /^\/management\/config\/backups\/(\d+)\/restore$/.exec(pathname);
  if (restoreBackupMatch && method === 'POST') {
    const backupId = Number(restoreBackupMatch[1]);
    const { scalarsRes, sourceRes } = await ensureConfigState(state, fetchBaseline);
    const backupsList = await ensureConfigBackups(state, fetchBaseline);
    let targetYaml: string | undefined = state.config.backupYamlById[backupId];
    if (targetYaml === undefined) {
      const detailRes = await fetchBaseline(`/management/config/backups/${backupId}`, { method: 'GET' });
      if (detailRes.ok) {
        const detail = (await detailRes.json()) as { yaml?: string };
        targetYaml = detail.yaml;
      }
    }
    if (!targetYaml) {
      return errorResponse('Config backup snapshot is unavailable', 'not_found', 404);
    }
    pushConfigBackup(state, backupsList, sourceRes.yaml, sourceRes.revision, 'restore');
    const { parseDocument } = await import('yaml');
    const doc = parseDocument(targetYaml);
    const revision = nextRevision(state);
    state.config.yaml = targetYaml;
    state.config.safeYaml = targetYaml;
    state.config.scalars = syncScalarsFromDoc(doc, scalarsRes.scalars);
    state.config.revision = revision;
    recordSandboxAudit(state, 'config.backup_restore', 'config_backup', String(backupId));
    saveState(state);
    return jsonResponse({ status: 'ok', revision });
  }

  const deleteBackupMatch = /^\/management\/config\/backups\/(\d+)$/.exec(pathname);
  if (deleteBackupMatch && method === 'DELETE') {
    const backupId = Number(deleteBackupMatch[1]);
    const backupsList = await ensureConfigBackups(state, fetchBaseline);
    state.config.backups = backupsList.backups.filter((b) => b.id !== backupId);
    delete state.config.backupYamlById[backupId];
    saveState(state);
    return jsonResponse({ status: 'ok' });
  }

  // Auth files & OAuth rules & Sandbox OAuth
  if (pathname === '/management/auth-files/status' && method === 'PATCH') {
    const body = parseJsonBody<{ name?: string; disabled?: boolean }>(options);
    if (!body?.name || body.disabled === undefined) return errorResponse('Missing name or disabled', 'invalid_request', 400);
    state.authFiles.statusOverrides[body.name] = body.disabled;
    recordSandboxAudit(state, body.disabled ? 'auth_file.disable' : 'auth_file.enable', 'auth_file', body.name);
    saveState(state);
    return jsonResponse({ status: 'ok', disabled: body.disabled });
  }

  if (pathname === '/management/auth-files/fields' && method === 'PATCH') {
    const body = parseJsonBody<Record<string, unknown>>(options);
    const name = typeof body?.name === 'string' ? body.name : '';
    if (!name) return errorResponse('Missing credential name', 'invalid_request', 400);
    const prev = state.authFiles.safeFieldsOverrides[name] ?? {};
    const fields: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(body ?? {})) {
      if (k !== 'name' && k !== 'auth_index') fields[k] = v;
    }
    state.authFiles.safeFieldsOverrides[name] = fields as Partial<ManagementAuthFileSafeFields>;
    recordSandboxAudit(state, 'auth_file.fields_update', 'auth_file', name);
    saveState(state);
    return jsonResponse({ status: 'ok', fields: { name, disable_cooling: false, websockets: false, using_api: false, ...fields } });
  }

  if (pathname === '/management/auth-files/display-name' && method === 'PUT') {
    const body = parseJsonBody<{ name?: string; display_name?: string; version?: number }>(options);
    const name = (body?.name ?? '').trim();
    if (!name) return errorResponse('Missing credential name', 'invalid_request', 400);
    const prev = state.authFiles.displayNameOverrides[name];
    const nextVersion = (prev?.version ?? body?.version ?? 0) + 1;
    const displayName = (body?.display_name ?? '').trim();
    state.authFiles.displayNameOverrides[name] = { display_name: displayName, version: nextVersion };
    recordSandboxAudit(state, 'auth_file.rename', 'auth_file', name, { display_name: displayName });
    saveState(state);
    return jsonResponse({ status: 'ok', display_name: displayName, display_name_version: nextVersion });
  }

  if (pathname === '/management/auth-files/refresh' && method === 'POST') {
    const body = parseJsonBody<{ name?: string }>(options);
    const name = (body?.name ?? '').trim();
    if (!name) return errorResponse('Missing credential name', 'invalid_request', 400);
    const prev = state.authFiles.recoveredNames[name];
    state.authFiles.recoveredNames[name] = { refreshedAt: new Date().toISOString(), verified: prev?.verified ?? false };
    recordSandboxAudit(state, 'auth_file.refresh', 'auth_file', name);
    saveState(state);
    return jsonResponse({ status: 'ok' });
  }

  if (pathname === '/management/auth-files/verify' && method === 'POST') {
    const body = parseJsonBody<{ name?: string }>(options);
    const name = (body?.name ?? '').trim();
    if (!name) return errorResponse('Missing credential name', 'invalid_request', 400);
    const prev = state.authFiles.recoveredNames[name];
    state.authFiles.recoveredNames[name] = { refreshedAt: prev?.refreshedAt ?? new Date().toISOString(), verified: true };
    recordSandboxAudit(state, 'auth_file.verify', 'auth_file', name);
    saveState(state);
    return jsonResponse({ status: 'ok', verified: true });
  }

  if (pathname === '/management/auth-files' && method === 'DELETE') {
    const body = parseJsonBody<{ names?: string[] }>(options);
    const names = body?.names ?? [];
    for (const name of names) {
      if (!state.authFiles.deletedNames.includes(name)) state.authFiles.deletedNames.push(name);
    }
    state.authFiles.created = state.authFiles.created.filter((f) => !names.includes(f.name));
    recordSandboxAudit(state, 'auth_file.delete', 'auth_file', names.join(','), { count: names.length });
    saveState(state);
    return jsonResponse({ status: 'ok', deleted: names.length, files: names });
  }

  if (pathname === '/management/auth-files' && method === 'POST') {
    const uploadedNames: string[] = [];
    const nowIso = new Date().toISOString();
    if (options.body instanceof FormData) {
      for (const value of options.body.getAll('file')) {
        if (value instanceof File) {
          const fileName = value.name.endsWith('.json') ? value.name : `${value.name}.json`;
          uploadedNames.push(fileName);
          const provider = fileName.split(/[-_.]/)[0] || 'codex';
          state.authFiles.created.push({
            name: fileName,
            auth_index: `auth-sandbox-${fnvHex(fileName).slice(0, 6)}`,
            type: 'oauth',
            provider,
            status: 'ready',
            disabled: false,
            unavailable: false,
            runtime_only: false,
            success: 0,
            failed: 0,
            priority: 4,
            weight: 1,
            access_token_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            next_refresh_after: nowIso,
            renewal_state: 'renewal_verified',
            recovery_stage: 'loaded',
            renewal_verified: true,
            note: 'Added in browser demo sandbox',
            models: simulatedModelsForProvider(provider).map((id) => ({ id, display_name: id })),
          });
        }
      }
    } else {
      const fileName = parsedUrl.searchParams.get('name') || `sandbox-credential-${state.revisionSeq + 1}.json`;
      let parsed: Record<string, unknown> = {};
      if (typeof options.body === 'string') {
        try {
          parsed = JSON.parse(options.body) as Record<string, unknown>;
        } catch {
          return errorResponse('Invalid JSON credential document', 'invalid_json', 400);
        }
      }
      const provider = typeof parsed.provider === 'string' && parsed.provider
        ? parsed.provider
        : typeof parsed.type === 'string' && parsed.type
          ? parsed.type
          : 'codex';
      uploadedNames.push(fileName);
      state.authFiles.created.push({
        name: fileName,
        auth_index: `auth-sandbox-${fnvHex(fileName).slice(0, 6)}`,
        type: 'oauth',
        provider,
        email: typeof parsed.email === 'string' ? parsed.email : 'sandbox@acme-labs.example',
        status: 'ready',
        disabled: false,
        unavailable: false,
        runtime_only: false,
        success: 0,
        failed: 0,
        priority: 4,
        weight: 1,
        renewal_state: 'renewal_verified',
        recovery_stage: 'loaded',
        renewal_verified: true,
        note: 'Uploaded in browser demo sandbox',
        models: simulatedModelsForProvider(provider).map((id) => ({ id, display_name: id })),
      });
    }
    recordSandboxAudit(state, 'auth_file.upload', 'auth_file', uploadedNames.join(','));
    saveState(state);
    return jsonResponse({ status: 'ok', uploaded: uploadedNames.length, files: uploadedNames });
  }

  if (pathname === '/management/auth-files/vertex-import' && method === 'POST') {
    const location = parsedUrl.searchParams.get('location') || 'us-central1';
    let parsed: Record<string, unknown> = {};
    if (typeof options.body === 'string') {
      try {
        parsed = JSON.parse(options.body) as Record<string, unknown>;
      } catch {
        return errorResponse('Invalid service account JSON', 'invalid_json', 400);
      }
    }
    const projectId = typeof parsed.project_id === 'string' && parsed.project_id ? parsed.project_id : 'demo-vertex-project';
    const email = typeof parsed.client_email === 'string' ? parsed.client_email : `vertex-sa@${projectId}.iam.gserviceaccount.com`;
    const fileName = `vertex-${projectId}.json`;
    state.authFiles.created.push({
      name: fileName,
      auth_index: `auth-vertex-${fnvHex(projectId).slice(0, 6)}`,
      type: 'vertex',
      provider: 'vertex',
      project_id: projectId,
      email,
      status: 'ready',
      disabled: false,
      unavailable: false,
      runtime_only: false,
      success: 0,
      failed: 0,
      priority: 4,
      weight: 1,
      note: `Vertex AI (${location}) in demo sandbox`,
      models: [{ id: 'gemini-4-argon', display_name: 'Gemini 4 Argon' }, { id: 'gemini-3.8-flash', display_name: 'Gemini 3.8 Flash' }],
    });
    recordSandboxAudit(state, 'auth_file.vertex_import', 'auth_file', fileName);
    saveState(state);
    return jsonResponse({ status: 'ok', name: fileName, project_id: projectId, email, location } satisfies VertexImportResult);
  }

  if (pathname === '/management/auth-files/model-aliases' && method === 'PATCH') {
    const body = parseJsonBody<{ provider?: string; aliases?: ManagementOAuthModelAlias[] }>(options);
    if (!body?.provider) return errorResponse('Missing provider', 'invalid_request', 400);
    const base = await ensureBaseline<ManagementOAuthModelAliasesResponse>(
      'auth-files-model-aliases',
      '/management/auth-files/model-aliases',
      fetchBaseline,
    );
    const merged = { ...(base?.aliases ?? {}), ...(state.authFiles.modelAliases ?? {}) };
    merged[body.provider] = body.aliases ?? [];
    state.authFiles.modelAliases = merged;
    recordSandboxAudit(state, 'oauth_aliases.update', 'oauth_provider', body.provider);
    saveState(state);
    return jsonResponse({ status: 'ok', provider: body.provider, aliases: merged[body.provider] });
  }

  if (pathname === '/management/auth-files/excluded-models' && method === 'PATCH') {
    const body = parseJsonBody<{ provider?: string; models?: string[] }>(options);
    if (!body?.provider) return errorResponse('Missing provider', 'invalid_request', 400);
    const base = await ensureBaseline<ManagementOAuthExcludedModelsResponse>(
      'auth-files-excluded-models',
      '/management/auth-files/excluded-models',
      fetchBaseline,
    );
    const merged = { ...(base?.excluded_models ?? {}), ...(state.authFiles.excludedModels ?? {}) };
    merged[body.provider] = body.models ?? [];
    state.authFiles.excludedModels = merged;
    recordSandboxAudit(state, 'oauth_excluded.update', 'oauth_provider', body.provider);
    saveState(state);
    return jsonResponse({ status: 'ok', provider: body.provider, models: merged[body.provider] });
  }

  // Sandbox OAuth / SIWC interactive flows
  if (pathname === '/management/oauth/start' && method === 'POST') {
    const body = parseJsonBody<{ provider?: string; name?: string; auth_index?: string; verify?: boolean }>(options);
    const provider = body?.provider || 'codex';
    const id = `demo-oauth-${Date.now().toString(36)}`;
    const isDevice = provider.startsWith('kimi') || provider.includes('qoder') || provider.includes('workbuddy');
    const session: DemoOAuthSessionState = {
      id,
      provider,
      flow: isDevice ? 'device' : 'redirect',
      status: 'waiting',
      url: `https://demo-sandbox.local/oauth/authorize?provider=${encodeURIComponent(provider)}&state=${id}`,
      userCode: isDevice ? `OMC-${id.slice(-4).toUpperCase()}` : undefined,
      recoveryTarget: body?.name ? { name: body.name, auth_index: body.auth_index, verify: body.verify } : undefined,
      createdAtMs: Date.now(),
    };
    oauthSessions.set(id, session);
    return jsonResponse({
      status: 'waiting',
      state: id,
      session_id: id,
      url: session.url,
      ...(session.userCode ? { user_code: session.userCode, verification_url: session.url } : {}),
    });
  }

  if (pathname === '/management/oauth/callback' && method === 'POST') {
    const body = parseJsonBody<{ provider?: string; redirect_url?: string }>(options);
    const provider = body?.provider || 'codex';
    let callbackState = '';
    if (body?.redirect_url) {
      try {
        callbackState = new URL(body.redirect_url).searchParams.get('state') ?? '';
      } catch {
        return errorResponse('Invalid OAuth callback URL', 'invalid_request', 400);
      }
    }
    const matchedSession = callbackState ? oauthSessions.get(callbackState) : undefined;
    if (!matchedSession || matchedSession.provider !== provider || matchedSession.status !== 'waiting') {
      return errorResponse('OAuth session is no longer waiting for callback', 'oauth_session_not_waiting', 409);
    }
    matchedSession.status = 'success';
    if (matchedSession.recoveryTarget) {
      const targetName = matchedSession.recoveryTarget.name;
      state.authFiles.recoveredNames[targetName] = {
        refreshedAt: new Date().toISOString(),
        verified: matchedSession.recoveryTarget.verify === true,
      };
      recordSandboxAudit(state, 'oauth.recover_sandbox', 'auth_file', targetName);
    } else {
      const idx = state.authFiles.created.length + 1;
      const name = `${provider}-sandbox-${idx}.json`;
      state.authFiles.created.push({
        name,
        auth_index: `auth-${provider}-sbx-${idx}`,
        type: 'oauth',
        provider,
        email: `sandbox-${idx}@acme-labs.example`,
        status: 'ready',
        disabled: false,
        unavailable: false,
        runtime_only: false,
        success: 0,
        failed: 0,
        priority: 5,
        weight: 2,
        renewal_state: 'renewal_verified',
        recovery_stage: 'renewal_verified',
        renewal_verified: true,
        inference_verified: true,
        access_token_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        note: 'Connected via Demo Sandbox OAuth',
        models: simulatedModelsForProvider(provider).map((id) => ({ id, display_name: id })),
      });
      recordSandboxAudit(state, 'oauth.connect_sandbox', 'oauth_provider', provider, { name });
    }
    saveState(state);
    return jsonResponse({ status: 'ok', provider });
  }

  if (pathname === '/management/oauth/session' && method === 'DELETE') {
    const id = parsedUrl.searchParams.get('session_id') || '';
    const session = oauthSessions.get(id);
    const canCancel = Boolean(session && session.status === 'waiting');
    if (canCancel && session) session.status = 'cancelled';
    return jsonResponse({ cancelled: canCancel, status: session?.status ?? 'cancelled' });
  }

  if (pathname === '/management/oauth/siwc/bind' && method === 'POST') {
    const body = parseJsonBody<{ name?: string; auth_index?: string; rebind?: boolean }>(options);
    const id = `demo-siwc-${Date.now().toString(36)}`;
    const session: DemoSiwcSessionState = {
      state: id,
      name: body?.name ?? 'codex-team-primary.json',
      auth_index: body?.auth_index ?? 'auth-codex-01',
      rebind: body?.rebind === true,
      status: 'waiting',
      url: `https://demo-sandbox.local/siwc/bind?state=${id}`,
    };
    siwcSessions.set(id, session);
    return jsonResponse({ status: 'waiting', state: id, url: session.url });
  }

  if (pathname === '/management/oauth/siwc/callback' && method === 'POST') {
    const id = parsedUrl.searchParams.get('state') || '';
    const session = siwcSessions.get(id);
    if (session) {
      session.status = 'ok';
      state.authFiles.siwcOverrides[session.name] = {
        use_siwc: true,
        siwc_bound: true,
        siwc_status: 'valid',
        siwc_expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      };
      recordSandboxAudit(state, 'oauth.siwc_bind_sandbox', 'auth_file', session.name);
      saveState(state);
    }
    return jsonResponse({ status: 'ok' });
  }

  if (pathname === '/management/oauth/siwc/session' && method === 'DELETE') {
    const id = parsedUrl.searchParams.get('state') || '';
    const session = siwcSessions.get(id);
    const canCancel = Boolean(session && session.status === 'waiting');
    if (canCancel && session) session.status = 'cancelled';
    return jsonResponse({ cancelled: canCancel, status: session?.status ?? 'cancelled' });
  }

  // Routing plan write
  if (pathname === '/management/routing' && method === 'PATCH') {
    const plan = parseJsonBody<RoutingPlanRequest>(options);
    if (!plan) return errorResponse('Invalid routing plan', 'invalid_request', 400);
    const [base, provRes, authRes] = await Promise.all([
      ensureBaseline<RoutingBoard>('routing', '/management/routing', fetchBaseline),
      ensureBaseline<{ providers: ProviderItem[]; total: number }>('providers-with-keys', '/management/providers?include_keys=true', fetchBaseline),
      ensureBaseline<ManagementAuthFilesResponse>('auth-files', '/management/auth-files', fetchBaseline),
    ]);
    const preProviders = provRes ? mergeProviders(provRes, state, false).providers : undefined;
    const preAuthFiles = authRes ? mergeAuthFiles(authRes, state).files : undefined;
    const currentBoard = base ? mergeRoutingBoard(base, state, preProviders, preAuthFiles) : undefined;
    if (plan.settings) {
      state.routing.settingsOverrides = {
        ...state.routing.settingsOverrides,
        ...(plan.settings as Partial<RoutingSettings>),
      };
      if (state.config.scalars) {
        if (typeof plan.settings.strategy === 'string') {
          state.config.scalars.routing_strategy = plan.settings.strategy;
        }
        if (typeof plan.settings.request_retry === 'number') {
          state.config.scalars.request_retry = plan.settings.request_retry;
        }
        if (typeof plan.settings.max_retry_credentials === 'number') {
          state.config.scalars.max_retry_credentials = plan.settings.max_retry_credentials;
        }
        if (typeof plan.settings.max_retry_interval === 'number') {
          state.config.scalars.max_retry_interval = plan.settings.max_retry_interval;
        }
      }
    }
    const results: { key: string; status: RoutingResultStatus }[] = [];
    for (const edit of plan.members ?? []) {
      const prev = state.routing.memberOverrides[edit.key] ?? {};
      const next = { ...prev };
      if (edit.priority !== undefined) next.priority = edit.priority;
      if (edit.weights !== undefined) {
        const currentMember = currentBoard?.members.find((m) => m.key === edit.key);
        const mergedWeights = [...(prev.weights ?? currentMember?.weights ?? [])].map((w) => ({ ...w }));
        for (const w of edit.weights) {
          const found = mergedWeights.findIndex((x) => x.index === w.index);
          if (found >= 0) mergedWeights[found] = { ...mergedWeights[found], weight: w.weight };
          else mergedWeights.push({ index: w.index, weight: w.weight });
        }
        next.weights = mergedWeights;
      }
      state.routing.memberOverrides[edit.key] = next;
      results.push({ key: edit.key, status: 'applied' });
    }
    state.routing.revision = nextRevision(state, 'demo-routing');
    recordSandboxAudit(state, 'routing.plan_apply', 'routing', state.routing.revision, {
      changes: (plan.members?.length ?? 0) + Object.keys(plan.settings ?? {}).length,
    });
    saveState(state);
    const providers = provRes ? mergeProviders(provRes, state, false).providers : undefined;
    const authFiles = authRes ? mergeAuthFiles(authRes, state).files : undefined;
    const board = base ? mergeRoutingBoard(base, state, providers, authFiles) : undefined;
    return jsonResponse({ is_complete: true, results, board });
  }

  // Plugins
  if (pathname === '/management/plugins/settings' && method === 'PUT') {
    const body = parseJsonBody<Partial<PluginSettings>>(options);
    const base = await ensureBaseline<PluginSettings>('plugins-settings', '/management/plugins/settings', fetchBaseline);
    state.plugins.settings = {
      ...(base ?? {
        revision: 'demo-plugin-rev-1',
        enabled: true,
        dir: 'plugins',
        store_sources: [],
        store_auth: [],
        omc_source_url: 'https://github.com/WizisCool/oh-my-cpa-plugins',
        omc_source_enabled: true,
      }),
      ...(body ?? {}),
    };
    recordSandboxAudit(state, 'plugin_settings.update', 'plugins', 'settings');
    saveState(state);
    return jsonResponse(state.plugins.settings);
  }

  const pluginEnableMatch = /^\/management\/plugins\/([^/]+)\/enabled$/.exec(pathname);
  if (pluginEnableMatch && method === 'PATCH') {
    const id = decodeURIComponent(pluginEnableMatch[1]);
    const body = parseJsonBody<{ enabled?: boolean }>(options);
    const enabled = body?.enabled === true;
    state.plugins.enabledOverrides[id] = enabled;
    recordSandboxAudit(state, enabled ? 'plugin.enable' : 'plugin.disable', 'plugin', id);
    saveState(state);
    return jsonResponse({ status: 'ok', id, enabled });
  }

  const pluginConfigWriteMatch = /^\/management\/plugins\/([^/]+)\/config$/.exec(pathname);
  if (pluginConfigWriteMatch && method === 'PUT') {
    const id = decodeURIComponent(pluginConfigWriteMatch[1]);
    const body = parseJsonBody<{ config?: Record<string, unknown> }>(options);
    state.plugins.configs[id] = body?.config ?? {};
    recordSandboxAudit(state, 'plugin.config_update', 'plugin', id);
    saveState(state);
    return jsonResponse({ status: 'ok', id });
  }

  const pluginInstallMatch = /^\/management\/plugin-store\/([^/]+)\/install$/.exec(pathname);
  if (pluginInstallMatch && method === 'POST') {
    const id = decodeURIComponent(pluginInstallMatch[1]);
    const body = parseJsonBody<{ source_id?: string; version?: string }>(options);
    const store = await ensureBaseline<PluginStoreResponse>('plugin-store', '/management/plugin-store', fetchBaseline);
    const listing = store?.plugins.find((p) => p.id === id && (!body?.source_id || p.source_id === body.source_id));
    state.plugins.deletedIds = state.plugins.deletedIds.filter((x) => x !== id);
    if (!state.plugins.installed.some((p) => p.id === id)) {
      state.plugins.installed.push({
        id,
        configured: true,
        registered: true,
        enabled: true,
        effective_enabled: true,
        logo: listing?.logo,
        repository_url: listing?.repository_url,
        config_fields: [],
        metadata: {
          name: listing?.name ?? id,
          version: body?.version ?? listing?.version ?? '1.0.0',
          author: listing?.author,
          logo: listing?.logo,
        },
      });
    }
    state.plugins.enabledOverrides[id] = true;
    recordSandboxAudit(state, 'plugin.install', 'plugin', id);
    saveState(state);
    return jsonResponse({ status: 'ok', id, version: body?.version ?? listing?.version ?? '1.0.0', restart_required: false });
  }

  const pluginDeleteMatch = /^\/management\/plugins\/([^/]+)$/.exec(pathname);
  if (pluginDeleteMatch && method === 'DELETE') {
    const id = decodeURIComponent(pluginDeleteMatch[1]);
    if (!state.plugins.deletedIds.includes(id)) state.plugins.deletedIds.push(id);
    state.plugins.installed = state.plugins.installed.filter((p) => p.id !== id);
    recordSandboxAudit(state, 'plugin.delete', 'plugin', id);
    saveState(state);
    return jsonResponse({ status: 'ok', id, file_deleted: true, configured_removed: true, restart_required: false });
  }

  // Pricing
  if (pathname === '/pricing/sync' && method === 'POST') {
    state.pricing.lastSyncedAtMs = Date.now();
    recordSandboxAudit(state, 'pricing.sync.start', 'pricing', 'openrouter');
    saveState(state);
    return jsonResponse({ started: true });
  }

  if (pathname === '/pricing/sync-schedule' && method === 'PUT') {
    const body = parseJsonBody<{ interval_hours?: number }>(options);
    const interval = body?.interval_hours ?? 24;
    state.pricing.syncIntervalHours = interval;
    const base = await ensureBaseline<PricingResponse>('pricing', '/pricing', fetchBaseline);
    saveState(state);
    return jsonResponse({
      interval_hours: interval,
      state: {
        ...(base?.sync.state ?? { source: 'openrouter', last_error: '', last_matched: 0, last_unmatched: 0, updated_at_ms: Date.now() }),
        auto_sync_interval_hours: interval,
        updated_at_ms: Date.now(),
      },
    });
  }

  const dismissPricingMatch = /^\/pricing\/models\/(.+)\/dismiss-candidate$/.exec(pathname);
  if (dismissPricingMatch && method === 'POST') {
    const model = decodeURIComponent(dismissPricingMatch[1]);
    const body = parseJsonBody<{ upstream_id?: string }>(options);
    if (body?.upstream_id) {
      const list = state.pricing.dismissedCandidates[model] ?? [];
      if (!list.includes(body.upstream_id)) state.pricing.dismissedCandidates[model] = [...list, body.upstream_id];
      saveState(state);
    }
    return jsonResponse({ dismissed: true });
  }

  const pricingModelWriteMatch = /^\/pricing\/models\/(.+)$/.exec(pathname);
  if (pricingModelWriteMatch) {
    const model = decodeURIComponent(pricingModelWriteMatch[1]);
    const channel = (parsedUrl.searchParams.get('channel') ?? '').trim();
    const channelKey = channel ? `${channel}\0${model}` : '';
    if (method === 'PUT') {
      const payload = parseJsonBody<PricingModelUpdate>(options);
      if (!payload) return errorResponse('Invalid pricing payload', 'invalid_request', 400);
      const [pricingBase, catalogBase] = await Promise.all([
        ensureBaseline<PricingResponse>('pricing', '/pricing', fetchBaseline),
        ensureBaseline<{ models: UpstreamModel[] }>('pricing-catalog', '/pricing/catalog', fetchBaseline),
      ]);
      const existing = channel
        ? pricingBase?.channel_models?.find((m) => m.model === model && m.channel === channel) ??
          pricingBase?.models.find((m) => m.model === model)
        : pricingBase?.models.find((m) => m.model === model);
      let resolvedUpstream: UpstreamModel | undefined;
      if (payload.mode === 'linked' || payload.mode === 'auto') {
        const targetId = payload.upstream_id ?? existing?.upstream_id;
        if (targetId && catalogBase?.models) {
          resolvedUpstream = catalogBase.models.find((u) => u.id === targetId || u.canonical_slug === targetId);
        }
        if (!resolvedUpstream) {
          const detailRes = await fetchBaseline(`/pricing/models/${encodeURIComponent(model)}`, { method: 'GET' });
          if (detailRes.ok) {
            const detail = (await detailRes.json()) as PricingModelDetail;
            if (payload.mode === 'auto') resolvedUpstream = detail.automatic?.model;
            else if (targetId) {
              resolvedUpstream = detail.suggestions.find((u) => u.id === targetId || u.canonical_slug === targetId)
                ?? (detail.candidate?.model.id === targetId ? detail.candidate.model : undefined);
            }
          }
        }
      }
      const now = Date.now();
      const price: ModelPrice = {
        model,
        ...(channel ? { channel } : existing?.channel ? { channel: existing.channel } : {}),
        prompt_price_per_1m: resolvedUpstream?.prompt_price_per_1m ?? payload.prompt_price_per_1m ?? existing?.prompt_price_per_1m ?? 0,
        completion_price_per_1m: resolvedUpstream?.completion_price_per_1m ?? payload.completion_price_per_1m ?? existing?.completion_price_per_1m ?? 0,
        cache_read_price_per_1m: resolvedUpstream?.cache_read_price_per_1m ?? payload.cache_read_price_per_1m ?? existing?.cache_read_price_per_1m ?? 0,
        cache_write_price_per_1m: resolvedUpstream?.cache_write_price_per_1m ?? payload.cache_write_price_per_1m ?? existing?.cache_write_price_per_1m ?? 0,
        price_multiplier: payload.price_multiplier ?? existing?.price_multiplier ?? 1,
        tiers: resolvedUpstream?.tiers ?? payload.tiers ?? existing?.tiers ?? null,
        source: payload.mode === 'custom' ? 'manual' : 'openrouter',
        upstream_id: resolvedUpstream?.id ?? payload.upstream_id ?? existing?.upstream_id ?? model,
        match_kind: payload.mode === 'linked' ? 'linked' : payload.mode === 'auto' ? 'exact' : '',
        mode: payload.mode,
        synced_at_ms: existing?.synced_at_ms ?? now,
        updated_at_ms: now,
      };
      if (channel) {
        state.pricing.channelModelOverrides = state.pricing.channelModelOverrides ?? {};
        state.pricing.channelModelOverrides[channelKey] = price;
      } else {
        state.pricing.modelOverrides[model] = price;
      }
      recordSandboxAudit(state, 'pricing.model_update', 'pricing_model', channel ? `${channel}:${model}` : model, { mode: payload.mode });
      saveState(state);
      return jsonResponse({ price });
    }
    if (method === 'DELETE') {
      if (channel) {
        state.pricing.channelModelOverrides = state.pricing.channelModelOverrides ?? {};
        state.pricing.channelModelOverrides[channelKey] = null;
      } else {
        state.pricing.modelOverrides[model] = null;
      }
      recordSandboxAudit(state, 'pricing.model_delete', 'pricing_model', channel ? `${channel}:${model}` : model);
      saveState(state);
      return jsonResponse({ deleted: true });
    }
  }

  const pricingChannelMatch = /^\/pricing\/channels\/(.+)$/.exec(pathname);
  if (pricingChannelMatch) {
    const channel = decodeURIComponent(pricingChannelMatch[1]);
    if (method === 'PUT') {
      const body = parseJsonBody<{ multiplier?: number; note?: string }>(options);
      const next: PricingChannel = {
        channel,
        multiplier: body?.multiplier ?? 1,
        note: body?.note ?? '',
        updated_at_ms: Date.now(),
        is_configured: true,
        usage_30d: { requests: 0, priced_requests: 0 },
      };
      state.pricing.channelOverrides[channel] = next;
      recordSandboxAudit(state, 'pricing.channel_update', 'pricing_channel', channel, { multiplier: next.multiplier });
      saveState(state);
      return jsonResponse({ channel: next });
    }
    if (method === 'DELETE') {
      state.pricing.channelOverrides[channel] = null;
      recordSandboxAudit(state, 'pricing.channel_delete', 'pricing_channel', channel);
      saveState(state);
      return jsonResponse({ deleted: true });
    }
  }

  // Quota & Warmup
  if (pathname === '/management/quota/refresh' && method === 'POST') {
    const body = parseJsonBody<{ auth_index?: string; auth_indexes?: string[] }>(options);
    const indexes = body?.auth_indexes ?? (body?.auth_index ? [body.auth_index] : []);
    const now = Date.now();
    for (const idx of indexes) state.quota.refreshedAt[idx] = now;
    const base = await ensureBaseline<QuotaOverviewResponse>('quota', '/management/quota', fetchBaseline);
    const matched = (base?.quotas ?? []).filter((q) => indexes.includes(q.auth_index)).map((q) => ({ ...q, observed_at_ms: now }));
    saveState(state);
    if (!body?.auth_indexes) return jsonResponse({ status: 'ok', quota: matched[0] });
    // As the server does: the event stream only for a caller that asks for it.
    const accept = new Headers(options?.headers).get('Accept') ?? '';
    if (!accept.includes('text/event-stream')) return jsonResponse({ status: 'ok', quotas: matched, total: matched.length });
    const frames = [
      ...matched.map((item) => `event: quota\ndata: ${JSON.stringify(item)}\n\n`),
      `event: done\ndata: ${JSON.stringify({ status: 'ok', total: matched.length })}\n\n`,
    ];
    return new Response(frames.join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-OMCPA-Demo': 'active', 'X-OMCPA-Demo-Sandbox': 'browser' },
    });
  }

  if (pathname === '/management/quota/clear-cooldown' && method === 'POST') {
    const body = parseJsonBody<{ auth_index?: string }>(options);
    if (body?.auth_index) {
      state.quota.clearedCooldowns[body.auth_index] = Date.now();
      recordSandboxAudit(state, 'quota.clear_cooldown', 'quota', body.auth_index);
      saveState(state);
    }
    return jsonResponse({ status: 'ok', auth_index: body?.auth_index ?? '' });
  }

  if (pathname === '/management/quota/reset' && method === 'POST') {
    const body = parseJsonBody<{ auth_index?: string }>(options);
    if (body?.auth_index) {
      state.quota.resetAt[body.auth_index] = Date.now();
      state.quota.clearedCooldowns[body.auth_index] = Date.now();
      recordSandboxAudit(state, 'quota.reset', 'quota', body.auth_index);
      saveState(state);
    }
    return jsonResponse({ status: 'ok', auth_index: body?.auth_index ?? '' });
  }

  if (pathname === '/management/quota/redeem-credit' && method === 'POST') {
    const body = parseJsonBody<{ auth_index?: string }>(options);
    const authIndex = body?.auth_index ?? '';
    state.quota.redeemedCredits[authIndex] = (state.quota.redeemedCredits[authIndex] ?? 0) + 1;
    state.quota.clearedCooldowns[authIndex] = Date.now();
    const base = await ensureBaseline<QuotaOverviewResponse>('quota', '/management/quota', fetchBaseline);
    const quota = base?.quotas.find((q) => q.auth_index === authIndex);
    recordSandboxAudit(state, 'quota.redeem_credit', 'quota', authIndex);
    saveState(state);
    return jsonResponse({ status: 'ok', quota, cooldown_cleared: true });
  }

  if (pathname === '/management/quota/warmup/tasks' && method === 'POST') {
    const input = parseJsonBody<WarmupTaskInput>(options);
    if (!input) return errorResponse('Invalid warmup task', 'invalid_request', 400);
    const base = await ensureBaseline<WarmupStateView>('warmup-settings', '/management/quota/warmup/settings', fetchBaseline);
    const tasks = state.quota.warmupTasks ?? [...(base?.tasks ?? [])];
    const nowIso = new Date().toISOString();
    const task: WarmupTask = {
      ...input,
      id: `warmup-sbx-${Date.now().toString(36)}`,
      created_at: nowIso,
      updated_at: nowIso,
    };
    state.quota.warmupTasks = [...tasks, task];
    recordSandboxAudit(state, 'warmup.task_create', 'warmup_task', task.id, { name: task.name });
    saveState(state);
    return jsonResponse({ ...(base ?? { runs: [], next: {}, timeline: [] }), tasks: state.quota.warmupTasks });
  }

  const warmupTaskRunMatch = /^\/management\/quota\/warmup\/tasks\/([^/]+)\/run$/.exec(pathname);
  if (warmupTaskRunMatch && method === 'POST') {
    const id = decodeURIComponent(warmupTaskRunMatch[1]);
    const base = await ensureBaseline<WarmupStateView>('warmup-settings', '/management/quota/warmup/settings', fetchBaseline);
    const tasks = state.quota.warmupTasks ?? [...(base?.tasks ?? [])];
    const task = tasks.find((t) => t.id === id);
    const run: WarmupRun = {
      id: `run-sbx-${Date.now().toString(36)}`,
      task_id: id,
      task_name: task?.name ?? id,
      at: new Date().toISOString(),
      outcome: 'ok',
      source: 'manual',
      provider: task?.provider ?? 'codex',
      auth_index: task?.auth_index ?? 'auth-codex-01',
      account: task?.account ?? 'codex-team-primary.json',
      model: task?.model || 'gpt-6-luna',
      ms: 740,
      input_tokens: 18,
      output_tokens: 12,
    };
    state.quota.warmupRunsAdded.unshift(run);
    recordSandboxAudit(state, 'warmup.task_run', 'warmup_task', id);
    saveState(state);
    return jsonResponse({
      run,
      state: {
        ...(base ?? { next: {}, timeline: [] }),
        tasks,
        runs: [...state.quota.warmupRunsAdded, ...(base?.runs ?? [])],
      },
    });
  }

  const warmupTaskMatch = /^\/management\/quota\/warmup\/tasks\/([^/]+)$/.exec(pathname);
  if (warmupTaskMatch) {
    const id = decodeURIComponent(warmupTaskMatch[1]);
    const base = await ensureBaseline<WarmupStateView>('warmup-settings', '/management/quota/warmup/settings', fetchBaseline);
    const tasks = state.quota.warmupTasks ?? [...(base?.tasks ?? [])];
    if (method === 'PUT') {
      const input = parseJsonBody<WarmupTaskInput>(options);
      if (!input) return errorResponse('Invalid warmup task', 'invalid_request', 400);
      state.quota.warmupTasks = tasks.map((t) => (t.id === id ? { ...t, ...input, updated_at: new Date().toISOString() } : t));
      saveState(state);
      return jsonResponse({ ...(base ?? { runs: [], next: {}, timeline: [] }), tasks: state.quota.warmupTasks });
    }
    if (method === 'DELETE') {
      state.quota.warmupTasks = tasks.filter((t) => t.id !== id);
      saveState(state);
      return jsonResponse({ ...(base ?? { runs: [], next: {}, timeline: [] }), tasks: state.quota.warmupTasks });
    }
  }

  if (pathname === '/management/quota/warmup/runs' && method === 'DELETE') {
    state.quota.warmupRunsAdded = [];
    state.quota.warmupRunsClearedAtMs = Date.now();
    saveState(state);
    const base = await ensureBaseline<WarmupStateView>('warmup-settings', '/management/quota/warmup/settings', fetchBaseline);
    return jsonResponse({ ...(base ?? { next: {}, timeline: [] }), tasks: state.quota.warmupTasks ?? base?.tasks ?? [], runs: [] });
  }

  // Custom icons
  if (pathname === '/custom-icons/preview' && method === 'POST') {
    const body = parseJsonBody<{ data?: string }>(options);
    const validated = validateCustomIconData(body?.data ?? '');
    if (!validated) return errorResponse('Invalid image artwork', 'custom_icon_invalid_image', 400);
    return jsonResponse(validated);
  }

  if (pathname === '/custom-icons' && method === 'POST') {
    const body = parseJsonBody<{ name?: string; data?: string }>(options);
    const validated = validateCustomIconData(body?.data ?? '');
    if (!validated) return errorResponse('Invalid image artwork', 'custom_icon_invalid_image', 400);
    const name = (body?.name ?? '').trim();
    if (!name) return errorResponse('Invalid icon name', 'custom_icon_invalid_name', 400);
    const id = fnvHex(`${name}:${Date.now()}`).repeat(2).slice(0, 32);
    const now = Date.now();
    const icon: CustomIcon = {
      id,
      name,
      mime_type: validated.mime_type,
      revision: 1,
      created_at_ms: now,
      updated_at_ms: now,
      reference_count: 0,
    };
    state.customIcons.created.push(icon);
    state.customIcons.dataUrls[id] = validated.data_url;
    recordSandboxAudit(state, 'custom_icon.create', 'custom_icon', id, { name });
    saveState(state);
    return jsonResponse(icon);
  }

  const customIconMatch = /^\/custom-icons\/([^/]+)$/.exec(pathname);
  if (customIconMatch) {
    const id = decodeURIComponent(customIconMatch[1]);
    if (method === 'PATCH') {
      const body = parseJsonBody<{ name?: string; data?: string }>(options);
      const prev = state.customIcons.updated[id] ?? {};
      const patch: Partial<CustomIcon> = {
        ...prev,
        updated_at_ms: Date.now(),
        revision: (prev.revision ?? 1) + 1,
      };
      if (body?.name !== undefined) patch.name = body.name.trim();
      if (body?.data !== undefined) {
        const validated = validateCustomIconData(body.data);
        if (!validated) return errorResponse('Invalid image artwork', 'custom_icon_invalid_image', 400);
        patch.mime_type = validated.mime_type;
        state.customIcons.dataUrls[id] = validated.data_url;
      }
      state.customIcons.updated[id] = patch;
      saveState(state);
      return jsonResponse({ id, name: patch.name ?? id, mime_type: patch.mime_type ?? 'image/svg+xml', revision: patch.revision, created_at_ms: Date.now(), updated_at_ms: Date.now(), reference_count: 0 });
    }
    if (method === 'DELETE') {
      if (!state.customIcons.deletedIds.includes(id)) state.customIcons.deletedIds.push(id);
      state.customIcons.created = state.customIcons.created.filter((i) => i.id !== id);
      delete state.customIcons.dataUrls[id];
      saveState(state);
      return jsonResponse({ status: 'ok' });
    }
  }

  // Fonts delete
  const fontDeleteMatch = /^\/fonts\/([^/]+)$/.exec(pathname);
  if (fontDeleteMatch && method === 'DELETE') {
    const id = decodeURIComponent(fontDeleteMatch[1]);
    if (!state.fonts.deletedIds.includes(id)) state.fonts.deletedIds.push(id);
    saveState(state);
    return jsonResponse({ status: 'ok' });
  }

  // Logs clear
  if (pathname === '/management/logs' && method === 'DELETE') {
    state.system.logsClearedAtMs = Date.now();
    state.extraLogLines = [];
    recordSandboxAudit(state, 'logs.clear', 'logs', 'cpa');
    saveState(state);
    return jsonResponse({ status: 'ok' });
  }

  // Outbound proxy & Data retention & System maintenance / check-updates / model catalog refresh / ingest refresh
  if (pathname === '/management/outbound-proxy' && method === 'PUT') {
    const input = parseJsonBody<OutboundProxyInput>(options);
    const base = await ensureBaseline<OutboundProxySettings>('outbound-proxy', '/management/outbound-proxy', fetchBaseline);
    const rawUrl = (input?.url ?? '').trim();
    const redactedAddress = rawUrl
      ? rawUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1••••@')
      : (base?.address ?? '');
    const next: OutboundProxySettings = {
      mode: input?.mode ?? base?.mode ?? 'environment',
      address: redactedAddress,
      has_credentials: Boolean(rawUrl && /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]+@/i.test(rawUrl)) || base?.has_credentials || false,
      no_proxy: input?.no_proxy ?? base?.no_proxy ?? '',
      revision: (base?.revision ?? 0) + state.revisionSeq,
      cpa_revision: state.config.revision ?? base?.cpa_revision ?? 'demo-cpa-rev',
      cpa_in_sync: true,
    };
    state.system.outboundProxy = next;
    recordSandboxAudit(state, 'outbound_proxy.update', 'outbound_proxy', 'default');
    saveState(state);
    return jsonResponse(next);
  }

  if (pathname === '/exchange-rates/refresh' && method === 'POST') {
    const base = await ensureBaseline<Record<string, unknown>>('exchange-rates', '/exchange-rates', fetchBaseline);
    return jsonResponse({
      ...(base ?? { base: 'USD', rates: [] }),
      updated_at_ms: Date.now(),
      last_error: '',
    });
  }

  if (pathname === '/management/system/data-retention' && method === 'PUT') {
    const input = parseJsonBody<{ request_record_days?: number }>(options);
    const base = await ensureBaseline<DataRetentionResponse>('system-data-retention', '/management/system/data-retention', fetchBaseline);
    const days = input?.request_record_days ?? base?.request_record_days ?? 90;
    state.system.dataRetentionDays = days;
    recordSandboxAudit(state, 'data_retention.update', 'data_retention', 'default', { days });
    saveState(state);
    return jsonResponse({ ...(base ?? { default_request_record_days: 90, min_days: 1, max_days: 3650, source: 'database' }), request_record_days: days });
  }

  if (pathname === '/management/system/maintenance/checkpoint' || pathname === '/management/system/maintenance/vacuum') {
    if (method === 'POST') {
      state.system.lastMaintenanceAtMs = Date.now();
      const base = await ensureBaseline<SystemMaintenanceResponse>('system-maintenance', '/management/system/maintenance', fetchBaseline);
      saveState(state);
      return jsonResponse({ ...(base ?? { state: 'idle' }), last_run_at_ms: state.system.lastMaintenanceAtMs, state: 'idle' });
    }
  }

  if (pathname === '/management/system/check-updates' && method === 'POST') {
    state.system.lastUpdateCheckAtMs = Date.now();
    const base = await ensureBaseline<SystemInfoResponse>('system', '/management/system', fetchBaseline);
    saveState(state);
    return jsonResponse({
      omc_version: base?.omc_version,
      cpa_version: base?.cpa_version,
      served_from_cache: false,
    });
  }

  if (pathname === '/management/model-square/refresh-catalogs' && method === 'POST') {
    const [provRes] = await Promise.all([
      ensureBaseline<{ providers: ProviderItem[]; total: number }>('providers-with-keys', '/management/providers?include_keys=true', fetchBaseline),
    ]);
    const providers = provRes ? mergeProviders(provRes, state, false).providers.filter((p) => !p.disabled) : [];
    return jsonResponse({
      attempted: providers.length,
      refreshed: providers.length,
      failed: 0,
      skipped: 0,
      results: providers.map((p) => ({
        provider_id: p.id,
        provider_name: p.name,
        family: p.family,
        outcome: 'refreshed',
        model_count: p.models?.length ?? 0,
      })),
    });
  }

  if (pathname === '/usage/ingest/refresh' && method === 'POST') {
    return jsonResponse({ refreshed: true, captured: 0, timed_out: false });
  }

  if (pathname === '/management/system/database-backup-automation' && method === 'PUT') {
    const input = parseJsonBody<BackupAutomationInput>(options);
    const now = Date.now();
    const prev = state.system.dbBackupAutomation;
    const safeDestinations: BackupDestination[] = (input?.destinations ?? []).map((dest) => ({
      id: dest.id,
      name: dest.name,
      provider: dest.provider,
      root: dest.root,
      has_config: true,
    }));
    const next: BackupAutomation = {
      enabled: input?.enabled ?? prev?.enabled ?? false,
      daily_at_minute: input?.daily_at_minute ?? prev?.daily_at_minute ?? 180,
      keep_local: input?.keep_local ?? prev?.keep_local ?? 14,
      keep_remote: input?.keep_remote ?? prev?.keep_remote ?? 14,
      has_passphrase: Boolean(input?.passphrase || prev?.has_passphrase),
      destinations: safeDestinations,
      next_run_at_ms: now + 18 * 3_600_000,
      last_run_at_ms: prev?.last_run_at_ms ?? 0,
      last_success_at_ms: prev?.last_success_at_ms ?? 0,
      last_error: '',
    };
    state.system.dbBackupAutomation = next;
    recordSandboxAudit(state, 'database_backup.automation_update', 'database_backup', 'automation');
    saveState(state);
    return jsonResponse(next);
  }

  if (pathname === '/management/system/database-backups' && method === 'POST') {
    const now = Date.now();
    const prevJobs = state.system.dbBackupJobs ?? [];
    const job: DatabaseBackupJob = {
      id: `export-demo-${now.toString(36)}`,
      kind: 'export',
      state: 'ready',
      created_at_ms: now,
      expires_at_ms: now + 24 * 3_600_000,
      size_bytes: 18_450_000,
      digest: `sha256:${fnvHex(String(now)).slice(0, 16)}`,
      source_version: 'v0.3.26',
      source_schema_version: 20261110,
      backup_created_at_ms: now,
      has_audit_error: false,
    };
    state.system.dbBackupJobs = [job, ...prevJobs];
    recordSandboxAudit(state, 'database_backup.create', 'database_backup', job.id);
    saveState(state);
    return jsonResponse(job);
  }

  const dbBackupJobDeleteMatch = /^\/management\/system\/database-backup-jobs\/([^/]+)$/.exec(pathname);
  if (dbBackupJobDeleteMatch && method === 'DELETE') {
    const id = decodeURIComponent(dbBackupJobDeleteMatch[1]);
    state.system.dbBackupJobs = (state.system.dbBackupJobs ?? []).filter((j) => j.id !== id);
    saveState(state);
    return jsonResponse({ status: 'ok' });
  }

  return null;
}
