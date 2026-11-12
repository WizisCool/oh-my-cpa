import type { QueryKey } from '@tanstack/react-query';

/**
 * Default SWR freshness window for non-secret configuration and directory queries.
 * Route/tab switches within this window render cached snapshots in 0ms without
 * blocking the UI, while SSE state_sync / sync_error events trigger immediate invalidation.
 */
export const DEFAULT_SWR_STALE_TIME_MS = 30_000;

/**
 * Canonical TanStack Query keys shared across pages, optimistic mutations, and
 * SSE invalidation handlers. New features register their scopes here once.
 */
export const QUERY_KEYS = {
  projectedState: ['management-state'] as const,
  config: ['management-config'] as const,
  configSource: ['management-config-source'] as const,
  configBackups: ['management-config-backups'] as const,
  providers: (includeKeys: boolean) => ['management-providers', includeKeys] as const,
  providersPrefix: ['management-providers'] as const,
  providersSanitized: ['management-providers-sanitized'] as const,
  clientKeys: (mode: 'with-keys' | 'masked' = 'masked') => ['management-client-keys', mode] as const,
  clientKeysPrefix: ['management-client-keys'] as const,
  clientKeyUsage: ['management-client-key-usage'] as const,
  authFiles: ['management-auth-files'] as const,
  oauthModelAliases: ['management-oauth-model-aliases'] as const,
  oauthExcludedModels: ['management-oauth-excluded-models'] as const,
  routing: ['management-routing'] as const,
  routingModels: ['management-routing-models'] as const,
  logsStatus: ['management-logs-status'] as const,
  plugins: ['management-plugins'] as const,
  pluginStore: ['management-plugin-store'] as const,
  pluginSettings: ['management-plugin-settings'] as const,
  quota: ['management-quota'] as const,
  overview: ['management-overview'] as const,
  preferences: ['preferences'] as const,
} as const;

/**
 * Canonical mutation keys paired with queryClient.isMutating({ mutationKey })
 * so rapid consecutive clicks only invalidate server queries when the final
 * concurrent mutation in the queue settles.
 */
export const MUTATION_KEYS = {
  configScalar: ['mutation', 'management-config', 'scalar'] as const,
  providerStatus: ['mutation', 'management-providers', 'status'] as const,
  clientKeys: ['mutation', 'management-client-keys'] as const,
  clientKeyAlias: ['mutation', 'management-client-key-alias'] as const,
  authFileStatus: ['mutation', 'management-auth-files', 'status'] as const,
  oauthModelAliases: ['mutation', 'management-oauth-model-aliases'] as const,
  oauthExcludedModels: ['mutation', 'management-oauth-excluded-models'] as const,
} as const;

/**
 * Maps backend StateCoordinator invalidation scope names to one or more
 * frontend TanStack Query key prefixes. Extensible via registerStateScopeMapping.
 */
const SCOPE_TO_QUERY_KEYS = new Map<string, ReadonlyArray<QueryKey>>([
  ['management-config', [QUERY_KEYS.config, QUERY_KEYS.projectedState]],
  ['management-providers', [QUERY_KEYS.providersPrefix, QUERY_KEYS.projectedState]],
  ['management-providers-sanitized', [QUERY_KEYS.providersSanitized]],
  ['management-client-keys', [QUERY_KEYS.clientKeysPrefix, QUERY_KEYS.projectedState]],
  ['management-routing', [QUERY_KEYS.routing]],
  ['management-logs-status', [QUERY_KEYS.logsStatus]],
  ['management-oauth-model-aliases', [QUERY_KEYS.oauthModelAliases, QUERY_KEYS.projectedState]],
  ['management-oauth-excluded-models', [QUERY_KEYS.oauthExcludedModels, QUERY_KEYS.projectedState]],
  ['management-auth-files', [QUERY_KEYS.authFiles, QUERY_KEYS.projectedState]],
  ['management-quota', [QUERY_KEYS.quota, QUERY_KEYS.overview]],
  ['management-plugins', [QUERY_KEYS.plugins]],
]);

/**
 * Maps a backend scope name to the mutationKey prefixes that write to it,
 * allowing state_sync events to defer invalidation while a newer local
 * optimistic mutation for the same scope is still in flight.
 */
const SCOPE_TO_MUTATION_KEYS = new Map<string, ReadonlyArray<QueryKey>>([
  ['management-config', [MUTATION_KEYS.configScalar]],
  ['management-providers', [MUTATION_KEYS.providerStatus]],
  ['management-providers-sanitized', [MUTATION_KEYS.providerStatus]],
  ['management-client-keys', [MUTATION_KEYS.clientKeys]],
  ['management-oauth-model-aliases', [MUTATION_KEYS.oauthModelAliases]],
  ['management-oauth-excluded-models', [MUTATION_KEYS.oauthExcludedModels]],
  ['management-auth-files', [MUTATION_KEYS.authFileStatus]],
]);

/**
 * Registers additional scope -> QueryKey mappings so future pages/features
 * plug into SSE reconciliation without editing core infrastructure.
 */
export function registerStateScopeMapping(
  scope: string,
  queryKeys: ReadonlyArray<QueryKey>,
  mutationKeys?: ReadonlyArray<QueryKey>,
): void {
  SCOPE_TO_QUERY_KEYS.set(scope, queryKeys);
  if (mutationKeys) {
    SCOPE_TO_MUTATION_KEYS.set(scope, mutationKeys);
  }
}

export function resolveQueryKeysForScopes(scopes: readonly string[]): QueryKey[] {
  const effectiveScopes = scopes.length > 0 ? scopes : [...SCOPE_TO_QUERY_KEYS.keys()];
  const seen = new Set<string>();
  const resolved: QueryKey[] = [];
  for (const scope of effectiveScopes) {
    const mapped = SCOPE_TO_QUERY_KEYS.get(scope) ?? [[scope]];
    for (const key of mapped) {
      const serialized = JSON.stringify(key);
      if (!seen.has(serialized)) {
        seen.add(serialized);
        resolved.push(key);
      }
    }
  }
  return resolved;
}

export function resolveMutationKeysForScope(scope: string): ReadonlyArray<QueryKey> {
  return SCOPE_TO_MUTATION_KEYS.get(scope) ?? [];
}
