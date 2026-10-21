import type { TFunc } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { formatObservedAgo } from './quotaFormat';

/**
 * The line a row prints when the last try to re-read the credential failed.
 *
 * The row presents the last successful reading, so without this line a failed refresh would leave
 * a reading days old under a status that claims to be current - the operator saw the toast, and
 * whoever looked at the page afterwards did not. The reason is the provider's own, already
 * redacted on the way in.
 */
export function refreshFailureLine(item: QuotaItem, nowMS: number, t: TFunc): string | null {
  if (item.last_refresh?.outcome !== 'failed') return null;
  const reason = item.last_refresh.error || item.error || t('quota.status_error');
  return t('quota.last_refresh_failed', {
    ago: formatObservedAgo(item.last_refresh.attempted_at_ms, nowMS, t),
    reason,
  });
}

/**
 * The line that explains a stale status no attempt explains: the reading announced a window
 * boundary that has since passed, so nobody has data about the cycle that began.
 */
export function outlivedResetLine(item: QuotaItem, t: TFunc): string | null {
  if (item.status !== 'stale' || item.last_refresh?.outcome === 'failed') return null;
  return t('quota.reading_outlived_reset');
}
