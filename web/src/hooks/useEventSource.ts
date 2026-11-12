import React from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  QUERY_KEYS,
  resolveMutationKeysForScope,
  resolveQueryKeysForScopes,
} from '../api/queryKeys';
import {
  stateLiveChannel,
  type SafeProjectedStateSnapshot,
  type StateSyncEvent,
} from '../api/stateLive';
import type { LiveChannelState } from '../api/liveChannel';
import type { ConfigScalarsResponse } from '../types/configManagement';
import type { ManagementAuthFilesResponse } from '../types/managementAuthFile';
import type {
  ManagementOAuthExcludedModelsResponse,
  ManagementOAuthModelAliasesResponse,
} from '../types/managementOAuthModelAlias';
import type { ProviderItem } from '../types/providers';
import { useToast } from '../components/feedback';
import { invalidateQueriesSilently } from '../utils/progressSources';
import { useT } from '../i18n';

export interface StateVersionTracker {
  lastVersion: number;
}

interface ProvidersCacheShape {
  providers: ProviderItem[];
  total: number;
  version?: number;
}

/**
 * Applies the authoritative sanitized snapshot carried on an SSE sync_error frame
 * directly into safe React Query caches so rolled-back controls snap back immediately
 * while background revalidation fetches full projections (such as key-bearing views).
 */
export function applyAuthoritativeSafeSnapshot(
  queryClient: QueryClient,
  snapshot: SafeProjectedStateSnapshot,
  version: number,
): void {
  queryClient.setQueryData(QUERY_KEYS.projectedState, {
    version,
    data: snapshot,
  });

  queryClient.setQueryData<ConfigScalarsResponse>(QUERY_KEYS.config, (current) => {
    if (!current) return current;
    return {
      ...current,
      scalars: snapshot.scalars,
      supported_keys: snapshot.supported_keys,
      revision: snapshot.revision || current.revision,
    };
  });

  const statusById = new Map(snapshot.provider_statuses.map((item) => [item.id, item.disabled]));
  if (statusById.size > 0) {
    for (const includeKeys of [false, true] as const) {
      queryClient.setQueryData<ProvidersCacheShape>(
        QUERY_KEYS.providers(includeKeys),
        (current) => {
          if (!current) return current;
          let changed = false;
          const providers = current.providers.map((provider) => {
            const authoritativeDisabled = statusById.get(provider.id);
            if (authoritativeDisabled === undefined || provider.disabled === authoritativeDisabled) {
              return provider;
            }
            changed = true;
            return { ...provider, disabled: authoritativeDisabled };
          });
          return changed ? { ...current, providers, version } : current;
        },
      );
    }
  }

  if (snapshot.auth_file_statuses.length > 0) {
    const authStatusByKey = new Map(
      snapshot.auth_file_statuses.map((item) => [
        item.auth_index ? `${item.name}|${item.auth_index}` : item.name,
        item.disabled,
      ]),
    );
    const authStatusByName = new Map(
      snapshot.auth_file_statuses.map((item) => [item.name, item.disabled]),
    );
    queryClient.setQueryData<ManagementAuthFilesResponse>(QUERY_KEYS.authFiles, (current) => {
      if (!current) return current;
      let changed = false;
      const files = current.files.map((file) => {
        const compositeKey = file.auth_index ? `${file.name}|${file.auth_index}` : file.name;
        const authoritativeDisabled =
          authStatusByKey.get(compositeKey) ?? authStatusByName.get(file.name);
        if (authoritativeDisabled === undefined || file.disabled === authoritativeDisabled) {
          return file;
        }
        changed = true;
        return { ...file, disabled: authoritativeDisabled };
      });
      return changed ? { ...current, files } : current;
    });
  }

  queryClient.setQueryData<ManagementOAuthModelAliasesResponse>(
    QUERY_KEYS.oauthModelAliases,
    (current) => (current ? { ...current, aliases: snapshot.oauth_model_aliases } : current),
  );

  queryClient.setQueryData<ManagementOAuthExcludedModelsResponse>(
    QUERY_KEYS.oauthExcludedModels,
    (current) =>
      current ? { ...current, excluded_models: snapshot.oauth_excluded_models } : current,
  );
}

/**
 * Pure event reconciliation handler shared by useEventSource and deterministic logic tests.
 */
export async function reconcileStateSyncEvent(
  queryClient: QueryClient,
  event: StateSyncEvent,
  tracker: StateVersionTracker,
  onSyncError?: (event: StateSyncEvent) => void,
): Promise<void> {
  const incomingVersion = event.version ?? 0;

  if (event.type === 'ready') {
    const missedUpdates =
      tracker.lastVersion > 0 &&
      (incomingVersion > tracker.lastVersion ||
        (incomingVersion > 0 && incomingVersion < tracker.lastVersion));
    if (incomingVersion > 0) {
      // Adopt the server's current version even when lower than lastVersion so an OMC
      // process restart (which resets Bootstrap version to 1) starts a fresh epoch
      // rather than causing the monotonic guard below to drop subsequent events.
      tracker.lastVersion = incomingVersion;
    }
    if (missedUpdates) {
      const keys = resolveQueryKeysForScopes([]);
      await Promise.all(
        keys.map((queryKey) => invalidateQueriesSilently(queryClient, { queryKey })),
      );
    }
    return;
  }

  // Monotonic version guard: ignore out-of-order frames older than what we already reconciled,
  // except sync_error which always forces authoritative recovery.
  if (event.type !== 'sync_error' && incomingVersion > 0 && incomingVersion < tracker.lastVersion) {
    return;
  }
  if (incomingVersion > tracker.lastVersion) {
    tracker.lastVersion = incomingVersion;
  }

  if (event.type === 'sync_error') {
    if (event.data) {
      applyAuthoritativeSafeSnapshot(queryClient, event.data, incomingVersion);
    }
    const keys = resolveQueryKeysForScopes(event.scopes ?? []);
    await Promise.all(
      keys.map((queryKey) => invalidateQueriesSilently(queryClient, { queryKey })),
    );
    onSyncError?.(event);
    return;
  }

  if (event.type === 'state_sync') {
    const scopes = event.scopes ?? [];
    // Filter out scopes that currently have an active optimistic mutation in flight
    // so an earlier batch's state_sync does not race a brand-new user click.
    const idleScopes = scopes.filter((scope) => {
      const mutationKeys = resolveMutationKeysForScope(scope);
      return mutationKeys.every((mutationKey) => queryClient.isMutating({ mutationKey }) === 0);
    });
    if (scopes.length > 0 && idleScopes.length === 0) {
      return;
    }
    const keys = resolveQueryKeysForScopes(idleScopes);
    await Promise.all(
      keys.map((queryKey) => invalidateQueriesSilently(queryClient, { queryKey })),
    );
  }
}

export interface UseEventSourceOptions {
  readonly isEnabled?: boolean;
  readonly onEvent?: (event: StateSyncEvent) => void;
}

/**
 * Global SSE subscription hook (defaults to '/api/events').
 * Listens for Go StateCoordinator sync_error rollback events and external/background
 * state_sync invalidations, automatically reconciling TanStack Query caches and surfacing
 * localized error toasts on asynchronous write-behind failures.
 */
export function useEventSource(
  endpoint = '/api/events',
  options: UseEventSourceOptions = {},
): { state: LiveChannelState } {
  const { isEnabled = true, onEvent } = options;
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useT();
  const [channelState, setChannelState] = React.useState<LiveChannelState>('connecting');
  const trackerRef = React.useRef<StateVersionTracker>({ lastVersion: 0 });
  const onEventRef = React.useRef(onEvent);
  const toastRef = React.useRef(toast);
  const tRef = React.useRef(t);

  React.useEffect(() => {
    onEventRef.current = onEvent;
    toastRef.current = toast;
    tRef.current = t;
  });

  React.useEffect(() => {
    if (!isEnabled) {
      setChannelState('connecting');
      return undefined;
    }
    const channel = stateLiveChannel(endpoint);
    return channel.subscribe({
      onState: setChannelState,
      onEvent: (event) => {
        onEventRef.current?.(event);
        void reconcileStateSyncEvent(queryClient, event, trackerRef.current, (errEvent) => {
          const detail = errEvent.error || errEvent.code || 'sync_error';
          toastRef.current.error(tRef.current('common.sync_reverted', { msg: detail }));
        });
      },
    });
  }, [endpoint, isEnabled, queryClient]);

  return { state: isEnabled ? channelState : 'connecting' };
}
