import type { ProviderConnectionPoolSettings, ProviderOverride } from '../../types/providers';

export interface ConnectionPoolDraft {
  isConfigured: boolean;
  enabled: ProviderOverride;
  idleConnTimeout: string;
  maxIdleConnsPerHost: number | null;
}

export const EMPTY_CONNECTION_POOL_DRAFT: ConnectionPoolDraft = {
  isConfigured: false, enabled: 'inherit', idleConnTimeout: '', maxIdleConnsPerHost: null,
};

export function readConnectionPoolDraft(pool?: ProviderConnectionPoolSettings | null): ConnectionPoolDraft {
  return {
    isConfigured: pool != null,
    enabled: pool?.enabled == null ? 'inherit' : pool.enabled ? 'enabled' : 'disabled',
    idleConnTimeout: pool?.idle_conn_timeout ?? '',
    maxIdleConnsPerHost: pool?.max_idle_conns_per_host ?? null,
  };
}

export function buildConnectionPool(draft: ConnectionPoolDraft): ProviderConnectionPoolSettings | null {
  if (!draft.isConfigured) return null;
  return {
    ...(draft.enabled === 'inherit' ? {} : { enabled: draft.enabled === 'enabled' }),
    ...(draft.idleConnTimeout.trim() === '' ? {} : { idle_conn_timeout: draft.idleConnTimeout.trim() }),
    ...(draft.maxIdleConnsPerHost == null ? {} : { max_idle_conns_per_host: draft.maxIdleConnsPerHost }),
  };
}

/** Do not replay resolved settings: untouched inheritance must stay inheritance. */
export function connectionPoolEdit(draft: ConnectionPoolDraft, stored?: ProviderConnectionPoolSettings | null) {
  const edited = buildConnectionPool(draft);
  const original = buildConnectionPool(readConnectionPoolDraft(stored));
  return JSON.stringify(edited) === JSON.stringify(original) ? undefined : edited;
}

export function isConnectionPoolValid(draft: ConnectionPoolDraft): boolean {
  if (!draft.isConfigured) return true;
  const maxIdle = draft.maxIdleConnsPerHost;
  // CPA's signed integer accepts zero/negative values to disable keep-alives.
  // Duration grammar is validated by CPA's Go-side facade, not a second parser.
  return draft.idleConnTimeout.length <= 128 && (maxIdle == null || Number.isSafeInteger(maxIdle));
}
