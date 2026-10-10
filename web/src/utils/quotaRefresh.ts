import { api, ApiError } from '../api/client';
import type { TFunc } from '../i18n';
import type { QuotaItem } from '../types/quota';

/** How many credentials one request asks the gateway to read upstream. */
const QUOTA_REFRESH_CHUNK_SIZE = 10;

export interface QuotaRefreshFailure {
  authIndex: string;
  name: string;
  /** What the gateway reported for this credential. */
  error?: string;
  /** What failed the request that carried this credential, when the request itself did. */
  cause?: unknown;
}

export interface QuotaRefreshOutcome {
  succeeded: number;
  failures: QuotaRefreshFailure[];
  /** Targets the response did not mention, so nothing is known about them. */
  unknownIndexes: string[];
}

/**
 * Runs one live quota refresh over the given credentials and tallies each target's outcome.
 *
 * Every surface that offers the refresh goes through here, so they cannot disagree about what a
 * failed, an unanswered and a refreshed credential are. A request that fails takes only its own
 * chunk with it; the run goes on, because one provider timing out says nothing about the rest.
 * `onReturned` receives each chunk's readings as they arrive, for a caller that shows them at once.
 */
export async function refreshCredentialQuotas(
  authIndexes: string[],
  onReturned?: (quotas: QuotaItem[]) => void,
): Promise<QuotaRefreshOutcome> {
  const outcome: QuotaRefreshOutcome = { succeeded: 0, failures: [], unknownIndexes: [] };
  for (let start = 0; start < authIndexes.length; start += QUOTA_REFRESH_CHUNK_SIZE) {
    const chunk = authIndexes.slice(start, start + QUOTA_REFRESH_CHUNK_SIZE);
    try {
      const response = await api.batchRefreshCredentialQuotas(chunk);
      const returned = new Map(response.quotas.map((item) => [item.auth_index, item]));
      onReturned?.(response.quotas);
      for (const authIndex of chunk) {
        const item = returned.get(authIndex);
        if (!item) outcome.unknownIndexes.push(authIndex);
        else if (item.status === 'error' || item.error) outcome.failures.push({ authIndex, name: item.name || authIndex, error: item.error });
        else outcome.succeeded += 1;
      }
    } catch (cause) {
      chunk.forEach((authIndex) => outcome.failures.push({ authIndex, name: authIndex, cause }));
    }
  }
  return outcome;
}

/** The reason a failed target is listed with, in the reader's language. */
export function quotaRefreshFailureReason(failure: QuotaRefreshFailure, t: TFunc): string {
  if (failure.cause === undefined) return failure.error || t('quota.status_error');
  if (failure.cause instanceof ApiError && failure.cause.status === 501) return t('af.unsupported');
  return failure.cause instanceof Error ? failure.cause.message : t('af.request_failed');
}
