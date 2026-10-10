/*
 * The toast policy for a quota-refresh run, kept apart from the run itself.
 *
 * `quotaRefresh.ts` imports the typed API client, because running the refresh is what it does.
 * This policy is a pure function of a run's tally, and the OAuth workspace's logic suite asks it
 * what kind of toast a run earns without being able to load that client - so the answer cannot
 * live behind the transport.
 */

/** Quota refreshes answer under one key: a new run's outcome replaces the last run's report. */
export const QUOTA_REFRESH_TOAST_KEY = 'omc-quota-refresh';

/**
 * What kind of toast a quota-refresh outcome is.
 *
 * A run whose targets all answered - including one that skipped credentials which were never
 * eligible, since that is decided before the run rather than by it - is an acknowledgement that
 * leaves on its own. A failed or unknown target is a result to inspect: the toast becomes a report
 * that lists each target's reason and stays until it is closed.
 */
export function quotaRefreshOutcomeKind(
  report: { failed: number; unknown: number },
): 'acknowledgement' | 'report' {
  return report.failed > 0 || report.unknown > 0 ? 'report' : 'acknowledgement';
}
