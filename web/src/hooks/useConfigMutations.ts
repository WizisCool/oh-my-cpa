import { api, describeError } from '../api/client';
import { MUTATION_KEYS, QUERY_KEYS } from '../api/queryKeys';
import type { ConfigScalars, ConfigScalarsResponse } from '../types/configManagement';
import type { ManagementAuthFilesResponse } from '../types/managementAuthFile';
import type {
  ManagementOAuthExcludedModelsResponse,
  ManagementOAuthModelAlias,
  ManagementOAuthModelAliasesResponse,
} from '../types/managementOAuthModelAlias';
import type { ClientAPIKeyItem, ProviderItem } from '../types/providers';
import { parseProviderID } from '../types/providerId';
import { maskKeyText } from '../utils/maskKey';
import { defineOptimisticTarget, useOptimisticMutation } from './useOptimisticMutation';

export interface ConfigScalarMutationInput<K extends keyof ConfigScalars = keyof ConfigScalars> {
  readonly key: K;
  readonly value: ConfigScalars[K];
}

/**
 * Optimistic scalar setting mutation (e.g. debug, request_log, routing_strategy, force_model_prefix).
 * Updates ['management-config'] on the click frame, rolls back on error, and invalidates only
 * after the final concurrent scalar mutation settles.
 */
export function useOptimisticConfigScalarMutation(options?: {
  formatError?: (error: unknown, variables: ConfigScalarMutationInput) => string | null;
  onSuccess?: () => void;
}) {
  return useOptimisticMutation({
    mutationKey: MUTATION_KEYS.configScalar,
    mutationFn: ({ key, value }: ConfigScalarMutationInput) => api.updateConfigScalar(key, value),
    targets: [
      defineOptimisticTarget<ConfigScalarMutationInput, ConfigScalarsResponse>(
        QUERY_KEYS.config,
        (current, { key, value }) => {
          if (!current) return current;
          return {
            ...current,
            scalars: {
              ...current.scalars,
              [key]: value,
            },
          };
        },
      ),
    ],
    invalidateKeys: [QUERY_KEYS.routing, QUERY_KEYS.logsStatus],
    formatError: options?.formatError,
    onSuccess: options?.onSuccess ? () => options.onSuccess?.() : undefined,
  });
}

export interface ProviderStatusMutationInput {
  readonly id: string;
  readonly isEnabled: boolean;
  readonly expectedAuthIndex?: string;
  readonly expectedName?: string;
  readonly signal?: AbortSignal;
}

interface ProvidersListCache {
  providers: ProviderItem[];
  total: number;
}

function flipProviderInCache(
  current: ProvidersListCache | undefined,
  { id, isEnabled }: ProviderStatusMutationInput,
): ProvidersListCache | undefined {
  if (!current) return current;
  let didChange = false;
  const providers = current.providers.map((provider) => {
    if (provider.id !== id || provider.disabled === !isEnabled) return provider;
    didChange = true;
    return { ...provider, disabled: !isEnabled };
  });
  return didChange ? { ...current, providers } : current;
}

/**
 * Optimistic provider enable/disable toggle updating both plaintext-opted and sanitized
 * provider list caches in place with anti-flicker last-mutation settle invalidation.
 */
export function useOptimisticProviderStatusMutation(options?: {
  formatError?: (error: unknown, variables: ProviderStatusMutationInput) => string | null;
}) {
  return useOptimisticMutation({
    mutationKey: MUTATION_KEYS.providerStatus,
    mutationFn: async ({ id, isEnabled, expectedAuthIndex, expectedName, signal }: ProviderStatusMutationInput) => {
      const target = parseProviderID(id);
      if (!target) {
        throw new Error(`Invalid provider identifier: ${id}`);
      }
      return api.patchManagementProviderStatus(target.family, target.index, !isEnabled, {
        expectedAuthIndex,
        expectedName,
        signal,
      });
    },
    targets: [
      defineOptimisticTarget<ProviderStatusMutationInput, ProvidersListCache>(
        QUERY_KEYS.providers(true),
        flipProviderInCache,
      ),
      defineOptimisticTarget<ProviderStatusMutationInput, ProvidersListCache>(
        QUERY_KEYS.providers(false),
        flipProviderInCache,
      ),
    ],
    invalidateKeys: [QUERY_KEYS.providersSanitized, QUERY_KEYS.routing],
    formatError: options?.formatError,
  });
}

export interface AuthFileStatusMutationInput {
  readonly fileName: string;
  readonly disabled: boolean;
  readonly authIndex?: string;
}

/**
 * Optimistic OAuth credential-file enable/disable toggle on OAuthManagementPage.
 * Eliminates workspace-wide lock blocking by mutating ['management-auth-files'] in place
 * on the click frame and guarding invalidation across rapid multi-row clicks.
 */
export function useOptimisticAuthFileStatusMutation(options?: {
  formatError?: (error: unknown, variables: AuthFileStatusMutationInput) => string | null;
}) {
  return useOptimisticMutation({
    mutationKey: MUTATION_KEYS.authFileStatus,
    mutationFn: ({ fileName, disabled, authIndex }: AuthFileStatusMutationInput) =>
      api.setManagementAuthFileStatus(fileName, disabled, authIndex),
    targets: [
      defineOptimisticTarget<AuthFileStatusMutationInput, ManagementAuthFilesResponse>(
        QUERY_KEYS.authFiles,
        (current, { fileName, disabled, authIndex }) => {
          if (!current) return current;
          let changed = false;
          const files = current.files.map((file) => {
            if (file.name !== fileName) return file;
            if (authIndex && file.auth_index && file.auth_index !== authIndex) return file;
            changed = true;
            return {
              ...file,
              disabled,
              status: disabled ? 'disabled' : file.status === 'disabled' ? 'ready' : file.status,
            };
          });
          return changed ? { ...current, files } : current;
        },
      ),
    ],
    invalidateKeys: [QUERY_KEYS.quota, QUERY_KEYS.overview],
    formatError: options?.formatError,
  });
}

export interface OAuthAliasesMutationInput {
  readonly provider: string;
  readonly aliases: ManagementOAuthModelAlias[];
}

/**
 * Optimistic global OAuth model-alias rule save backed by Go StateCoordinator write-behind.
 */
export function useOptimisticOAuthAliasesMutation(options?: {
  formatError?: (error: unknown) => string | null;
  onSuccess?: (provider: string, aliases: ManagementOAuthModelAlias[]) => void;
}) {
  return useOptimisticMutation({
    mutationKey: MUTATION_KEYS.oauthModelAliases,
    mutationFn: ({ provider, aliases }: OAuthAliasesMutationInput) =>
      api.patchManagementOAuthModelAliases(provider, aliases),
    targets: [
      defineOptimisticTarget<OAuthAliasesMutationInput, ManagementOAuthModelAliasesResponse>(
        QUERY_KEYS.oauthModelAliases,
        (current, { provider, aliases }) => {
          const base = current?.aliases ?? {};
          const nextAliases = { ...base };
          if (aliases.length === 0) {
            delete nextAliases[provider];
          } else {
            nextAliases[provider] = aliases;
          }
          return { aliases: nextAliases };
        },
      ),
    ],
    invalidateKeys: [QUERY_KEYS.config],
    formatError: options?.formatError ? (err) => options.formatError?.(err) ?? null : describeError,
    onSuccess: (_data, vars) => options?.onSuccess?.(vars.provider, vars.aliases),
  });
}

export interface OAuthExcludedModelsMutationInput {
  readonly provider: string;
  readonly models: string[];
}

/**
 * Optimistic global OAuth excluded-model rule save backed by Go StateCoordinator write-behind.
 */
export function useOptimisticOAuthExcludedModelsMutation(options?: {
  formatError?: (error: unknown) => string | null;
  onSuccess?: (provider: string, models: string[]) => void;
}) {
  return useOptimisticMutation({
    mutationKey: MUTATION_KEYS.oauthExcludedModels,
    mutationFn: ({ provider, models }: OAuthExcludedModelsMutationInput) =>
      api.patchManagementOAuthExcludedModels(provider, models),
    targets: [
      defineOptimisticTarget<OAuthExcludedModelsMutationInput, ManagementOAuthExcludedModelsResponse>(
        QUERY_KEYS.oauthExcludedModels,
        (current, { provider, models }) => {
          const base = current?.excluded_models ?? {};
          const nextExcluded = { ...base };
          if (models.length === 0) {
            delete nextExcluded[provider];
          } else {
            nextExcluded[provider] = models;
          }
          return { excluded_models: nextExcluded };
        },
      ),
    ],
    invalidateKeys: [QUERY_KEYS.config],
    formatError: options?.formatError ? (err) => options.formatError?.(err) ?? null : describeError,
    onSuccess: (_data, vars) => options?.onSuccess?.(vars.provider, vars.models),
  });
}

export interface ClientKeysCacheShape {
  keys: ClientAPIKeyItem[];
  total: number;
}

export type ClientKeyOperation =
  | { readonly kind: 'create'; readonly key: string; readonly alias?: string }
  | {
      readonly kind: 'update';
      readonly index: number;
      readonly key: string;
      readonly alias?: string;
      readonly expectedFingerprint?: string;
    }
  | {
      readonly kind: 'delete';
      readonly index: number;
      readonly expectedFingerprint?: string;
    };

function applyClientKeyOpToCache(
  current: ClientKeysCacheShape | undefined,
  op: ClientKeyOperation,
  masked: boolean,
): ClientKeysCacheShape | undefined {
  if (!current) return current;
  const displayValue = (raw: string) => (masked ? maskKeyText(raw) : raw);
  if (op.kind === 'create') {
    const nextItem: ClientAPIKeyItem = {
      index: current.keys.length,
      key: displayValue(op.key),
      fingerprint: '',
      length: op.key.length,
      alias_version: 0,
      ...(op.alias ? { alias: op.alias } : {}),
    };
    const keys = [...current.keys, nextItem];
    return { keys, total: keys.length };
  }
  if (op.kind === 'update') {
    if (op.index < 0 || op.index >= current.keys.length) return current;
    const keys = current.keys.map((entry, idx) =>
      idx === op.index
        ? {
            ...entry,
            key: displayValue(op.key),
            alias: op.alias !== undefined ? (op.alias || undefined) : entry.alias,
          }
        : entry,
    );
    return { keys, total: keys.length };
  }
  // delete
  const keys = current.keys
    .filter((_, idx) => idx !== op.index)
    .map((entry, idx) => ({ ...entry, index: idx }));
  return { keys, total: keys.length };
}

/**
 * Optimistic gateway client API-key create/update/delete mutation backed by Go StateCoordinator
 * 250ms write-behind. Updates both ['management-client-keys', 'with-keys'] and ['masked'] caches
 * synchronously on the click frame without full-YAML ConfigPage round-trips.
 */
export function useOptimisticClientKeyMutation(options?: {
  formatError?: (error: unknown, variables: ClientKeyOperation) => string | null;
}) {
  return useOptimisticMutation({
    mutationKey: MUTATION_KEYS.clientKeys,
    scope: { id: 'management-client-keys' },
    mutationFn: async (
      op: ClientKeyOperation,
    ): Promise<{ status: string; index: number; usage_fingerprint?: string; version?: number }> => {
      if (op.kind === 'create') {
        return api.createClientAPIKey(op.key);
      }
      if (!op.expectedFingerprint) {
        throw new Error('Client key identity is still loading; try again in a moment');
      }
      if (op.kind === 'update') {
        return api.updateClientAPIKey(op.index, op.key, op.expectedFingerprint);
      }
      const deleted = await api.deleteClientAPIKey(op.index, op.expectedFingerprint);
      return { status: deleted.status, index: deleted.deleted, version: deleted.version };
    },
    targets: [
      defineOptimisticTarget<ClientKeyOperation, ClientKeysCacheShape>(
        QUERY_KEYS.clientKeys('with-keys'),
        (current, op) => applyClientKeyOpToCache(current, op, false),
      ),
      defineOptimisticTarget<ClientKeyOperation, ClientKeysCacheShape>(
        QUERY_KEYS.clientKeys('masked'),
        (current, op) => applyClientKeyOpToCache(current, op, true),
      ),
    ],
    invalidateKeys: [
      QUERY_KEYS.config,
      ['usage-events'],
      ['usage-facets'],
      ['usage-event'],
    ],
    formatError: options?.formatError ?? describeError,
  });
}
