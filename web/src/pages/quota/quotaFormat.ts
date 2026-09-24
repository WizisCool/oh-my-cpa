import type { TFunc } from '../../i18n';

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/**
 * Short absolute time used across the quota card, e.g. "09/30 01:05".
 * Numeric and locale-neutral on purpose so every language shares one layout.
 */
export function formatShortDateTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--';
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "GMT+8" style label for the viewer's local timezone (dynamically derived). */
export function formatGmtOffsetLabel(now: Date = new Date()): string {
  const totalMinutes = -now.getTimezoneOffset();
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

/** Relative "x minutes ago" / "x hours ago" for observation timestamps. */
export function formatObservedAgo(ms: number, nowMS: number, t: TFunc): string {
  const diffSec = Math.floor((nowMS - ms) / 1000);
  if (diffSec < 60) return t('quota.just_now');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} ${t('quota.mins_ago')}`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} ${t('quota.hours_ago')}`;
  const diffDays = Math.floor(diffHours / 24);
  return t('quota.days_ago', { n: diffDays });
}

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
  const approximate = window.reset_accuracy && window.reset_accuracy !== 'exact' ? '~' : '';
  if (!window.reset_at_ms) return window.reset_label ? `${approximate}${window.reset_label}` : '';
  const countdown = formatCountdown(window.reset_at_ms, nowMS, t);
  if (countdown) return `${approximate}${countdown}`;
  if (approximate) return window.reset_label ? `${approximate}${window.reset_label}` : '';
  return t('quota.recovered');
}

/** The localized name of a window kind, falling back to whatever the provider labelled it. */
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
  const approximate = window.reset_accuracy && window.reset_accuracy !== 'exact' ? '~' : '';
  if (window.reset_at_ms) return `${approximate}${formatTimeWithCountdown(window.reset_at_ms, nowMS, t)}`;
  return window.reset_label ? `${approximate}${window.reset_label}` : '';
}
