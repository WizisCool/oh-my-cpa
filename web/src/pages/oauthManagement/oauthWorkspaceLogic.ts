import { matchesStatusFilter, providerOf, type AuthFileSortKey, type AuthFileStatusFilter } from '../../components/authFiles/authFileLogic';
import { getCredentialProviderMetadata } from '../../components/common/providerMetadata';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import type { PluginItem } from '../../types/plugin';
import { OAUTH_PROVIDER_PATTERN, type OAuthProviderChoice } from '../oauthProviderLogic';
import type { QuotaItem } from '../../types/quota';

export type OAuthWorkspaceDensity = 'compact' | 'expanded';
export type OAuthWorkspaceQuotaFilter =
  | 'all'
  | 'attention'
  | 'healthy'
  | 'warning'
  | 'exhausted'
  | 'cooldown'
  | 'stale'
  | 'error'
  | 'unobserved'
  | 'unsupported';

export type OAuthWorkspaceQuotaMatch =
  | 'matched'
  | 'missing-index'
  | 'ambiguous-file-index'
  | 'ambiguous-quota-index'
  | 'missing-quota';

export type OAuthWorkspaceQuotaCondition =
  | 'healthy'
  | 'warning'
  | 'exhausted'
  | 'cooldown'
  | 'stale'
  | 'error'
  | 'reauth'
  | 'unobserved'
  | 'loading';

export interface OAuthWorkspaceRecord {
  key: string;
  file: ManagementAuthFile;
  quota?: QuotaItem;
  quotaMatch: OAuthWorkspaceQuotaMatch;
  quotaCondition: OAuthWorkspaceQuotaCondition;
  isQuotaAttention: boolean;
  isQuotaUnsupported: boolean;
  isQuotaObserved: boolean;
  displayProvider: string;
  authorizationProviderId?: string;
  fileName: string;
  authIndex?: string;
  hasUniqueFileName: boolean;
  hasUniqueAuthIndex: boolean;
  canSelectForFileBatch: boolean;
  canEditFile: boolean;
  canToggleFile: boolean;
  canDownloadFile: boolean;
  canDeleteFile: boolean;
  canRefreshQuota: boolean;
  canClearCooldown: boolean;
  canRedeemCredit: boolean;
}

export interface OAuthWorkspaceProjection {
  records: OAuthWorkspaceRecord[];
  quotaOnly: QuotaItem[];
  duplicateAuthIndexes: string[];
  duplicateFileNames: string[];
  missingAuthIndexCount: number;
}

export interface OAuthWorkspaceQueryState {
  provider: string;
  query: string;
  status: AuthFileStatusFilter;
  quota: OAuthWorkspaceQuotaFilter;
  sort: AuthFileSortKey;
  page: number;
  pageSize: 12 | 24 | 48;
  density?: OAuthWorkspaceDensity;
  action?: 'connect';
  connectProvider?: string;
  focus?: 'quota';
}

const AUTH_FILE_STATUS_FILTERS = new Set<AuthFileStatusFilter>(['all', 'enabled', 'disabled', 'problem']);
const QUOTA_FILTERS = new Set<OAuthWorkspaceQuotaFilter>([
  'all',
  'attention',
  'healthy',
  'warning',
  'exhausted',
  'cooldown',
  'stale',
  'error',
  'unobserved',
  'unsupported',
]);
const AUTH_FILE_SORTS = new Set<AuthFileSortKey>([
  'name-asc',
  'name-desc',
  'requests-desc',
  'priority-desc',
  'weight-desc',
]);
const PAGE_SIZES = new Set<number>([12, 24, 48]);
const BUILTIN_SIGN_IN_IDS: Record<string, string> = {
  claude: 'anthropic',
  antigravity: 'antigravity',
  codex: 'codex',
  xai: 'xai',
  kimi: 'kimi',
  devin: 'devin',
  meta: 'meta',
};

function normalizedKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * Canonicalizes only known aliases. Unknown provider keys stay untouched because
 * inventing a family for them would make an unrelated credential share a filter.
 */
export function canonicalDisplayProviderKey(file: ManagementAuthFile, quota?: QuotaItem): string {
  const observed = providerOf(file) !== 'unknown' ? providerOf(file) : normalizedKey(quota?.provider) || 'unknown';
  const metadata = getCredentialProviderMetadata(observed);
  return metadata.id || observed || 'unknown';
}

export function resolveAuthorizationProviderId(
  displayProvider: string,
  choices: OAuthProviderChoice[],
): string | undefined {
  const normalized = normalizedKey(displayProvider);
  if (!normalized) return undefined;
  const directBuiltin = BUILTIN_SIGN_IN_IDS[normalized];
  if (directBuiltin) return directBuiltin;
  const choice = choices.find((candidate) => normalizedKey(candidate.id) === normalized);
  return choice?.id;
}

export function pluginConnectableProviderIds(plugins: PluginItem[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const plugin of plugins ?? []) {
    if (!plugin.supports_oauth) continue;
    const providerId = normalizedKey(plugin.oauth_provider || plugin.id);
    if (!providerId || !OAUTH_PROVIDER_PATTERN.test(providerId)) continue;
    ids.add(providerId);
  }
  return ids;
}

function hasMeaningfulObservation(item: QuotaItem): boolean {
  return Boolean(
    (item.windows?.length ?? 0) > 0
      || item.plan
      || item.reset_credits
      || item.active_cooldown?.is_active
      || Object.keys(item.raw_signals ?? {}).length > 0
      || Object.keys(item.quota?.signals ?? {}).length > 0
      || Object.keys(item.model_quotas ?? {}).length > 0,
  );
}

function conditionFromWindows(item: QuotaItem): OAuthWorkspaceQuotaCondition {
  const values = (item.windows ?? [])
    .map((window) => {
      if (window.remaining_percent != null) return window.remaining_percent;
      if (window.used_percent != null) return 100 - window.used_percent;
      return null;
    })
    .filter((value): value is number => value != null);
  if (values.length === 0) return 'unobserved';
  const minimum = Math.min(...values.map((value) => Math.max(0, Math.min(100, value))));
  if (minimum >= 70) return 'healthy';
  if (minimum >= 25) return 'warning';
  return 'exhausted';
}

export function quotaConditionOf(item: QuotaItem | undefined): OAuthWorkspaceQuotaCondition {
  if (!item) return 'unobserved';
  if (item.status === 'loading') return 'loading';
  if (item.active_cooldown?.is_active || item.status === 'cooldown') return 'cooldown';
  if (item.status === 'exhausted') return 'exhausted';
  if (item.status === 'warning') return 'warning';
  if (item.status === 'error') return 'error';
  if (item.status === 'stale') return 'stale';
  if (item.recommendation?.status === 'needs_reauth' || item.recommendation?.action === 'reauth') return 'reauth';
  if (item.status === 'healthy') return 'healthy';
  return conditionFromWindows(item);
}

export function isQuotaAttention(condition: OAuthWorkspaceQuotaCondition): boolean {
  return condition === 'warning'
    || condition === 'exhausted'
    || condition === 'cooldown'
    || condition === 'error'
    || condition === 'reauth';
}

/**
 * Projects the two management reads into one credential-centred collection.
 *
 * The quota response participates only when both sides carry one unique nonempty
 * auth index. Ambiguity is preserved in the projection rather than resolved to a
 * guess, and quota-only observations remain diagnostics rather than new rows.
 */
export function buildOAuthWorkspaceProjection(
  files: ManagementAuthFile[],
  quotas: QuotaItem[],
  choices: OAuthProviderChoice[],
): OAuthWorkspaceProjection {
  const fileNames = countValues(files.map((file) => file.name.trim()).filter(Boolean));
  const fileIndexes = countValues(files.map((file) => file.auth_index ?? '').filter(Boolean));
  const quotaIndexes = countValues(quotas.map((quota) => quota.auth_index ?? '').filter(Boolean));
  const quotasByIndex = new Map<string, QuotaItem[]>();
  for (const quota of quotas) {
    const index = quota.auth_index ?? '';
    if (!index) continue;
    const list = quotasByIndex.get(index) ?? [];
    list.push(quota);
    quotasByIndex.set(index, list);
  }

  const occurrences = new Map<string, number>();
  const records = files.map((file): OAuthWorkspaceRecord => {
    const name = file.name.trim();
    const authIndex = (file.auth_index ?? '') || undefined;
    const tuple = JSON.stringify([name, authIndex ?? '']);
    const occurrence = (occurrences.get(tuple) ?? 0) + 1;
    occurrences.set(tuple, occurrence);

    const nameCount = fileNames.get(name) ?? 0;
    const indexCount = authIndex ? fileIndexes.get(authIndex) ?? 0 : 0;
    const quotaMatches = authIndex ? quotasByIndex.get(authIndex) ?? [] : [];
    let quotaMatch: OAuthWorkspaceQuotaMatch = 'matched';
    let quota: QuotaItem | undefined;
    if (!authIndex) {
      quotaMatch = 'missing-index';
    } else if (indexCount !== 1) {
      quotaMatch = 'ambiguous-file-index';
    } else if (quotaMatches.length > 1) {
      quotaMatch = 'ambiguous-quota-index';
    } else if (quotaMatches.length === 0) {
      quotaMatch = 'missing-quota';
    } else {
      quota = quotaMatches[0];
    }

    const uniqueFileTarget = nameCount === 1;
    const uniqueIndex = Boolean(authIndex) && indexCount === 1 && (quotaIndexes.get(authIndex ?? '') ?? 0) <= 1;
    const condition = quota ? quotaConditionOf(quota) : 'unobserved';
    const unsupported = quota ? !quota.capabilities?.refresh_supported : false;
    const displayProvider = canonicalDisplayProviderKey(file, quota);
    const fileBacked = !file.runtime_only;

    return {
      key: `${tuple}#${occurrence}`,
      file,
      quota,
      quotaMatch,
      quotaCondition: condition,
      isQuotaAttention: isQuotaAttention(condition)
        || quota?.recommendation?.action === 'reauth',
      isQuotaUnsupported: unsupported,
      isQuotaObserved: quota ? hasMeaningfulObservation(quota) : false,
      displayProvider,
      authorizationProviderId: resolveAuthorizationProviderId(displayProvider, choices),
      fileName: name,
      authIndex,
      hasUniqueFileName: uniqueFileTarget,
      hasUniqueAuthIndex: uniqueIndex,
      canSelectForFileBatch: fileBacked && uniqueFileTarget,
      canEditFile: fileBacked && uniqueFileTarget,
      canToggleFile: fileBacked && uniqueFileTarget,
      canDownloadFile: fileBacked && uniqueFileTarget,
      canDeleteFile: fileBacked && uniqueFileTarget,
      canRefreshQuota: Boolean(
        quota
          && uniqueIndex
          && !file.disabled
          && quota.capabilities?.refresh_supported,
      ),
      canClearCooldown: Boolean(
        quota
          && uniqueIndex
          && quota.capabilities?.clear_cooldown_supported
          && quota.active_cooldown?.is_active,
      ),
      // The bank of credits decides whether redeeming is offered. Upstream's
      // `applicable_available_count` is not the gate: it refines which credits would apply
      // right now, while the consume response is what states the outcome.
      canRedeemCredit: Boolean(
        quota
          && uniqueIndex
          && !file.disabled
          && quota.capabilities?.reset_credit_supported
          && (quota.reset_credits?.available_count ?? 0) > 0,
      ),
    };
  });

  const knownIndexes = new Set(
    files
      .map((file) => file.auth_index ?? '')
      .filter((index) => index && fileIndexes.get(index) === 1),
  );
  const quotaOnly = quotas.filter((quota) => {
    const index = quota.auth_index ?? '';
    return !index || !knownIndexes.has(index);
  });

  return {
    records,
    quotaOnly,
    duplicateAuthIndexes: Array.from(fileIndexes.entries())
      .filter(([, count]) => count > 1)
      .map(([index]) => index)
      .sort(),
    duplicateFileNames: Array.from(fileNames.entries())
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
      .sort(),
    missingAuthIndexCount: files.filter((file) => !(file.auth_index ?? '')).length,
  };
}

export function matchesQuotaFilter(
  record: OAuthWorkspaceRecord,
  filter: OAuthWorkspaceQuotaFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return record.isQuotaAttention;
  if (filter === 'unsupported') return record.isQuotaUnsupported;
  if (filter === 'unobserved') return record.quotaCondition === 'unobserved';
  return record.quotaCondition === filter;
}

// Reuses `authFileLogic`'s predicates rather than restating them: the summary strip counts
// with the same functions, and a second copy of "healthy" would let the Active count
// disagree with the rows the enabled filter returns.
export function filterOAuthWorkspaceRecords(
  records: OAuthWorkspaceRecord[],
  query: string,
  provider: string,
  status: AuthFileStatusFilter,
  quotaFilter: OAuthWorkspaceQuotaFilter,
): OAuthWorkspaceRecord[] {
  const needle = query.trim().toLowerCase();
  return records.filter((record) => {
    if (provider !== 'all' && record.displayProvider !== provider) return false;
    if (!matchesStatusFilter(record.file, status)) return false;
    if (!matchesQuotaFilter(record, quotaFilter)) return false;
    if (!needle) return true;
    const values = [
      fileText(record.file.name),
      fileText(record.file.email),
      fileText(record.file.project_id),
      fileText(record.file.type),
      fileText(record.file.provider),
      fileText(record.file.auth_index),
      fileText(record.file.note),
      fileText(record.file.status_message),
      fileText(record.quota?.plan?.plan_label),
      fileText(record.quota?.error),
      fileText(record.quota?.recommendation?.reason),
    ];
    return values.some((value) => value.includes(needle));
  });
}

function fileText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function sortOAuthWorkspaceRecords(
  records: OAuthWorkspaceRecord[],
  sort: AuthFileSortKey,
): OAuthWorkspaceRecord[] {
  const copy = [...records];
  const byName = (left: OAuthWorkspaceRecord, right: OAuthWorkspaceRecord) =>
    left.file.name.localeCompare(right.file.name, undefined, { numeric: true, sensitivity: 'base' });
  switch (sort) {
    case 'name-desc':
      return copy.sort((left, right) => byName(right, left));
    case 'requests-desc':
      return copy.sort((left, right) => {
        const requestDelta = (right.file.success + right.file.failed) - (left.file.success + left.file.failed);
        return requestDelta || byName(left, right);
      });
    case 'priority-desc':
      return copy.sort((left, right) => {
        const priorityDelta = (right.file.priority ?? 0) - (left.file.priority ?? 0);
        return priorityDelta || byName(left, right);
      });
    case 'weight-desc':
      return copy.sort((left, right) => {
        const weightDelta = (right.file.weight ?? 1) - (left.file.weight ?? 1);
        return weightDelta || byName(left, right);
      });
    case 'name-asc':
    default:
      return copy.sort(byName);
  }
}

export function workspaceProviderOptions(
  records: OAuthWorkspaceRecord[],
  choices: OAuthProviderChoice[],
): string[] {
  const pinned = ['claude', 'antigravity', 'codex', 'xai', 'kimi', 'devin', 'meta'];
  const observed = records.map((record) => record.displayProvider).filter((provider) => provider && provider !== 'unknown');
  const connectable = choices.map((choice) => {
    const id = normalizedKey(choice.id);
    if (id === 'anthropic') return 'claude';
    return getCredentialProviderMetadata(id).id || id;
  }).filter(Boolean);
  const extras = Array.from(new Set([...observed, ...connectable]))
    .filter((provider) => !pinned.includes(provider))
    .sort();
  return [...pinned, ...extras];
}

export function workspaceProviderCounts(records: OAuthWorkspaceRecord[]): Record<string, number> {
  const counts: Record<string, number> = { all: records.length };
  for (const record of records) {
    counts[record.displayProvider] = (counts[record.displayProvider] ?? 0) + 1;
  }
  return counts;
}

export interface QuotaRefreshTargetPlan {
  eligibleIndexes: string[];
  skipped: Array<{ authIndex?: string; name: string; reason: string }>;
}

export function buildQuotaRefreshTargets(
  records: OAuthWorkspaceRecord[],
): QuotaRefreshTargetPlan {
  const source = records;
  const seen = new Set<string>();
  const eligibleIndexes: string[] = [];
  const skipped: QuotaRefreshTargetPlan['skipped'] = [];
  for (const record of source) {
    const index = record.authIndex;
    if (!index) {
      skipped.push({ name: record.fileName, reason: 'missing-auth-index' });
      continue;
    }
    if (!record.hasUniqueAuthIndex) {
      skipped.push({ authIndex: index, name: record.fileName, reason: 'ambiguous-auth-index' });
      continue;
    }
    if (!record.quota) {
      skipped.push({ authIndex: index, name: record.fileName, reason: 'missing-quota-observation' });
      continue;
    }
    if (record.file.disabled) {
      skipped.push({ authIndex: index, name: record.fileName, reason: 'credential-disabled' });
      continue;
    }
    if (!record.quota.capabilities?.refresh_supported) {
      skipped.push({ authIndex: index, name: record.fileName, reason: 'refresh-unsupported' });
      continue;
    }
    if (!seen.has(index)) {
      seen.add(index);
      eligibleIndexes.push(index);
    }
  }
  return { eligibleIndexes, skipped };
}

export function parseOAuthWorkspaceQuery(params: URLSearchParams): OAuthWorkspaceQueryState {
  const provider = normalizedKey(params.get('provider') || '') || 'all';
  const query = params.get('q') ?? '';
  const statusRaw = params.get('status') as AuthFileStatusFilter | null;
  const quotaRaw = params.get('quota') as OAuthWorkspaceQuotaFilter | null;
  const sortRaw = params.get('sort') as AuthFileSortKey | null;
  const pageRaw = Number(params.get('page') ?? '1');
  const pageSizeRaw = Number(params.get('page_size') ?? '12');
  const densityRaw = params.get('density');
  const action = params.get('action') === 'connect' ? 'connect' : undefined;
  const connectProviderRaw = normalizedKey(params.get('connect_provider') || '');
  const connectProvider = connectProviderRaw && OAUTH_PROVIDER_PATTERN.test(connectProviderRaw)
    ? connectProviderRaw
    : undefined;
  const focus = params.get('focus') === 'quota' ? 'quota' : undefined;

  return {
    provider,
    query,
    status: statusRaw && AUTH_FILE_STATUS_FILTERS.has(statusRaw) ? statusRaw : 'all',
    quota: quotaRaw && QUOTA_FILTERS.has(quotaRaw) ? quotaRaw : 'all',
    sort: sortRaw && AUTH_FILE_SORTS.has(sortRaw) ? sortRaw : 'name-asc',
    page: Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1,
    pageSize: PAGE_SIZES.has(pageSizeRaw) ? pageSizeRaw as 12 | 24 | 48 : 12,
    density: densityRaw === 'compact' || densityRaw === 'expanded' ? densityRaw : undefined,
    action,
    connectProvider,
    focus,
  };
}

export function updateWorkspaceSearch(
  current: URLSearchParams,
  changes: Record<string, string | number | null | undefined>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value == null || value === '') {
      next.delete(key);
    } else {
      next.set(key, String(value));
    }
  }
  return next;
}

/** A one-shot action is consumed before the panel arms its own history entry. */
export function consumeOneShotIntent(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('action');
  next.delete('connect_provider');
  next.delete('focus');
  return next;
}

export function legacyOAuthManagementRedirect(
  from: '/oauth' | '/auth-files' | '/quota',
  search: URLSearchParams,
): string {
  const next = new URLSearchParams();
  const rawProvider = normalizedKey(search.get('provider') || '');
  const provider = rawProvider === 'anthropic'
    ? 'claude'
    : rawProvider
      ? getCredentialProviderMetadata(rawProvider).id || rawProvider
      : '';
  const query = search.get('q');
  if (provider) next.set('provider', provider);
  if (query) next.set('q', query);

  if (from === '/oauth') {
    next.set('action', 'connect');
    const connectProvider = BUILTIN_SIGN_IN_IDS[provider] ?? rawProvider;
    if (connectProvider) next.set('connect_provider', connectProvider);
  } else if (from === '/quota') {
    next.set('density', 'expanded');
    next.set('focus', 'quota');
  }
  const suffix = next.toString();
  return `/oauth-management${suffix ? `?${suffix}` : ''}`;
}

/**
 * Which surface a quota-refresh outcome is reported on.
 *
 * A run whose targets all answered - including one that skipped credentials which were never
 * eligible, since that is decided before the run rather than by it - is an acknowledgement and
 * belongs in a toast: it leaves no block behind, so a finished refresh cannot push the
 * credential list down. A failed or unknown target is a result to inspect, and the in-page
 * report is the only surface that can carry its per-target reason. Exactly one of the two is
 * used.
 */
export function quotaRefreshOutcomeSurface(
  report: { failed: number; unknown: number },
): 'toast' | 'report' {
  return report.failed > 0 || report.unknown > 0 ? 'report' : 'toast';
}
