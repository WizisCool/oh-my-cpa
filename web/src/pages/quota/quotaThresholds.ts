/**
 * The one remaining-share colour rule for credential quota.
 *
 * CPAMC's three buckets: plenty green, getting low yellow, nearly gone red. The Drawer's
 * bars and the list row's bars both read it, so one window cannot be amber in the row and
 * red in the Drawer.
 */
/** Below this share a window is nearly gone. */
export const QUOTA_LOW_PERCENT = 25;

export function quotaRemainingStroke(remainingPercent: number | null | undefined): string {
  if (remainingPercent == null) return 'var(--muted)';
  if (remainingPercent >= 70) return 'var(--success)';
  if (remainingPercent >= QUOTA_LOW_PERCENT) return 'var(--warn)';
  return 'var(--danger)';
}
