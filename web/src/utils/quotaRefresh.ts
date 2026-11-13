import { api, ApiError, QuotaRefreshStreamCut } from '../api/client';
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
 * A reading the request delivered before it failed still counts as delivered.
 * `onReturned` receives each reading the moment the server sends it, for a caller that shows it
 * at once instead of waiting on the slowest credential in its chunk.
 */
export async function refreshCredentialQuotas(
  authIndexes: string[],
  onReturned?: (quota: QuotaItem) => void,
): Promise<QuotaRefreshOutcome> {
  const outcome: QuotaRefreshOutcome = { succeeded: 0, failures: [], unknownIndexes: [] };
  for (let start = 0; start < authIndexes.length; start += QUOTA_REFRESH_CHUNK_SIZE) {
    const chunk = authIndexes.slice(start, start + QUOTA_REFRESH_CHUNK_SIZE);
    const returned = new Map<string, QuotaItem>();
    let cause: unknown;
    let isCut = false;
    try {
      await api.batchRefreshCredentialQuotas(chunk, (item) => {
        returned.set(item.auth_index, item);
        onReturned?.(item);
      });
    } catch (error) {
      cause = error;
      isCut = true;
    }
    for (const authIndex of chunk) {
      const item = returned.get(authIndex);
      if (item) {
        if (item.status === 'error' || item.error) outcome.failures.push({ authIndex, name: item.name || authIndex, error: item.error });
        else outcome.succeeded += 1;
      } else if (isCut) outcome.failures.push({ authIndex, name: authIndex, cause });
      else outcome.unknownIndexes.push(authIndex);
    }
  }
  return outcome;
}

/** The reason a failed target is listed with, in the reader's language. */
export function quotaRefreshFailureReason(failure: QuotaRefreshFailure, t: TFunc): string {
  if (failure.cause === undefined) return failure.error || t('quota.status_error');
  if (failure.cause instanceof ApiError && failure.cause.status === 501) return t('af.unsupported');
  if (failure.cause instanceof QuotaRefreshStreamCut) return t('omc.quota_refresh_cut');
  return failure.cause instanceof Error ? failure.cause.message : t('af.request_failed');
}
