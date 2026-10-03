import type { SystemProductVersion } from '../../types/system';

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
