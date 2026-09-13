/**
 * How the request list reports a manual refresh.
 *
 * The classification is the point, and it is not cosmetic: the bug this replaces
 * reported a pull that could not drain CPA as a success, because "the request
 * completed" was treated as "the records were fetched". A refresh has three
 * genuinely different outcomes - this deployment captures nothing, the pull
 * drained the gateway, or the pull ran but came back short - and only one of them
 * is a success.
 *
 * The wording comes from the dictionary rather than from this module, so both
 * languages stay localized. These functions choose *which* message the operator
 * sees and with what numbers; they never choose the sentence.
 */
import type { UsageIngestRefresh } from '../../types/usageEvents';

export interface SyncMessage {
  /** Matches the antd message severity the page shows. */
  tone: 'info' | 'success' | 'warning';
  key: string;
  vars?: Record<string, string | number>;
}

/**
 * syncOutcomeMessage classifies one refresh response.
 *
 * A disabled collector is `info` rather than an error: the deployment captures
 * nothing, and saying so is the only honest answer for a refresh that has nothing
 * to pull. A failed authentication is separated from every other shortfall because
 * the operator's remedy is different - the management key is wrong, not the
 * gateway transiently unavailable.
 */
export function syncOutcomeMessage(outcome: UsageIngestRefresh): SyncMessage {
  if (!outcome.enabled) {
    return { tone: 'info', key: 'events.sync_disabled' };
  }
  if (outcome.synced) {
    const captured = outcome.captured ?? 0;
    return captured > 0
      ? { tone: 'success', key: 'events.sync_success', vars: { n: captured } }
      : { tone: 'success', key: 'events.sync_confirmed' };
  }
  return outcome.auth_rejected
    ? { tone: 'warning', key: 'events.sync_auth_rejected' }
    : { tone: 'warning', key: 'events.sync_incomplete', vars: { msg: outcome.error ?? '' } };
}

/**
 * The reason text a shortfall message carries when the gateway did not report one.
 *
 * The i18n variable is filled here rather than at the call site so the fallback is
 * shared by every caller; the caller supplies the dictionary's own unknown-reason
 * string, because that is a translated sentence and this module holds none.
 */
export function syncShortfallReason(outcome: UsageIngestRefresh, unknownReason: string): string {
  return outcome.error || unknownReason;
}

/**
 * Whether the "still running" notice is due.
 *
 * A sync that is still running after a visible delay has stopped looking like
 * "working on it" and started looking like a frozen page, so the page says so. It
 * is driven by a flag raised by a timer rather than by a duration measured here,
 * so this only decides whether the notice is shown.
 */
export function shouldAnnounceStuckSync(isSyncPending: boolean, isSyncStuck: boolean): boolean {
  return isSyncPending && isSyncStuck;
}

/**
 * The reads a completed refresh must re-issue, in order.
 *
 * Everything on screen is refreshed after the pull - the list, the facets and the
 * pipeline status - so the page never mixes pre- and post-sync data. The list is
 * first because it is the surface the operator was looking at.
 */
export const REFRESH_READS: readonly string[] = ['list', 'facets', 'ingest-status'];
