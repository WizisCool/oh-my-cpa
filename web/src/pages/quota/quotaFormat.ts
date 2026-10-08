import dayjs from '../../utils/time';
import type { TFunc } from '../../i18n';
import type { QuotaItem } from '../../types/quota';

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/**
 * Short absolute time used across the quota card, e.g. "09/30 01:05".
 * Numeric and locale-neutral on purpose so every language shares one layout.
 */
export function formatShortDateTime(ms: number): string {
  return Number.isFinite(ms) ? dayjs(ms).format('MM/DD HH:mm') : '--';
}

/** "GMT+8" style label for the effective OMC timezone (dynamically derived). */
export function formatGmtOffsetLabel(now: Date = new Date()): string {
  const totalMinutes = dayjs(now).utcOffset();
  const sign = totalMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(totalMinutes);
  return `GMT${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad2(abs % 60)}` : ''}`;
}

/**
 * Live countdown until `targetMS`, e.g. "in 4 hours" / "in 28 days".
 * Returns null once the target has passed (caller decides the expired copy).
 */
export function formatCountdown(targetMS: number, nowMS: number, t: TFunc): string | null {
  const diff = targetMS - nowMS;
  if (diff <= 0) return null;
  const totalMinutes = Math.ceil(diff / 60000);
  if (totalMinutes < 60) return t('quota.in_minutes', { n: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    const mins = totalMinutes % 60;
    return mins > 0 ? t('quota.in_hours_min', { h: hours, m: mins }) : t('quota.in_hours', { n: hours });
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? t('quota.in_days_min', { d: days, h: remH }) : t('quota.in_days', { n: days });
}

/**
 * Combined "09/30 01:05 · in 24 days" cell; falls back to the plain date when
 * no countdown applies (already expired / unknown target).
 */
export function formatTimeWithCountdown(targetMS: number, nowMS: number, t: TFunc): string {
  const date = formatShortDateTime(targetMS);
  const countdown = formatCountdown(targetMS, nowMS, t);
  return countdown ? `${date} · ${countdown}` : date;
}

/**
 * Renewal cell for a plan whose expiry came from the credential's id_token
 * rather than a live subscription read. Upstream only ever moves that window
 * forward, so the recorded instant is a lower bound of the real expiry: it is
 * marked "≥" with its provenance and never given a countdown, which would read
 * as a verified deadline.
 */
export function formatSnapshotRenewalBound(targetMS: number): string {
  return `≥ ${formatShortDateTime(targetMS)}`;
}

/** Relative "x minutes ago" for observation timestamps; the console's one relative-age reading. */
export { formatTimeAgo as formatObservedAgo } from '../../utils/format';

/** The share a window has left, clamped to 0-100, derived from usage when needed. */
export function quotaRemainingPercent(window: { remaining_percent?: number; used_percent?: number }): number | undefined {
  const remaining = window.remaining_percent ?? (window.used_percent != null ? 100 - window.used_percent : undefined);
  return remaining == null ? undefined : Math.round(Math.max(0, Math.min(100, remaining)));
}

/** The remaining share of a window, as the progress bar prints it. */
export function quotaRemainingText(window: { remaining_percent?: number; used_percent?: number }): string {
  const remaining = quotaRemainingPercent(window);
  return remaining == null ? '--' : `${remaining}%`;
}

/**
 * The marker a reset reading carries when upstream did not state the instant exactly.
 * One helper, so the row, the Drawer cell and the tooltip cannot disagree about it.
 */
export function resetAccuracyMarker(resetAccuracy?: string): string {
  return resetAccuracy && resetAccuracy !== 'exact' ? '~' : '';
}

/**
 * The short reset line under a list row's bar: the countdown alone, because the row has no
 * width for a date as well. The exact instant stays in the cell's tooltip.
 *
 * A derived or approximate instant keeps its `~` here too, and never turns into a bare
 * "recovered" claim once it passes: the row would otherwise assert a recovery that only an
 * exact upstream reset time can support. It falls back to what upstream itself stated.
 */
export function quotaResetCountdown(
  window: { reset_at_ms?: number; reset_label?: string; reset_accuracy?: string },
  nowMS: number,
  t: TFunc,
): string {
  const approximate = resetAccuracyMarker(window.reset_accuracy);
  if (!window.reset_at_ms) return window.reset_label ? `${approximate}${window.reset_label}` : '';
  const countdown = formatCountdown(window.reset_at_ms, nowMS, t);
  if (countdown) return `${approximate}${countdown}`;
  if (approximate) return window.reset_label ? `${approximate}${window.reset_label}` : '';
  return t('quota.recovered');
}

/** The message an empty window list carries, as the dictionary key that states it. */
export type QuotaEmptyStateKey =
  | 'quota.credential_disabled'
  | 'quota.no_live_probe'
  | 'quota.usage_not_published'
  | 'quota.not_observed_yet';

/**
 * Which message a credential with no window carries.
 *
 * The cases are exclusive and ordered by who owns the reason: a disabled credential is not read at
 * all, a provider without a live probe has nothing to read, and the last two are both readings that
 * happened — upstream answered and published no window, or nobody has read the credential yet.
 * Those two must not share copy, because one of them is worth repeating and the other already ran.
 */
export function quotaEmptyStateKey(
  item: Pick<QuotaItem, 'disabled' | 'capabilities' | 'status'>,
): QuotaEmptyStateKey {
  if (item.disabled) return 'quota.credential_disabled';
  if (item.capabilities?.refresh_supported === false) return 'quota.no_live_probe';
  if (item.status === 'unpublished') return 'quota.usage_not_published';
  return 'quota.not_observed_yet';
}

/**
 * The localized name of a window kind, falling back to whatever the provider labelled it.
 */
export function quotaWindowLabel(kind: string | undefined, label: string | undefined, t: TFunc): string {
  if (kind === 'five_hour') return t('quota.window_five_hour');
  if (kind === 'weekly') return t('quota.window_weekly');
  if (kind === 'daily') return t('quota.window_daily');
  if (kind === 'monthly') return t('quota.window_monthly');
  if (kind === 'credit_usage') return t('quota.window_credit_usage');
  return label || '';
}

/**
 * When a window resets, as "09/24 20:11 · 4 hours left". A derived or approximate instant
 * keeps its `~`, so a compact row cannot read as a verified deadline.
 */
export function quotaResetText(
  window: { reset_at_ms?: number; reset_label?: string; reset_accuracy?: string },
  nowMS: number,
  t: TFunc,
): string {
  const approximate = resetAccuracyMarker(window.reset_accuracy);
  if (window.reset_at_ms) return `${approximate}${formatTimeWithCountdown(window.reset_at_ms, nowMS, t)}`;
  return window.reset_label ? `${approximate}${window.reset_label}` : '';
}
