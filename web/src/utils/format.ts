import type { TFunc } from '../i18n';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count in the largest binary unit that keeps it at or above one.
 *
 * Two decimals below ten and one above keep the reading's width steady as a file grows. A missing
 * or unreadable count is an em dash rather than `0 B`: "nothing measured" is not "empty".
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  if (bytes < 0) return `-${formatBytes(-bytes)}`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 1 : 2)} ${BYTE_UNITS[exponent]}`;
}

/**
 * How long ago an instant was: "just now", minutes, hours, then days.
 *
 * Coarse on purpose - a list reads "3 hours ago" at a glance, and the exact instant belongs in
 * the tooltip beside it.
 */
export function formatTimeAgo(ms: number, nowMS: number, t: TFunc): string {
  const diffSec = Math.floor((nowMS - ms) / 1000);
  if (diffSec < 60) return t('quota.just_now');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} ${t('quota.mins_ago')}`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} ${t('quota.hours_ago')}`;
  return t('quota.days_ago', { n: Math.floor(diffHours / 24) });
}
