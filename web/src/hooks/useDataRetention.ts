import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { TFunc } from '../i18n';
import type { DataRetentionResponse } from '../types/system';

/** Shared by the settings group that changes retention and the System page that reports on it. */
export const DATA_RETENTION_QUERY_KEY = ['management-system-data-retention'] as const;

export function useDataRetention() {
  return useQuery<DataRetentionResponse>({
    queryKey: DATA_RETENTION_QUERY_KEY,
    queryFn: () => api.getDataRetention(),
    // The pass after a change runs a minute later; polling while one is due shows it land.
    refetchInterval: (query) => {
      const next = query.state.data?.next_pass_at_ms;
      if (!next) return false;
      return Math.max(15_000, next - Date.now() - 2 * 60_000);
    },
  });
}

/** Zero keeps every request record. */
export function formatRetentionDays(days: number, t: TFunc): string {
  return days === 0 ? t('omc.retention_keep') : t('omc.retention_days', { n: days });
}
