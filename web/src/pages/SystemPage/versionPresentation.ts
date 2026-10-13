import type { ReleaseProduct, SystemProductVersion, SystemUpdaterResponse } from '../../types/system';

export function deriveVersionPresentation(version: SystemProductVersion, isChecking = false) {
  const hasChangelog = version.merge_count > 0;
  const shouldShowNotesNotice = hasChangelog && !version.notes_available && !version.check_error && !isChecking && !version.checking;
  const common = { hasChangelog, shouldShowNotesNotice };
  if (isChecking || version.checking) {
    return { ...common, statusKey: 'sys.checking_updates', tone: 'neutral' as const, detailKey: '' };
  }
  if (version.check_error) {
    return { ...common, statusKey: 'sys.check_failed', tone: 'warn' as const, detailKey: '' };
  }
  switch (version.state) {
    case 'update_available':
      return { ...common, statusKey: 'sys.update_ready', tone: 'accent' as const, detailKey: '' };
    case 'up_to_date':
      return { ...common, statusKey: 'sys.is_latest', tone: 'success' as const, detailKey: '' };
    case 'update_ahead':
      return { ...common, statusKey: 'sys.update_ahead', tone: 'neutral' as const, detailKey: '' };
    default: {
      const reasons = {
        running_version_not_comparable: 'sys.reason_running_not_comparable',
        newest_release_not_comparable: 'sys.reason_latest_not_comparable',
        no_releases_published: 'sys.reason_no_releases',
        not_checked_yet: 'sys.reason_not_checked',
      };
      const reasonKey = version.reason ? reasons[version.reason] : '';
      const isComparisonDetail = version.reason === 'running_version_not_comparable' || version.reason === 'newest_release_not_comparable';
      return {
        ...common,
        statusKey: isComparisonDetail ? 'sys.indeterminate' : reasonKey || 'sys.indeterminate',
        tone: 'neutral' as const,
        detailKey: isComparisonDetail ? reasonKey : '',
      };
    }
  }
}

export function summarizeUpdateCheck(versions: SystemProductVersion[], isCached: boolean) {
  const failedProducts = versions.filter((version) => version.check_error).map((version) => version.product);
  if (failedProducts.length > 0) {
    return { kind: failedProducts.length === versions.length ? 'failed' as const : 'partial' as const, failedProducts };
  }
  if (versions.some((version) => version.checking)) {
    return { kind: 'checking' as const, failedProducts };
  }
  return { kind: isCached ? 'cached' as const : 'success' as const, failedProducts };
}

export type UpdateOffer =
  | { kind: 'none' }
  /** `isBusy` is another product's update in flight: the action exists but must wait. */
  | { kind: 'available'; isBusy: boolean }
  | { kind: 'running'; stageKey: string }
  | { kind: 'blocked'; reasonKey: string; image: string };

const UPDATE_STAGE_KEYS: Record<string, string> = {
  pulling: 'sys.update_stage.pulling',
  stopping: 'sys.update_stage.stopping',
  starting: 'sys.update_stage.starting',
  verifying: 'sys.update_stage.verifying',
};

const UPDATE_BLOCK_KEYS: Record<string, string> = {
  pinned: 'sys.update_blocked.pinned',
  not_a_local_container: 'sys.update_blocked.not_a_local_container',
  signature_unavailable: 'sys.update_blocked.signature_unavailable',
};

/**
 * What the version card offers for one product.
 *
 * An update in flight is shown whatever the comparison says, because the comparison is about to
 * change under it. Otherwise nothing is offered unless a newer release is known: a block reason
 * on a product that is already current would be an explanation of an action nobody asked for.
 */
export function deriveUpdateOffer(
  version: SystemProductVersion,
  updater: SystemUpdaterResponse | undefined,
  product: ReleaseProduct,
): UpdateOffer {
  if (!updater || updater.state !== 'ready') return { kind: 'none' };
  const job = updater.job && !updater.job.finished ? updater.job : null;
  if (job?.product === product) {
    return { kind: 'running', stageKey: UPDATE_STAGE_KEYS[job.stage] ?? UPDATE_STAGE_KEYS.pulling };
  }
  if (version.state !== 'update_available') return { kind: 'none' };
  const entry = updater.products.find((candidate) => candidate.product === product);
  if (!entry) return { kind: 'none' };
  if (entry.action === 'available') return { kind: 'available', isBusy: job !== null };
  return { kind: 'blocked', reasonKey: UPDATE_BLOCK_KEYS[entry.reason] ?? 'sys.update_blocked.unidentified', image: entry.image };
}
